import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkPlatform } from '../scripts/check-platform.mjs';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL('../scripts/check-platform.mjs', import.meta.url));

async function startServer(handler, port = 0) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function jsonHandler(payload, status = 200) {
  return (request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  };
}

async function runCli(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('checkPlatform reports ok for HTTP 200 with ok:true and extra fields', async () => {
  const requests = [];
  const server = await startServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, version: '0.1.0' }));
  });
  try {
    assert.deepEqual(await checkPlatform(server.url), { ok: true });
  } finally {
    await server.close();
  }
  assert.deepEqual(requests, [{ method: 'GET', url: '/api/health' }]);
});

test('checkPlatform reports failure for non-200 responses', async () => {
  const server = await startServer(jsonHandler({ ok: true }, 500));
  try {
    assert.deepEqual(await checkPlatform(server.url), { ok: false, error: 'Unexpected HTTP status 500' });
  } finally {
    await server.close();
  }
});

test('checkPlatform reports failure when the health payload is not {ok:true}', async () => {
  for (const payload of [{ ok: false }, {}, { ok: 'true' }, { healthy: true }, [1, 2], JSON.stringify('ok'), null]) {
    const server = await startServer(jsonHandler(payload));
    try {
      const result = await checkPlatform(server.url);
      assert.equal(result.ok, false, `payload: ${JSON.stringify(payload)}`);
      assert.match(result.error, /ok:true/);
    } finally {
      await server.close();
    }
  }
});

test('checkPlatform reports malformed JSON without leaking the response body', async () => {
  const secret = 'super-secret-body-value';
  const server = await startServer(jsonHandler(`{"ok":true, ${secret}`));
  try {
    const result = await checkPlatform(server.url);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Response body was not valid JSON');
    assert.doesNotMatch(result.error, new RegExp(secret));
  } finally {
    await server.close();
  }
});

test('checkPlatform reports connection failures', async () => {
  const server = await startServer(jsonHandler({ ok: true }));
  const url = server.url;
  await server.close();
  const result = await checkPlatform(url, { timeoutMs: 1000 });
  assert.equal(result.ok, false);
  assert.match(result.error, /Network request failed/);
});

test('checkPlatform times out stalled responses', async () => {
  const server = await startServer(() => {});
  try {
    const result = await checkPlatform(server.url, { timeoutMs: 100 });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Request timed out after 100ms');
  } finally {
    await server.close();
  }
});

test('checkPlatform rejects redirects without contacting the target', async () => {
  let targetRequests = 0;
  const target = await startServer((request, response) => {
    targetRequests += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });
  const redirect = await startServer((request, response) => {
    response.writeHead(302, { location: `${target.url}/api/health` });
    response.end();
  });
  try {
    const result = await checkPlatform(redirect.url, { timeoutMs: 1000 });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Redirects are not followed (HTTP 302)');
    assert.equal(targetRequests, 0);
  } finally {
    await Promise.all([redirect.close(), target.close()]);
  }
});

test('checkPlatform rejects invalid arguments with TypeError before any network use', async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error('fetch must not be called for invalid arguments');
  };
  try {
    const invalidUrls = ['', '   ', 'not a url', 'ftp://127.0.0.1', 'ws://127.0.0.1', 'http://user:pass@127.0.0.1:1', 'http://127.0.0.1:1/path', 'http://127.0.0.1:1?query=1', 'http://127.0.0.1:1#fragment', 'http://127.0.0.1:1?', 'http://127.0.0.1:1#', 'http://127.0.0.1:1/?', 'http://127.0.0.1:1/#', 'http://127.0.0.1:1/api/health', 42, null, undefined, {}];
    for (const value of invalidUrls) {
      await assert.rejects(checkPlatform(value), TypeError, `url: ${String(value)}`);
    }
    const invalidOptions = [null, [], 'options', { timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: 60001 }, { timeoutMs: 1.5 }, { timeoutMs: Number.NaN }, { timeoutMs: Number.POSITIVE_INFINITY }, { timeoutMs: '3000' }];
    for (const options of invalidOptions) {
      await assert.rejects(checkPlatform('http://127.0.0.1:1', options), TypeError, `options: ${JSON.stringify(options)}`);
    }
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('checkPlatform accepts the timeout boundaries 1 and 60000 and trailing-slash origins', async () => {
  const originalFetch = globalThis.fetch;
  const signals = [];
  globalThis.fetch = async (url, options) => {
    signals.push(options.signal);
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    assert.deepEqual(await checkPlatform('http://127.0.0.1:1', { timeoutMs: 1 }), { ok: true });
    assert.deepEqual(await checkPlatform('http://127.0.0.1:1/', { timeoutMs: 60000 }), { ok: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(signals.length, 2);
  for (const signal of signals) assert.ok(signal instanceof AbortSignal);
});

test('checkPlatform sends GET /api/health with manual redirects and the 3000ms default timeout', async () => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  const timeouts = [];
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  AbortSignal.timeout = function timeout(ms) {
    timeouts.push(ms);
    return originalTimeout.call(AbortSignal, ms);
  };
  try {
    assert.deepEqual(await checkPlatform('http://127.0.0.1:4317'), { ok: true });
  } finally {
    AbortSignal.timeout = originalTimeout;
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(timeouts, [3000]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://127.0.0.1:4317/api/health');
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].options.redirect, 'manual');
  assert.ok(requests[0].options.signal instanceof AbortSignal);
});

test('CLI prints one JSON object and exits 0 for a healthy platform', async () => {
  const server = await startServer(jsonHandler({ ok: true, version: '0.1.0' }));
  try {
    const result = await runCli(['--url', server.url, '--timeout-ms', '1000']);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '{"ok":true}\n');
    assert.equal(result.stderr, '');
  } finally {
    await server.close();
  }
});

test('CLI prints one JSON object and exits 1 for unhealthy or unreachable platforms', async () => {
  const unhealthy = await startServer(jsonHandler({ ok: false }, 200));
  const unreachable = await startServer(jsonHandler({ ok: true }));
  const unreachableUrl = unreachable.url;
  await unreachable.close();
  try {
    const unhealthyResult = await runCli(['--url', unhealthy.url]);
    assert.equal(unhealthyResult.code, 1);
    assert.equal(unhealthyResult.stderr, '');
    assert.equal(unhealthyResult.stdout.endsWith('\n'), true);
    assert.deepEqual(JSON.parse(unhealthyResult.stdout), { ok: false, error: 'Response body did not contain {ok:true}' });

    const unreachableResult = await runCli(['--url', unreachableUrl, '--timeout-ms', '1000']);
    assert.equal(unreachableResult.code, 1);
    assert.equal(unreachableResult.stderr, '');
    const unreachableJson = JSON.parse(unreachableResult.stdout);
    assert.deepEqual(Object.keys(unreachableJson).sort(), ['error', 'ok']);
    assert.equal(unreachableJson.ok, false);
    assert.equal(typeof unreachableJson.error, 'string');
  } finally {
    await unhealthy.close();
  }
});

test('CLI exits 2 with stderr only for usage errors', async () => {
  let serverRequests = 0;
  const server = await startServer((request, response) => {
    serverRequests += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });
  const cases = [
    ['--bogus'],
    ['http://127.0.0.1:1'],
    ['--url'],
    ['--url=http://user:pass@127.0.0.1:1'],
    ['--timeout-ms'],
    ['--url', server.url, '--url', server.url],
    ['--timeout-ms', '100', '--timeout-ms', '200'],
    ['--url', `${server.url}/api/health`],
    ['--url', 'ftp://127.0.0.1'],
    ['--url', 'http://user:pass@127.0.0.1:1'],
    ['--url', 'http://127.0.0.1:1?'],
    ['--url', 'http://127.0.0.1:1#'],
    ['--url', `${server.url}?query=1`],
    ['--url', `${server.url}#fragment`],
    ['--url', `${server.url}?`],
    ['--url', `${server.url}#`],
    ['--timeout-ms', '0'],
    ['--timeout-ms', '60001'],
    ['--timeout-ms', '1.5'],
    ['--timeout-ms', 'abc'],
    ['--timeout-ms', '-5'],
  ];
  try {
    for (const args of cases) {
      const result = await runCli(args);
      const label = args.join(' ');
      assert.equal(result.code, 2, `args: ${label}`);
      assert.equal(result.stdout, '', `args: ${label}`);
      assert.match(result.stderr, /Usage:/, `args: ${label}`);
      assert.match(result.stderr, /http:\/\/127\.0\.0\.1:4317/, `args: ${label}`);
    }
    assert.equal(serverRequests, 0);
  } finally {
    await server.close();
  }
});

test('CLI usage errors never echo credentials from arguments', async () => {
  const password = 'sample-password';
  const credentialUrl = `http://alice:${password}@127.0.0.1:4317`;
  const cases = [
    ['--url', credentialUrl],
    [`--url=${credentialUrl}`],
    [credentialUrl],
    [`--bogus=${credentialUrl}`],
    ['--url', `alice:${password}@127.0.0.1:4317`],
  ];
  for (const args of cases) {
    const result = await runCli(args);
    const label = args.join(' ');
    assert.equal(result.code, 2, `args: ${label}`);
    assert.equal(result.stdout, '', `args: ${label}`);
    assert.match(result.stderr, /Usage:/, `args: ${label}`);
    assert.doesNotMatch(result.stderr, new RegExp(password), `args: ${label}`);
    assert.doesNotMatch(result.stderr, /alice/, `args: ${label}`);
  }
  const unknownFlag = await runCli(['--bogus']);
  assert.equal(unknownFlag.code, 2);
  assert.equal(unknownFlag.stdout, '');
  assert.match(unknownFlag.stderr, /Unknown argument: --bogus/);
});

test('CLI defaults to http://127.0.0.1:4317 when no flags are provided', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'check-platform-cli-'));
  const captureFile = path.join(directory, 'requested-url.txt');
  const loader = `globalThis.fetch = async (url) => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(process.env.CAPTURE_FILE, String(url));
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  };`;
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--import', `data:text/javascript,${encodeURIComponent(loader)}`, scriptPath],
      { encoding: 'utf8', env: { ...process.env, CAPTURE_FILE: captureFile } },
    );
    assert.equal(stdout, '{"ok":true}\n');
    assert.equal(stderr, '');
    assert.equal(await readFile(captureFile, 'utf8'), 'http://127.0.0.1:4317/api/health');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('importing the module has no side effects', async () => {
  assert.equal(typeof checkPlatform, 'function');
  const moduleUrl = pathToFileURL(scriptPath).href;
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(moduleUrl)});`],
    { encoding: 'utf8' },
  );
  assert.equal(stdout, '');
  assert.equal(stderr, '');
});
