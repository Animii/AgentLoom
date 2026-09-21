import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import test, { after, before, describe, it } from 'node:test';

import { verifyDraftMetadata } from '../scripts/verify-draft.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/verify-draft.mjs', import.meta.url));
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const OTHER_COMMIT = 'fedcba9876543210fedcba9876543210fedcba98';
const PR_URL = 'https://github.com/owner/repo/pull/123';
const GH_ARGS = ['pr', 'view', '123', '--repo', 'owner/repo', '--json', 'state,isDraft,headRefOid,url'];
const draft = (overrides = {}) => ({ state: 'OPEN', isDraft: true, headRefOid: COMMIT, url: PR_URL, ...overrides });

const FAKE_GH = `
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (process.env.FAKE_GH_ARGS) writeFileSync(process.env.FAKE_GH_ARGS, args.join('\\n'));
if (process.env.FAKE_GH_STDERR) process.stderr.write(process.env.FAKE_GH_STDERR);
if (process.env.FAKE_GH_DELAY_MS) await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_GH_DELAY_MS)));
if (process.env.FAKE_GH_STDOUT) process.stdout.write(process.env.FAKE_GH_STDOUT);
process.exitCode = Number(process.env.FAKE_GH_EXIT ?? '0');
`;

let fixtureRoot = '';
let invocation = 0;
const fakePath = () => `${path.join(fixtureRoot, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`;
const nextArgsFile = () => path.join(fixtureRoot, `args-${++invocation}.txt`);

before(async () => {
  fixtureRoot = await mkdtemp(path.join(tmpdir(), 'loom-verify-draft-'));
  const bin = path.join(fixtureRoot, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, 'fake-gh.mjs'), FAKE_GH);
  if (process.platform === 'win32') {
    await writeFile(path.join(bin, 'gh.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0fake-gh.mjs" %*\r\n`);
  } else {
    const launcher = path.join(bin, 'gh');
    await writeFile(launcher, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-gh.mjs" "$@"\n`);
    await chmod(launcher, 0o755);
  }
});

after(async () => {
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      {
        env: { ...process.env, PATH: fakePath(), ...env },
        shell: false,
        windowsHide: true,
        timeout: 20000,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
      },
    );
  });
}

describe('verifyDraftMetadata', () => {
  it('accepts an open draft at the expected commit', () => {
    assert.deepEqual(verifyDraftMetadata(draft(), COMMIT), { ok: true, issues: [], url: PR_URL });
  });

  it('rejects malformed expected commits with TypeError', () => {
    const cases = [undefined, null, 123, COMMIT.slice(0, 39), `${COMMIT}a`, COMMIT.toUpperCase(), 'g'.repeat(40)];
    for (const value of cases) {
      assert.throws(() => verifyDraftMetadata(draft(), value), TypeError, `expected commit ${JSON.stringify(value)}`);
    }
  });

  it('rejects malformed metadata with TypeError', () => {
    const cases = [
      undefined,
      null,
      42,
      'open',
      [],
      {},
      { isDraft: true, headRefOid: COMMIT, url: PR_URL },
      { state: 1, isDraft: true, headRefOid: COMMIT, url: PR_URL },
      { state: 'OPEN', isDraft: 'true', headRefOid: COMMIT, url: PR_URL },
      { state: 'OPEN', isDraft: true, headRefOid: 'abc', url: PR_URL },
      { state: 'OPEN', isDraft: true, headRefOid: COMMIT.toUpperCase(), url: PR_URL },
      { state: 'OPEN', isDraft: true, headRefOid: 'g'.repeat(40), url: PR_URL },
      { state: 'OPEN', isDraft: true, headRefOid: COMMIT, url: 123 },
      { state: 'OPEN', isDraft: true, headRefOid: COMMIT },
    ];
    for (const value of cases) {
      assert.throws(() => verifyDraftMetadata(value, COMMIT), TypeError, `metadata ${JSON.stringify(value)}`);
    }
  });

  it('reports each mismatch in issues', () => {
    const closed = verifyDraftMetadata(draft({ state: 'CLOSED' }), COMMIT);
    assert.equal(closed.ok, false);
    assert.equal(closed.issues.length, 1);
    assert.match(closed.issues[0], /state/);
    assert.equal(closed.url, PR_URL);

    const published = verifyDraftMetadata(draft({ isDraft: false }), COMMIT);
    assert.equal(published.ok, false);
    assert.equal(published.issues.length, 1);
    assert.match(published.issues[0], /isDraft/);

    const moved = verifyDraftMetadata(draft({ headRefOid: OTHER_COMMIT }), COMMIT);
    assert.equal(moved.ok, false);
    assert.equal(moved.issues.length, 1);
    assert.match(moved.issues[0], /headRefOid/);
    assert.ok(moved.issues[0].includes(OTHER_COMMIT));
    assert.ok(moved.issues[0].includes(COMMIT));
  });

  it('reports all mismatches together', () => {
    const result = verifyDraftMetadata(draft({ state: 'MERGED', isDraft: false, headRefOid: OTHER_COMMIT }), COMMIT);
    assert.equal(result.ok, false);
    assert.equal(result.issues.length, 3);
    assert.match(result.issues.join('\n'), /state/);
    assert.match(result.issues.join('\n'), /isDraft/);
    assert.match(result.issues.join('\n'), /headRefOid/);
    assert.equal(result.url, PR_URL);
  });
});

describe('verify-draft CLI', () => {
  it('verifies a matching draft with the exact read-only gh arguments', async () => {
    const argsFile = nextArgsFile();
    const result = await runCli(['owner/repo', '123', COMMIT], { FAKE_GH_ARGS: argsFile, FAKE_GH_STDOUT: JSON.stringify(draft()) });
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.trim().split('\n').length, 1);
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, issues: [], url: PR_URL });
    assert.equal(await readFile(argsFile, 'utf8'), GH_ARGS.join('\n'));
  });

  it('exits 1 with JSON issues for each mismatch', async () => {
    const cases = [
      { overrides: { state: 'CLOSED' }, pattern: /state/ },
      { overrides: { state: 'MERGED' }, pattern: /state/ },
      { overrides: { isDraft: false }, pattern: /isDraft/ },
      { overrides: { headRefOid: OTHER_COMMIT }, pattern: /headRefOid/ },
    ];
    for (const { overrides, pattern } of cases) {
      const argsFile = nextArgsFile();
      const result = await runCli(['owner/repo', '123', COMMIT], { FAKE_GH_ARGS: argsFile, FAKE_GH_STDOUT: JSON.stringify(draft(overrides)) });
      assert.equal(result.code, 1, `exit code for ${JSON.stringify(overrides)}`);
      assert.equal(result.stderr, '');
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.url, PR_URL);
      assert.ok(parsed.issues.some((issue) => pattern.test(issue)), `issue for ${JSON.stringify(overrides)}`);
      assert.equal(await readFile(argsFile, 'utf8'), GH_ARGS.join('\n'));
    }
  });

  it('reports every mismatch instead of stopping at the first', async () => {
    const result = await runCli(['owner/repo', '123', COMMIT], {
      FAKE_GH_STDOUT: JSON.stringify(draft({ state: 'CLOSED', isDraft: false, headRefOid: OTHER_COMMIT })),
    });
    assert.equal(result.code, 1);
    assert.equal(result.stderr, '');
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.issues.length, 3);
  });

  it('exits 1 with concise stderr when gh returns malformed JSON', async () => {
    const result = await runCli(['owner/repo', '123', COMMIT], { FAKE_GH_STDOUT: 'not json at all' });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.notEqual(result.stderr.trim(), '');
    assert.ok(!result.stderr.includes('not json'));
  });

  it('exits 1 with concise stderr when metadata has an unexpected shape', async () => {
    const result = await runCli(['owner/repo', '123', COMMIT], { FAKE_GH_STDOUT: JSON.stringify({ ...draft(), isDraft: 'yes' }) });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /isDraft/);
  });

  it('exits 1 without leaking gh output or credentials when gh fails', async () => {
    const secret = 'ghp_example_secret_value';
    const result = await runCli(['owner/repo', '123', COMMIT], {
      FAKE_GH_EXIT: '1',
      FAKE_GH_STDOUT: 'raw gh stdout',
      FAKE_GH_STDERR: `token ${secret}`,
    });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.ok(!result.stderr.includes(secret));
    assert.ok(!result.stderr.includes('raw gh stdout'));
  });

  it('exits 1 when gh is unavailable', async () => {
    const emptyBin = path.join(fixtureRoot, 'empty-bin');
    await mkdir(emptyBin, { recursive: true });
    const result = await runCli(['owner/repo', '123', COMMIT], { PATH: emptyBin });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.notEqual(result.stderr.trim(), '');
  });

  it('exits 2 on stderr only and never launches gh for invalid arguments', async () => {
    const cases = [
      [],
      ['owner/repo'],
      ['owner/repo', '123'],
      ['owner/repo', '123', COMMIT, 'extra'],
      ['owner', '123', COMMIT],
      ['owner/repo/extra', '123', COMMIT],
      ['own er/repo', '123', COMMIT],
      ['', '123', COMMIT],
      ['owner/repo', '0', COMMIT],
      ['owner/repo', '-1', COMMIT],
      ['owner/repo', '1.5', COMMIT],
      ['owner/repo', 'abc', COMMIT],
      ['owner/repo', '007', COMMIT],
      ['owner/repo', '123', COMMIT.slice(0, 39)],
      ['owner/repo', '123', `${COMMIT}a`],
      ['owner/repo', '123', COMMIT.toUpperCase()],
    ];
    for (const args of cases) {
      const argsFile = nextArgsFile();
      const result = await runCli(args, { FAKE_GH_ARGS: argsFile, FAKE_GH_STDOUT: JSON.stringify(draft()) });
      assert.equal(result.code, 2, `exit code for ${JSON.stringify(args)}`);
      assert.equal(result.stdout, '');
      assert.notEqual(result.stderr.trim(), '');
      assert.equal(existsSync(argsFile), false, `gh invoked for ${JSON.stringify(args)}`);
    }
  });

  it('imports without side effects or gh execution', async () => {
    const argsFile = nextArgsFile();
    const result = await new Promise((resolve) => {
      execFile(
        process.execPath,
        ['--input-type=module', '--eval', 'await import(process.env.VERIFY_DRAFT_MODULE)'],
        {
          env: {
            ...process.env,
            PATH: fakePath(),
            VERIFY_DRAFT_MODULE: pathToFileURL(SCRIPT).href,
            FAKE_GH_ARGS: argsFile,
            FAKE_GH_STDOUT: JSON.stringify(draft()),
          },
          shell: false,
          windowsHide: true,
          timeout: 20000,
        },
        (error, stdout, stderr) => {
          resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
        },
      );
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.equal(existsSync(argsFile), false);
  });
});
