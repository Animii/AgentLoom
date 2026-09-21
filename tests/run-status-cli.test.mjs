import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { summarizeRun } from '../scripts/run-status.mjs';

const CLI_PATH = fileURLToPath(new URL('../scripts/run-status.mjs', import.meta.url));

function sampleRun(overrides = {}) {
  return {
    id: 'run-1',
    title: 'Demo run',
    status: 'failed',
    currentStep: 1,
    steps: [{ definition: { name: 'Plan' } }, { definition: { name: 'Implement' } }],
    automation: { status: 'active' },
    git: { prUrl: 'https://example.test/pr/1' },
    ...overrides,
  };
}

function runNode(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { ...options, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function runCli(args, options = {}) {
  return runNode([CLI_PATH, ...args], options);
}

async function startServer(handler) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    handler(request, response);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

function sendJson(body, status = 200) {
  return (request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
}

test('summarizeRun resolves the current step name', () => {
  assert.deepEqual(summarizeRun(sampleRun()), {
    id: 'run-1',
    title: 'Demo run',
    status: 'failed',
    step: 'Implement',
    automation: 'active',
    prUrl: 'https://example.test/pr/1',
  });
});

test('summarizeRun returns exactly the documented keys in order', () => {
  const summary = summarizeRun(sampleRun());
  assert.deepEqual(Object.keys(summary), ['id', 'title', 'status', 'step', 'automation', 'prUrl']);
});

test('summarizeRun returns a null step when currentStep is out of range or absent', () => {
  assert.equal(summarizeRun(sampleRun({ currentStep: 2 })).step, null);
  assert.equal(summarizeRun(sampleRun({ currentStep: 500 })).step, null);
  assert.equal(summarizeRun(sampleRun({ currentStep: 0, steps: [] })).step, null);
});

test('summarizeRun returns null for missing optional automation and git data', () => {
  const summary = summarizeRun(sampleRun({ automation: undefined, git: undefined }));
  assert.equal(summary.automation, null);
  assert.equal(summary.prUrl, null);
});

test('summarizeRun returns null for optional containers without their nested value', () => {
  const summary = summarizeRun(sampleRun({ automation: {}, git: {} }));
  assert.equal(summary.automation, null);
  assert.equal(summary.prUrl, null);
});

test('summarizeRun accepts null optional containers', () => {
  const summary = summarizeRun(sampleRun({ automation: null, git: null }));
  assert.equal(summary.automation, null);
  assert.equal(summary.prUrl, null);
});

test('summarizeRun rejects malformed required fields with TypeError', () => {
  for (const run of [
    null,
    undefined,
    'run',
    42,
    [],
    {},
    sampleRun({ id: 1 }),
    sampleRun({ title: null }),
    sampleRun({ status: ['running'] }),
    sampleRun({ steps: 'steps' }),
    sampleRun({ currentStep: -1 }),
    sampleRun({ currentStep: 1.5 }),
    sampleRun({ currentStep: '1' }),
    sampleRun({ currentStep: undefined }),
  ]) {
    assert.throws(() => summarizeRun(run), TypeError);
  }
});

test('summarizeRun rejects malformed optional nested fields with TypeError', () => {
  assert.throws(() => summarizeRun(sampleRun({ automation: 'active' })), TypeError);
  assert.throws(() => summarizeRun(sampleRun({ automation: [] })), TypeError);
  assert.throws(() => summarizeRun(sampleRun({ automation: { status: 7 } })), TypeError);
  assert.throws(() => summarizeRun(sampleRun({ git: 'branch' })), TypeError);
  assert.throws(() => summarizeRun(sampleRun({ git: [] })), TypeError);
  assert.throws(() => summarizeRun(sampleRun({ git: { prUrl: 9 } })), TypeError);
});

test('summarizeRun rejects malformed in-range step entries with TypeError', () => {
  assert.throws(() => summarizeRun(sampleRun({ currentStep: 0, steps: [null] })), TypeError);
  assert.throws(() => summarizeRun(sampleRun({ currentStep: 0, steps: ['Plan'] })), TypeError);
  assert.throws(() => summarizeRun(sampleRun({ currentStep: 0, steps: [{}] })), TypeError);
  assert.throws(() => summarizeRun(sampleRun({ currentStep: 0, steps: [{ definition: null }] })), TypeError);
  assert.throws(() => summarizeRun(sampleRun({ currentStep: 0, steps: [{ definition: {} }] })), TypeError);
  assert.throws(() => summarizeRun(sampleRun({ currentStep: 0, steps: [{ definition: { name: 4 } }] })), TypeError);
});

test('importing the module has no side effects and exports summarizeRun', async () => {
  const script = `import { summarizeRun } from ${JSON.stringify(pathToFileURL(CLI_PATH).href)}; if (typeof summarizeRun !== 'function') process.exit(3);`;
  const result = await runNode(['--input-type=module', '--eval', script]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('CLI prints the labelled text summary and exits 0 for a failed run', async () => {
  const server = await startServer(sendJson(sampleRun()));
  try {
    const result = await runCli(['run-1', '--url', server.origin]);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.equal(
      result.stdout,
      [
        'ID: run-1',
        'Title: Demo run',
        'Status: failed',
        'Step: Implement',
        'Automation: active',
        'PR: https://example.test/pr/1',
        '',
      ].join('\n'),
    );
    assert.deepEqual(server.requests, [{ method: 'GET', url: '/api/runs/run-1' }]);
  } finally {
    await server.close();
  }
});

test('CLI prints dashes for missing values and accepts a trailing-slash origin', async () => {
  const run = sampleRun({
    id: 'run-2',
    title: 'Quiet run',
    status: 'completed',
    currentStep: 4,
    automation: undefined,
    git: undefined,
  });
  const server = await startServer(sendJson(run));
  try {
    const result = await runCli(['--url', `${server.origin}/`, 'run-2']);
    assert.equal(result.code, 0);
    assert.equal(
      result.stdout,
      ['ID: run-2', 'Title: Quiet run', 'Status: completed', 'Step: -', 'Automation: -', 'PR: -', ''].join('\n'),
    );
  } finally {
    await server.close();
  }
});

test('CLI --json prints a single JSON object', async () => {
  const server = await startServer(sendJson(sampleRun()));
  try {
    const result = await runCli(['--json', 'run-1', '--url', server.origin]);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.trimEnd().split('\n').length, 1);
    assert.deepEqual(JSON.parse(result.stdout), {
      id: 'run-1',
      title: 'Demo run',
      status: 'failed',
      step: 'Implement',
      automation: 'active',
      prUrl: 'https://example.test/pr/1',
    });
  } finally {
    await server.close();
  }
});

test('CLI reports HTTP failures without leaking the server body', async () => {
  const secret = 'super-secret-server-body';
  const server = await startServer(sendJson({ error: secret }, 404));
  try {
    const result = await runCli(['run-1', '--url', server.origin]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /HTTP 404/);
    assert.ok(!result.stderr.includes(secret));
  } finally {
    await server.close();
  }
});

test('CLI rejects invalid JSON without leaking the server body', async () => {
  const server = await startServer(sendJson(`not-json super-secret-body`));
  try {
    const result = await runCli(['run-1', '--url', server.origin]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /valid JSON/);
    assert.ok(!result.stderr.includes('super-secret-body'));
  } finally {
    await server.close();
  }
});

test('CLI rejects invalid response shapes without leaking unused fields', async () => {
  const server = await startServer(
    sendJson({
      id: 'run-1',
      title: 'Demo run',
      status: 'running',
      currentStep: 0,
      steps: 'super-secret-marker',
    }),
  );
  try {
    const result = await runCli(['run-1', '--url', server.origin]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /run\.steps must be an array/);
    assert.ok(!result.stderr.includes('super-secret-marker'));
  } finally {
    await server.close();
  }
});

test('CLI refuses to follow redirects', async () => {
  const server = await startServer((request, response) => {
    response.writeHead(302, { location: '/api/runs/other' });
    response.end('redirect body');
  });
  try {
    const result = await runCli(['run-1', '--url', server.origin]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /redirect/);
    assert.deepEqual(server.requests, [{ method: 'GET', url: '/api/runs/run-1' }]);
  } finally {
    await server.close();
  }
});

test('CLI reports network failures', async () => {
  const server = await startServer(sendJson(sampleRun()));
  const origin = server.origin;
  await server.close();
  const result = await runCli(['run-1', '--url', origin]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /request failed/);
});

test('CLI aborts a request that exceeds the 3000ms timeout', async () => {
  const server = await startServer(() => {});
  try {
    const result = await runCli(['run-1', '--url', server.origin]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /timed out after 3000ms/);
  } finally {
    await server.close();
  }
});

test('CLI accepts an 80 character run id and rejects usage errors', async () => {
  const longestId = 'a'.repeat(80);
  const server = await startServer(sendJson({ error: 'missing' }, 404));
  try {
    const accepted = await runCli([longestId, '--url', server.origin]);
    assert.equal(accepted.code, 1);
    assert.match(accepted.stderr, /HTTP 404/);
  } finally {
    await server.close();
  }

  const usageCases = [
    [],
    ['bad/id'],
    ['-leading-dash'],
    ['a'.repeat(81)],
    ['run-1', 'run-2'],
    ['run-1', '--json', '--json'],
    ['run-1', '--url', 'http://127.0.0.1:1', '--url', 'http://127.0.0.1:1'],
    ['run-1', '--url'],
    ['run-1', '--verbose'],
    ['run-1', '--url=http://127.0.0.1:1'],
    ['run-1', '--url', 'not a url'],
    ['run-1', '--url', 'ftp://127.0.0.1:1'],
    ['run-1', '--url', 'http://user:pass@127.0.0.1:1'],
    ['run-1', '--url', 'http://127.0.0.1:1/path'],
    ['run-1', '--url', 'http://127.0.0.1:1/?query=1'],
    ['run-1', '--url', 'http://127.0.0.1:1/#fragment'],
    ['run-1', '--url', 'http://127.0.0.1:1/?'],
    ['run-1', '--url', 'http://127.0.0.1:1/#'],
    ['run-1', '--url', 'http://127.0.0.1:1/ignored/..'],
    ['run-1', '--url', 'http://127.0.0.1:1/%2e'],
    ['run-1', '--url', 'http://127.0.0.1:1/%2e%2e'],
    ['run-1', '--url', 'http://127.0.0.1:1/./'],
    ['run-1', '--url', 'http://127.0.0.1:1//'],
    ['run-1', '--url', 'http://127.0.0.1:1\\..'],
    ['run-1', '--url', 'http://127.0.0.1:1 '],
  ];
  for (const args of usageCases) {
    const result = await runCli(args);
    assert.equal(result.code, 2, `expected exit 2 for: ${JSON.stringify(args)}`);
    assert.equal(result.stdout, '', `expected no stdout for: ${JSON.stringify(args)}`);
    assert.match(result.stderr, /usage: node scripts\/run-status\.mjs RUN_ID/, `expected usage for: ${JSON.stringify(args)}`);
  }
});

test('CLI usage errors never echo supplied credentials', async () => {
  const secret = 'synthetic-secret-9f3c';
  const credentialUrls = [
    `http://review-user:${secret}@127.0.0.1:1`,
    `http://review-user:${secret}@127.0.0.1:invalid`,
  ];
  for (const url of credentialUrls) {
    const result = await runCli(['run-1', '--url', url]);
    assert.equal(result.code, 2, `expected exit 2 for ${url}`);
    assert.equal(result.stdout, '');
    assert.ok(!result.stderr.includes(secret), `stderr leaked the password for ${url}`);
    assert.ok(!result.stderr.includes('review-user'), `stderr leaked the username for ${url}`);
  }

  const idResult = await runCli([`http://review-user:${secret}@127.0.0.1:1`]);
  assert.equal(idResult.code, 2);
  assert.equal(idResult.stdout, '');
  assert.ok(!idResult.stderr.includes(secret), 'stderr leaked an invalid RUN_ID credential');
  assert.ok(!idResult.stderr.includes('review-user'), 'stderr leaked an invalid RUN_ID credential');
});
