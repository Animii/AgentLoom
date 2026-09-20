import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../shared/types.js';

const UPSTREAM_URL = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_MODEL = 'jev-latest';
const UPSTREAM_TIMEOUT_MS = 30000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_CONCURRENT_REQUESTS = 4;
const MASTER_KEY_BYTES = 32;
const SECRETS_DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_API_KEY_LENGTH = 4096;
const QUESTION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/;
const MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const WHITESPACE_OR_CONTROL = /[\s\u0000-\u001f\u007f]/;

const ERROR_INVALID_KEY = 'Invalid API key';
const ERROR_INVALID_REQUEST = 'Invalid Jev request';
const ERROR_INVALID_RESPONSE = 'Jev returned an invalid response.';
const ERROR_KEY_REJECTED = 'Jev rejected the API key. Check your TypeSafe credentials.';
const ERROR_RATE_LIMIT = 'Jev rate limit reached. Try again later.';
const ERROR_UPSTREAM = 'Jev request failed';
const ERROR_TIMEOUT = 'Jev request timed out';
const ERROR_MISSING_KEY = 'Jev API key is not configured';
const ERROR_SERVER = 'Internal server error';

const TEST_STATE = 'AgentLoom connection test.';
const TEST_QUESTIONS = {
  connection: { type: 'noul' as const, instructions: 'Does the state mention AgentLoom?' },
};

const trimmedString = z.string().transform((value) => value.trim());

const nonBlankString = (max: number) =>
  trimmedString.pipe(z.string().min(1).max(max, `must be at most ${max} characters`));

const apiKeyBodySchema = z.strictObject({
  apiKey: trimmedString.pipe(
    z
      .string()
      .min(1, 'must not be empty')
      .max(MAX_API_KEY_LENGTH, `must be at most ${MAX_API_KEY_LENGTH} characters`)
      .refine((value) => !WHITESPACE_OR_CONTROL.test(value), 'must not contain whitespace or control characters'),
  ),
});

const questionIdSchema = z.string().regex(QUESTION_ID_PATTERN, 'must match /^[a-zA-Z0-9_-]{1,80}$/');

const criterionKeySchema = z
  .string()
  .min(1, 'must not be empty')
  .max(80, 'must be at most 80 characters')
  .refine((value) => value.trim().length > 0, 'must not be blank');

const noulQuestionSchema = z.strictObject({
  type: z.literal('noul'),
  instructions: nonBlankString(4000),
});

const choiceQuestionSchema = z.strictObject({
  type: z.literal('choice'),
  instructions: nonBlankString(4000),
  criteria: z
    .record(criterionKeySchema, nonBlankString(1000))
    .refine((value) => Object.keys(value).length >= 2 && Object.keys(value).length <= 255, {
      message: 'must have between 2 and 255 criteria',
    }),
});

const scoreQuestionSchema = z.strictObject({
  type: z.literal('score'),
  instructions: nonBlankString(4000),
  criteria: z.array(nonBlankString(1000)).min(2, 'must have at least 2 criteria').max(10, 'must have at most 10 criteria'),
});

const questionSchema = z.discriminatedUnion('type', [
  noulQuestionSchema,
  choiceQuestionSchema,
  scoreQuestionSchema,
]);

const evaluateBodySchema = z.strictObject({
  state: trimmedString.pipe(
    z.string().min(1, 'must not be empty').max(30000, 'must be at most 30000 characters'),
  ),
  model: trimmedString
    .pipe(z.string().max(120, 'must be at most 120 characters').regex(MODEL_PATTERN, 'has an invalid format'))
    .default(DEFAULT_MODEL),
  questions: z.record(questionIdSchema, questionSchema).superRefine((value, ctx) => {
    const count = Object.keys(value).length;
    if (count < 1 || count > 16) {
      ctx.addIssue({ code: 'custom', message: 'must have between 1 and 16 questions' });
    }
  }),
});

const testBodySchema = z.strictObject({});

type Question = z.infer<typeof questionSchema>;

interface ExpectedQuestion {
  readonly type: 'noul' | 'choice' | 'score';
  readonly criteria: readonly string[];
}

type ProjectedAnswer =
  | { readonly type: 'noul'; readonly noul: number }
  | {
      readonly type: 'choice';
      readonly choice: string;
      readonly confidence: number;
      readonly probabilities: Record<string, number>;
    }
  | {
      readonly type: 'score';
      readonly score: number;
      readonly confidence: number;
      readonly probabilities: Record<string, number>;
      readonly legend?: Record<string, string>;
    };

interface JevSuccess {
  readonly model: string;
  readonly answers: Record<string, ProjectedAnswer>;
  readonly usage?: { readonly input_tokens: number; readonly output_tokens: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnitNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function projectProbabilities(value: unknown, keys: readonly string[]): Record<string, number> | null {
  if (!isRecord(value) || Object.keys(value).length !== keys.length) {
    return null;
  }
  const projected: Record<string, number> = {};
  for (const key of keys) {
    const probability = value[key];
    if (!isUnitNumber(probability)) {
      return null;
    }
    projected[key] = probability;
  }
  return projected;
}

function projectAnswer(raw: unknown, expected: ExpectedQuestion): ProjectedAnswer | null {
  if (!isRecord(raw) || raw.type !== expected.type) {
    return null;
  }
  if (expected.type === 'noul') {
    if (!isUnitNumber(raw.noul)) {
      return null;
    }
    return { type: 'noul', noul: raw.noul };
  }
  if (expected.type === 'choice') {
    if (typeof raw.choice !== 'string' || !expected.criteria.includes(raw.choice)) {
      return null;
    }
    if (!isUnitNumber(raw.confidence)) {
      return null;
    }
    const probabilities = projectProbabilities(raw.probabilities, expected.criteria);
    if (probabilities === null) {
      return null;
    }
    return { type: 'choice', choice: raw.choice, confidence: raw.confidence, probabilities };
  }
  const maximumScore = expected.criteria.length - 1;
  if (typeof raw.score !== 'number' || !Number.isFinite(raw.score) || raw.score < 0 || raw.score > maximumScore) {
    return null;
  }
  if (!isUnitNumber(raw.confidence)) {
    return null;
  }
  const probabilities = projectProbabilities(
    raw.probabilities,
    expected.criteria.map((_criterion, index) => String(index)),
  );
  if (probabilities === null) {
    return null;
  }
  const answer = { type: 'score' as const, score: raw.score, confidence: raw.confidence, probabilities };
  if (!('legend' in raw)) {
    return answer;
  }
  if (!isRecord(raw.legend)) {
    return null;
  }
  const legend: Record<string, string> = {};
  for (const [key, description] of Object.entries(raw.legend)) {
    if (typeof description !== 'string' || !/^(0|[1-9]\d*)$/.test(key)) {
      return null;
    }
    const index = Number(key);
    if (index >= expected.criteria.length) {
      return null;
    }
    legend[key] = expected.criteria[index];
  }
  return { ...answer, legend };
}

function projectUsage(value: unknown): JevSuccess['usage'] {
  if (!isRecord(value)) {
    return undefined;
  }
  const inputTokens = value.input_tokens;
  const outputTokens = value.output_tokens;
  if (typeof inputTokens !== 'number' || !Number.isInteger(inputTokens) || inputTokens < 0) {
    return undefined;
  }
  if (typeof outputTokens !== 'number' || !Number.isInteger(outputTokens) || outputTokens < 0) {
    return undefined;
  }
  return { input_tokens: inputTokens, output_tokens: outputTokens };
}

function projectResponse(
  raw: unknown,
  expected: ReadonlyMap<string, ExpectedQuestion>,
  apiKey: string,
): JevSuccess | null {
  if (!isRecord(raw)) {
    return null;
  }
  const model = raw.model;
  if (typeof model !== 'string' || model.length === 0 || model.length > 120 || model.includes(apiKey)) {
    return null;
  }
  if (!isRecord(raw.answers) || Object.keys(raw.answers).length !== expected.size) {
    return null;
  }
  const answers: Record<string, ProjectedAnswer> = {};
  for (const [id, expectedQuestion] of expected) {
    if (!Object.prototype.hasOwnProperty.call(raw.answers, id)) {
      return null;
    }
    const answer = projectAnswer(raw.answers[id], expectedQuestion);
    if (answer === null) {
      return null;
    }
    answers[id] = answer;
  }
  const usage = projectUsage(raw.usage);
  return usage === undefined ? { model, answers } : { model, answers, usage };
}

function expectedQuestions(questions: Record<string, Question>): Map<string, ExpectedQuestion> {
  const expected = new Map<string, ExpectedQuestion>();
  for (const [id, question] of Object.entries(questions)) {
    if (question.type === 'choice') {
      expected.set(id, { type: 'choice', criteria: Object.keys(question.criteria) });
    } else if (question.type === 'score') {
      expected.set(id, { type: 'score', criteria: [...question.criteria] });
    } else {
      expected.set(id, { type: 'noul', criteria: [] });
    }
  }
  return expected;
}

interface StoragePaths {
  readonly secretsDir: string;
  readonly masterPath: string;
  readonly credentialsPath: string;
}

function storagePaths(config: AppConfig): StoragePaths {
  const secretsDir = join(config.dataDir, 'secrets');
  return {
    secretsDir,
    masterPath: join(secretsDir, 'master.key'),
    credentialsPath: join(secretsDir, 'jev.json'),
  };
}

function readMasterKey(paths: StoragePaths): Buffer {
  mkdirSync(paths.secretsDir, { recursive: true, mode: SECRETS_DIR_MODE });
  if (!existsSync(paths.masterPath)) {
    const generated = randomBytes(MASTER_KEY_BYTES);
    try {
      writeFileSync(paths.masterPath, generated, { flag: 'wx', mode: FILE_MODE });
      return generated;
    } catch {
      const existing = readFileSync(paths.masterPath);
      if (existing.length !== MASTER_KEY_BYTES) {
        throw new Error('Invalid master key');
      }
      return existing;
    }
  }
  const masterKey = readFileSync(paths.masterPath);
  if (masterKey.length !== MASTER_KEY_BYTES) {
    throw new Error('Invalid master key');
  }
  return masterKey;
}

function encryptApiKey(apiKey: string, masterKey: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  const data = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  return JSON.stringify({
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  });
}

function decryptApiKey(payload: string, masterKey: Buffer): string {
  const parsed: unknown = JSON.parse(payload);
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    typeof parsed.iv !== 'string' ||
    typeof parsed.tag !== 'string' ||
    typeof parsed.data !== 'string'
  ) {
    throw new Error('Invalid credentials file');
  }
  const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(parsed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(parsed.data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  return plaintext;
}

function isValidApiKey(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length >= 1 &&
    trimmed.length <= MAX_API_KEY_LENGTH &&
    !WHITESPACE_OR_CONTROL.test(trimmed)
  );
}

function loadSavedApiKey(paths: StoragePaths): string | null {
  if (!existsSync(paths.credentialsPath)) {
    return null;
  }
  const apiKey = decryptApiKey(readFileSync(paths.credentialsPath, 'utf8'), readMasterKey(paths));
  if (!isValidApiKey(apiKey)) {
    throw new Error('Invalid credentials file');
  }
  return apiKey.trim();
}

function saveApiKey(paths: StoragePaths, apiKey: string): void {
  const masterKey = readMasterKey(paths);
  const tmpPath = join(paths.secretsDir, `.jev-${randomUUID()}.tmp`);
  try {
    writeFileSync(tmpPath, encryptApiKey(apiKey, masterKey), { flag: 'wx', mode: FILE_MODE });
    renameSync(tmpPath, paths.credentialsPath);
  } catch (error) {
    try {
      if (existsSync(tmpPath)) {
        unlinkSync(tmpPath);
      }
    } catch {
      // Ignore cleanup failures.
    }
    throw error;
  }
}

function deleteSavedApiKey(paths: StoragePaths): void {
  if (existsSync(paths.credentialsPath)) {
    unlinkSync(paths.credentialsPath);
  }
}

interface Credential {
  readonly apiKey: string | null;
  readonly source: 'saved' | 'environment' | 'none';
}

function resolveCredential(paths: StoragePaths): Credential {
  const saved = loadSavedApiKey(paths);
  if (saved !== null) {
    return { apiKey: saved, source: 'saved' };
  }
  const environment = process.env.TYPESAFE_API_KEY;
  if (typeof environment === 'string' && isValidApiKey(environment)) {
    return { apiKey: environment.trim(), source: 'environment' };
  }
  return { apiKey: null, source: 'none' };
}

interface UpstreamOutcome {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly statusCode?: number;
  readonly message?: string;
}

interface UpstreamPayload {
  readonly state: string;
  readonly model: string;
  readonly questions: unknown;
}

async function readBodyWithCap(response: Response): Promise<string> {
  const body = response.body;
  if (body === null) {
    return '';
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value === undefined) {
      continue;
    }
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error('Response exceeds size cap');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Ignore cancellation failures.
  }
}

function isTimeoutError(error: unknown): boolean {
  return isRecord(error) && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

async function callJev(fetchImpl: typeof fetch, apiKey: string, payload: UpstreamPayload): Promise<UpstreamOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(UPSTREAM_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      return { ok: false, statusCode: 504, message: ERROR_TIMEOUT };
    }
    return { ok: false, statusCode: 502, message: ERROR_UPSTREAM };
  }
  if (response.status === 401 || response.status === 403) {
    await discardBody(response);
    return { ok: false, statusCode: 502, message: ERROR_KEY_REJECTED };
  }
  if (response.status === 429) {
    await discardBody(response);
    return { ok: false, statusCode: 429, message: ERROR_RATE_LIMIT };
  }
  if (!response.ok) {
    await discardBody(response);
    return { ok: false, statusCode: 502, message: ERROR_UPSTREAM };
  }
  let text: string;
  try {
    text = await readBodyWithCap(response);
  } catch {
    return { ok: false, statusCode: 502, message: ERROR_INVALID_RESPONSE };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, statusCode: 502, message: ERROR_INVALID_RESPONSE };
  }
  return { ok: true, value };
}

export function registerJev(app: FastifyInstance, config: AppConfig, fetchImpl: typeof fetch = fetch): (input: unknown) => Promise<JevSuccess> {
  const storage = storagePaths(config);
  let activeRequests = 0;

  const fail = (reply: FastifyReply, statusCode: number, message: string): FastifyReply => {
    reply.header('cache-control', 'no-store');
    return reply.code(statusCode).send({ error: message });
  };

  app.get('/api/jev/settings', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    try {
      const credential = resolveCredential(storage);
      return { configured: credential.apiKey !== null, source: credential.source };
    } catch {
      return fail(reply, 500, ERROR_SERVER);
    }
  });

  app.put('/api/jev/settings', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const parsed = apiKeyBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(reply, 400, ERROR_INVALID_KEY);
    }
    try {
      saveApiKey(storage, parsed.data.apiKey);
      const credential = resolveCredential(storage);
      return { configured: credential.apiKey !== null, source: credential.source };
    } catch {
      return fail(reply, 500, ERROR_SERVER);
    }
  });

  app.delete('/api/jev/settings', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    try {
      deleteSavedApiKey(storage);
      const credential = resolveCredential(storage);
      return { configured: credential.apiKey !== null, source: credential.source };
    } catch {
      return fail(reply, 500, ERROR_SERVER);
    }
  });

  app.post('/api/jev/test', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const parsed = testBodySchema.safeParse(request.body === undefined ? {} : request.body);
    if (!parsed.success) {
      return fail(reply, 400, ERROR_INVALID_REQUEST);
    }
    let credential: Credential;
    try {
      credential = resolveCredential(storage);
    } catch {
      return fail(reply, 500, ERROR_SERVER);
    }
    if (credential.apiKey === null) {
      return fail(reply, 409, ERROR_MISSING_KEY);
    }
    if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
      return fail(reply, 429, ERROR_RATE_LIMIT);
    }
    activeRequests += 1;
    try {
      const expected = new Map<string, ExpectedQuestion>([['connection', { type: 'noul', criteria: [] }]]);
      const outcome = await callJev(fetchImpl, credential.apiKey, {
        state: TEST_STATE,
        model: DEFAULT_MODEL,
        questions: TEST_QUESTIONS,
      });
      if (!outcome.ok) {
        return fail(reply, outcome.statusCode ?? 502, outcome.message ?? ERROR_UPSTREAM);
      }
      const projected = projectResponse(outcome.value, expected, credential.apiKey);
      if (projected === null) {
        return fail(reply, 502, ERROR_INVALID_RESPONSE);
      }
      return { ok: true, model: projected.model };
    } finally {
      activeRequests -= 1;
    }
  });

  app.post('/api/jev/evaluate', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const parsed = evaluateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(reply, 400, ERROR_INVALID_REQUEST);
    }
    let credential: Credential;
    try {
      credential = resolveCredential(storage);
    } catch {
      return fail(reply, 500, ERROR_SERVER);
    }
    if (credential.apiKey === null) {
      return fail(reply, 409, ERROR_MISSING_KEY);
    }
    if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
      return fail(reply, 429, ERROR_RATE_LIMIT);
    }
    activeRequests += 1;
    try {
      const expected = expectedQuestions(parsed.data.questions);
      const outcome = await callJev(fetchImpl, credential.apiKey, {
        state: parsed.data.state,
        model: parsed.data.model,
        questions: parsed.data.questions,
      });
      if (!outcome.ok) {
        return fail(reply, outcome.statusCode ?? 502, outcome.message ?? ERROR_UPSTREAM);
      }
      const projected = projectResponse(outcome.value, expected, credential.apiKey);
      if (projected === null) {
        return fail(reply, 502, ERROR_INVALID_RESPONSE);
      }
      return projected;
    } finally {
      activeRequests -= 1;
    }
  });
  return async (input: unknown): Promise<JevSuccess> => {
    const parsed = evaluateBodySchema.safeParse(input);
    if (!parsed.success) throw new Error(ERROR_INVALID_REQUEST);
    let credential: Credential;
    try { credential = resolveCredential(storage); } catch { throw new Error(ERROR_SERVER); }
    if (!credential.apiKey) throw new Error(ERROR_MISSING_KEY);
    if (activeRequests >= MAX_CONCURRENT_REQUESTS) throw new Error(ERROR_RATE_LIMIT);
    activeRequests++;
    try {
      const outcome = await callJev(fetchImpl, credential.apiKey, parsed.data);
      if (!outcome.ok) throw new Error(outcome.message ?? ERROR_UPSTREAM);
      const projected = projectResponse(outcome.value, expectedQuestions(parsed.data.questions), credential.apiKey);
      if (!projected) throw new Error(ERROR_INVALID_RESPONSE);
      return projected;
    } finally { activeRequests--; }
  };

}
