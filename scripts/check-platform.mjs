import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DEFAULT_URL = 'http://127.0.0.1:4317';
const DEFAULT_TIMEOUT_MS = 3000;
const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 60000;
const HEALTH_PATH = '/api/health';
const USAGE = `Usage: node scripts/check-platform.mjs [--url URL] [--timeout-ms MS]
Defaults: --url ${DEFAULT_URL} --timeout-ms ${DEFAULT_TIMEOUT_MS}`;

class UsageError extends Error {}

function validateBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || baseUrl === '' || baseUrl !== baseUrl.trim()) {
    throw new TypeError('baseUrl must be a non-empty http(s) origin URL string');
  }
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError('baseUrl must be a valid http(s) origin URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('baseUrl must use the http or https protocol');
  }
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('baseUrl must not include credentials');
  }
  if (url.pathname !== '/') {
    throw new TypeError('baseUrl must not include a path');
  }
  if (url.href !== `${url.origin}/`) {
    throw new TypeError('baseUrl must not include a query or fragment');
  }
  return url.origin;
}

function validateTimeoutMs(timeoutMs) {
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError(`timeoutMs must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
  }
  return timeoutMs;
}

function timeoutError(timeoutMs) {
  return { ok: false, error: `Request timed out after ${timeoutMs}ms` };
}

function isTimeoutError(error) {
  return error instanceof Error && error.name === 'TimeoutError';
}

function failureFor(error, timeoutMs) {
  if (isTimeoutError(error)) return timeoutError(timeoutMs);
  const code = error?.cause?.code ?? error?.code;
  return { ok: false, error: typeof code === 'string' ? `Network request failed (${code})` : 'Network request failed' };
}

export async function checkPlatform(baseUrl, options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be an object');
  }
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
  const origin = validateBaseUrl(baseUrl);
  validateTimeoutMs(timeoutMs);
  let response;
  try {
    response = await fetch(new URL(HEALTH_PATH, origin), {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
  } catch (error) {
    return failureFor(error, timeoutMs);
  }
  if (response.status >= 300 && response.status < 400) {
    return { ok: false, error: `Redirects are not followed (HTTP ${response.status})` };
  }
  if (response.status !== 200) {
    return { ok: false, error: `Unexpected HTTP status ${response.status}` };
  }
  let text;
  try {
    text = await response.text();
  } catch (error) {
    return failureFor(error, timeoutMs);
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Response body was not valid JSON' };
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload) || payload.ok !== true) {
    return { ok: false, error: 'Response body did not contain {ok:true}' };
  }
  return { ok: true };
}

function parseTimeoutMs(value) {
  if (!/^[0-9]+$/.test(value)) {
    throw new UsageError(`--timeout-ms must be a decimal integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
  }
  const timeoutMs = Number(value);
  if (timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new UsageError(`--timeout-ms must be a decimal integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
  }
  return timeoutMs;
}

function describeUnknownArgument(argument) {
  if (typeof argument === 'string' && /^--?[A-Za-z0-9][A-Za-z0-9-]*$/.test(argument)) {
    return `Unknown argument: ${argument}`;
  }
  return 'Unknown argument';
}

function parseArgs(argv) {
  const options = { url: DEFAULT_URL, timeoutMs: DEFAULT_TIMEOUT_MS };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== '--url' && flag !== '--timeout-ms') {
      throw new UsageError(describeUnknownArgument(flag));
    }
    if (seen.has(flag)) {
      throw new UsageError(`Repeated argument: ${flag}`);
    }
    seen.add(flag);
    const value = argv[index + 1];
    if (value === undefined) {
      throw new UsageError(`Missing value for ${flag}`);
    }
    index += 1;
    if (flag === '--url') {
      options.url = value;
    } else {
      options.timeoutMs = parseTimeoutMs(value);
    }
  }
  return options;
}

function reportUsageError(message) {
  process.stderr.write(`${message}\n${USAGE}\n`);
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      reportUsageError(error.message);
      return 2;
    }
    throw error;
  }
  let result;
  try {
    result = await checkPlatform(options.url, { timeoutMs: options.timeoutMs });
  } catch (error) {
    if (error instanceof TypeError) {
      reportUsageError(error.message);
      return 2;
    }
    throw error;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.ok ? 0 : 1;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exitCode = await main(process.argv.slice(2));
}
