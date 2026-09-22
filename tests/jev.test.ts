import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/server/app.js';
import type { AppConfig } from '../src/shared/types.js';

void test('Jev encrypted credentials, typed API calls and sanitized failures', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-jev-'));
  const previous = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  const config: AppConfig = {
    dataDir: root,
    workspaceRoot: path.join(root, 'work'),
    port: 4317,
    host: '127.0.0.1',
    cliTimeoutMs: 1000,
    maxOutputBytes: 10000,
  };
  const secret = 'fixture-jev-secret-do-not-return';
  let mode = 'success';
  let called = 0;
  let captured: RequestInit | undefined;
  const fakeFetch: typeof fetch = (url, init) => {
    called++;
    assert.ok(init);
    captured = init;
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(init.redirect, 'error');
    assert.equal(
      new Headers(init.headers).get('authorization'),
      'Bearer ' + secret,
    );
    const rawBody = init.body;
    assert.ok(typeof rawBody === 'string');
    const body = JSON.parse(rawBody) as {
      questions: Record<
        string,
        { type: string; criteria?: Record<string, string> | string[] }
      >;
    };
    assert.ok(!JSON.stringify(body).includes(secret));
    if (mode === 'unauthorized')
      return Promise.resolve(
        new Response(JSON.stringify({ error: secret }), { status: 401 }),
      );
    if (mode === 'limited')
      return Promise.resolve(new Response(secret, { status: 429 }));
    if (mode === 'network') throw new Error(secret);
    if (mode === 'timeout') throw new DOMException(secret, 'TimeoutError');
    if (mode === 'oversized')
      return Promise.resolve(new Response('x'.repeat(270000)));
    if (mode === 'malformed')
      return Promise.resolve(
        new Response(
          JSON.stringify({
            model: 'jev-latest',
            answers: { wrong: { type: 'noul', noul: 1 } },
          }),
        ),
      );
    if (mode === 'invalid-number')
      return Promise.resolve(
        new Response(
          JSON.stringify({
            model: 'jev-latest',
            answers: { assessment: { type: 'noul', noul: 5 } },
          }),
        ),
      );
    const answers: Record<string, object> = {};
    for (const [id, q] of Object.entries(body.questions)) {
      if (q.type === 'noul') answers[id] = { type: 'noul', noul: 0.8, secret };
      else if (q.type === 'choice') {
        const criteria = q.criteria;
        assert.ok(criteria && !Array.isArray(criteria));
        const options = Object.keys(criteria);
        answers[id] = {
          type: 'choice',
          choice: options[0],
          confidence: 0.9,
          probabilities: Object.fromEntries(
            options.map((x, i) => [x, i === 0 ? 1 : 0]),
          ),
          secret,
        };
      } else
        answers[id] = {
          type: 'score',
          score: 1,
          confidence: 0.9,
          probabilities: { '0': 0, '1': 1, '2': 0 },
          legend: { '0': 'low', '1': 'medium', '2': 'high' },
          secret,
        };
    }
    return Promise.resolve(
      Response.json({
        model: 'jev-1.13.0',
        answers,
        usage: { input_tokens: 30, output_tokens: 5, secret },
        secret,
      }),
    );
  };
  let app = await createApp(config, {
    serveStatic: false,
    jevFetch: fakeFetch,
  });
  const request = (
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    url: string,
    payload?: object,
  ) => app.inject({ method, url, ...(payload ? { payload } : {}) });
  const evaluate = {
    state: 'The build failed.',
    model: 'jev-latest',
    questions: {
      assessment: { type: 'noul', instructions: 'Did the build fail?' },
    },
  };
  try {
    await t.test(
      'missing key fails locally; rejected keys are never echoed',
      async () => {
        assert.deepEqual((await request('GET', '/api/jev/settings')).json(), {
          configured: false,
          source: 'none',
        });
        assert.equal(
          (await request('POST', '/api/jev/evaluate', evaluate)).statusCode,
          409,
        );
        assert.equal(called, 0);
        const bad = await request('PUT', '/api/jev/settings', {
          apiKey: 'bad\n' + secret,
        });
        assert.equal(bad.statusCode, 400);
        assert.ok(!bad.body.includes(secret));
      },
    );
    await t.test(
      'saved credentials are encrypted, private and write-only',
      async () => {
        const saved = await request('PUT', '/api/jev/settings', {
          apiKey: secret,
        });
        assert.equal(saved.statusCode, 200);
        assert.deepEqual(saved.json(), { configured: true, source: 'saved' });
        assert.ok(!saved.body.includes(secret));
        const files = await readdir(path.join(root, 'secrets'));
        assert.ok(files.includes('jev.json'));
        assert.ok(
          !(
            await readFile(path.join(root, 'secrets/jev.json'), 'utf8')
          ).includes(secret),
        );
        assert.equal(
          (await readFile(path.join(root, 'secrets/master.key'))).length,
          32,
        );
        if (process.platform !== 'win32')
          assert.equal(
            (await stat(path.join(root, 'secrets/jev.json'))).mode & 0o777,
            0o600,
          );
      },
    );
    await t.test(
      'saved key survives app restart without being returned',
      async () => {
        await app.close();
        app = await createApp(config, {
          serveStatic: false,
          jevFetch: fakeFetch,
        });
        const status = await request('GET', '/api/jev/settings');
        assert.deepEqual(status.json(), { configured: true, source: 'saved' });
        assert.match(status.headers['cache-control'] ?? '', /no-store/);
      },
    );
    await t.test(
      'connection test uses harmless state and returns verified model',
      async () => {
        const response = await request('POST', '/api/jev/test', {});
        assert.equal(response.statusCode, 200, response.body);
        assert.deepEqual(response.json(), { ok: true, model: 'jev-1.13.0' });
        const capturedBody = captured?.body;
        assert.ok(typeof capturedBody === 'string');
        const capturedPayload = JSON.parse(capturedBody) as { state: string };
        assert.equal(capturedPayload.state, 'AgentLoom connection test.');
      },
    );
    await t.test(
      'all three question types return only validated fields',
      async () => {
        const payload = {
          ...evaluate,
          questions: {
            assessment: evaluate.questions.assessment,
            category: {
              type: 'choice',
              instructions: 'Choose category',
              criteria: { build: 'Build', other: 'Other' },
            },
            severity: {
              type: 'score',
              instructions: 'Rate severity',
              criteria: ['Low', 'Medium', 'High'],
            },
          },
        };
        const r = await request('POST', '/api/jev/evaluate', payload);
        assert.equal(r.statusCode, 200, r.body);
        const body = r.json<{
          answers: {
            category: { choice: string };
            severity: { score: number };
            assessment: { noul: number };
          };
        }>();
        assert.equal(body.answers.category.choice, 'build');
        assert.equal(body.answers.severity.score, 1);
        assert.equal(body.answers.assessment.noul, 0.8);
        assert.ok(!r.body.includes(secret));
        assert.ok(!r.body.includes('"secret"'));
      },
    );
    await t.test('invalid request shapes never call provider', async () => {
      const before = called;
      for (const payload of [
        { ...evaluate, unexpected: true },
        { ...evaluate, questions: {} },
        {
          ...evaluate,
          questions: {
            x: { type: 'choice', instructions: '?', criteria: { one: 'Only' } },
          },
        },
        {
          ...evaluate,
          questions: {
            x: { type: 'score', instructions: '?', criteria: ['Only'] },
          },
        },
        { ...evaluate, state: ' ' },
        { ...evaluate, model: 'https://evil.test' },
      ])
        assert.equal(
          (await request('POST', '/api/jev/evaluate', payload)).statusCode,
          400,
        );
      assert.equal(called, before);
    });
    await t.test(
      'upstream errors, malformed output and oversized output fail without secrets',
      async () => {
        for (const [value, expected] of [
          ['unauthorized', 502],
          ['limited', 429],
          ['network', 502],
          ['timeout', 504],
          ['oversized', 502],
          ['malformed', 502],
          ['invalid-number', 502],
        ] as const) {
          mode = value;
          const r = await request('POST', '/api/jev/evaluate', evaluate);
          assert.equal(r.statusCode, expected, value + ': ' + r.body);
          assert.ok(!r.body.includes(secret));
        }
        mode = 'success';
      },
    );
    await t.test(
      'corrupt saved credentials fail closed instead of using environment fallback',
      async () => {
        const filename = path.join(root, 'secrets/jev.json');
        const encrypted = await readFile(filename);
        process.env.TYPESAFE_API_KEY = secret;
        await writeFile(filename, 'corrupted');
        try {
          const r = await request('GET', '/api/jev/settings');
          assert.equal(r.statusCode, 500);
          assert.ok(!r.body.includes(secret));
          const before = called;
          assert.equal(
            (await request('POST', '/api/jev/evaluate', evaluate)).statusCode,
            500,
          );
          assert.equal(called, before);
        } finally {
          await writeFile(filename, encrypted);
          delete process.env.TYPESAFE_API_KEY;
        }
      },
    );
    await t.test(
      'remove key and environment fallback expose status only',
      async () => {
        process.env.TYPESAFE_API_KEY = secret;
        const r = await request('DELETE', '/api/jev/settings');
        assert.deepEqual(r.json(), { configured: true, source: 'environment' });
        await assert.rejects(readFile(path.join(root, 'secrets/jev.json')));
        delete process.env.TYPESAFE_API_KEY;
        assert.deepEqual((await request('GET', '/api/jev/settings')).json(), {
          configured: false,
          source: 'none',
        });
      },
    );
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
    await rm(root, { recursive: true, force: true });
  }
});
