import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {access, chmod, constants, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {checkEvidenceHash} from '../scripts/check-evidence-hash.mjs';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL('../scripts/check-evidence-hash.mjs', import.meta.url));
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const BINARY = Buffer.from([0x00, 0x01, 0x02, 0x7f, 0x80, 0xfe, 0xff, 0x0d, 0x0a, 0x00, 0xc3, 0x28, 0xff]);
const CRLF_TEXT = Buffer.from('alpha\r\nbeta\r\n', 'utf8');
const LF_TEXT = Buffer.from('alpha\nbeta\n', 'utf8');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const paths = {};
let dir;
let spacedDir;
let unreadableIsDenied = false;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'check-evidence-hash-'));
  spacedDir = path.join(dir, 'evidence packet');
  await mkdir(spacedDir);
  paths.empty = path.join(dir, 'empty.bin');
  paths.abc = path.join(dir, 'abc.txt');
  paths.binary = path.join(spacedDir, 'binary data.bin');
  paths.crlf = path.join(spacedDir, 'crlf lines.txt');
  paths.unreadable = path.join(dir, 'unreadable.txt');
  paths.missing = path.join(dir, 'missing file.json');
  await writeFile(paths.empty, Buffer.alloc(0));
  await writeFile(paths.abc, 'abc');
  await writeFile(paths.binary, BINARY);
  await writeFile(paths.crlf, CRLF_TEXT);
  await writeFile(paths.unreadable, 'top secret contents');
  await chmod(paths.unreadable, 0o000);
  unreadableIsDenied = await access(paths.unreadable, constants.R_OK).then(() => false, () => true);
});

after(async () => {
  await chmod(paths.unreadable, 0o600).catch(() => {});
  await rm(dir, {recursive: true, force: true});
});

async function runCli(args) {
  try {
    const {stdout, stderr} = await execFileAsync(process.execPath, [scriptPath, ...args], {cwd: repoRoot, encoding: 'utf8'});
    return {status: 0, stdout, stderr};
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return {status: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? ''};
  }
}

test('returns exactly {ok, expected, actual, bytes} for known abc bytes', async () => {
  const result = await checkEvidenceHash(paths.abc, ABC_SHA256);
  assert.deepEqual(result, {ok: true, expected: ABC_SHA256, actual: ABC_SHA256, bytes: 3});
  assert.deepEqual(Object.keys(result), ['ok', 'expected', 'actual', 'bytes']);
});

test('hashes an empty file to the known empty SHA-256 with zero bytes', async () => {
  const result = await checkEvidenceHash(paths.empty, EMPTY_SHA256);
  assert.deepEqual(result, {ok: true, expected: EMPTY_SHA256, actual: EMPTY_SHA256, bytes: 0});
});

test('reports ok false without throwing when the digest differs', async () => {
  const result = await checkEvidenceHash(paths.abc, EMPTY_SHA256);
  assert.equal(result.ok, false);
  assert.equal(result.expected, EMPTY_SHA256);
  assert.equal(result.actual, ABC_SHA256);
  assert.equal(result.bytes, 3);
});

test('hashes arbitrary binary bytes exactly and counts them', async () => {
  const result = await checkEvidenceHash(paths.binary, sha256(BINARY));
  assert.equal(result.ok, true);
  assert.equal(result.actual, sha256(BINARY));
  assert.equal(result.bytes, BINARY.length);
  assert.equal((await checkEvidenceHash(paths.binary, sha256(Buffer.from('nope')))).ok, false);
});

test('treats CRLF and LF bytes as different content', async () => {
  const crlf = await checkEvidenceHash(paths.crlf, sha256(CRLF_TEXT));
  const lf = await checkEvidenceHash(paths.crlf, sha256(LF_TEXT));
  assert.equal(crlf.ok, true);
  assert.equal(lf.ok, false);
  assert.equal(crlf.bytes, CRLF_TEXT.length);
});

test('rejects invalid file arguments with TypeError before reading', async () => {
  const badFiles = [undefined, null, '', 42, {}, ['x'], Buffer.from('x'), new String(paths.abc)];
  for (const file of badFiles) {
    await assert.rejects(checkEvidenceHash(file, EMPTY_SHA256), TypeError);
  }
});

test('rejects invalid expectedHash values with TypeError before touching the filesystem', async () => {
  const badHashes = [undefined, null, '', 42, 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), EMPTY_SHA256.toUpperCase(), `${EMPTY_SHA256}\n`];
  for (const expectedHash of badHashes) {
    await assert.rejects(checkEvidenceHash(paths.missing, expectedHash), TypeError);
  }
});

test('rejects naturally for a missing path', async () => {
  await assert.rejects(checkEvidenceHash(paths.missing, EMPTY_SHA256), (error) => {
    assert.equal(error instanceof TypeError, false);
    assert.equal(error.code, 'ENOENT');
    return true;
  });
});

test('rejects naturally for an unreadable file', async (t) => {
  await assert.rejects(checkEvidenceHash(spacedDir, EMPTY_SHA256), (error) => error.code === 'EISDIR' || error.code === 'EACCES');
  if (!unreadableIsDenied) {
    t.skip('permission checks are bypassed for this user');
    return;
  }
  await assert.rejects(checkEvidenceHash(paths.unreadable, sha256(Buffer.from('top secret contents'))), (error) => error.code === 'EACCES');
});

test('CLI prints one JSON line and exits 0 on a match', async () => {
  const out = await runCli([paths.abc, ABC_SHA256]);
  assert.equal(out.status, 0);
  assert.equal(out.stderr, '');
  assert.equal(out.stdout.endsWith('\n'), true);
  assert.equal(out.stdout.trimEnd().includes('\n'), false);
  assert.deepEqual(JSON.parse(out.stdout), {ok: true, expected: ABC_SHA256, actual: ABC_SHA256, bytes: 3});
});

test('CLI exits 1 and prints one JSON line on a mismatch', async () => {
  const out = await runCli([paths.abc, EMPTY_SHA256]);
  assert.equal(out.status, 1);
  assert.equal(out.stderr, '');
  assert.deepEqual(JSON.parse(out.stdout), {ok: false, expected: EMPTY_SHA256, actual: ABC_SHA256, bytes: 3});
});

test('CLI handles files and directories whose paths contain spaces', async () => {
  const binary = await runCli([paths.binary, sha256(BINARY)]);
  assert.equal(binary.status, 0);
  assert.deepEqual(JSON.parse(binary.stdout), {ok: true, expected: sha256(BINARY), actual: sha256(BINARY), bytes: BINARY.length});
  const empty = await runCli([paths.empty, EMPTY_SHA256]);
  assert.equal(empty.status, 0);
  assert.equal(JSON.parse(empty.stdout).bytes, 0);
});

test('CLI exits 1 with concise stderr only for read failures', async () => {
  const missing = await runCli([paths.missing, EMPTY_SHA256]);
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
  assert.equal(missing.stderr.trimEnd().split('\n').length, 1);
  assert.match(missing.stderr, /ENOENT/);
  assert.doesNotMatch(missing.stderr, / at /);
  assert.doesNotMatch(missing.stderr, /top secret/);
  const directory = await runCli([spacedDir, EMPTY_SHA256]);
  assert.equal(directory.status, 1);
  assert.equal(directory.stdout, '');
  assert.match(directory.stderr, /EISDIR|EACCES/);
});

test('CLI exits 2 with stderr only for missing, extra or invalid arguments', async () => {
  const cases = [[], [paths.abc], [paths.abc, ABC_SHA256, 'extra'], [paths.abc, 'ABC'], [paths.abc, 'A'.repeat(64)], ['', ABC_SHA256]];
  for (const args of cases) {
    const out = await runCli(args);
    assert.equal(out.status, 2);
    assert.equal(out.stdout, '');
    assert.match(out.stderr, /usage: node scripts\/check-evidence-hash\.mjs FILE EXPECTED_SHA256/);
  }
});

test('CLI validates arguments before reading the file', async () => {
  const out = await runCli([paths.missing, 'A'.repeat(64)]);
  assert.equal(out.status, 2);
  assert.equal(out.stdout, '');
  assert.doesNotMatch(out.stderr, /ENOENT/);
  assert.match(out.stderr, /usage:/);
});

test('importing the module has no side effects', async () => {
  const moduleUrl = pathToFileURL(scriptPath).href;
  const {stdout, stderr} = await execFileAsync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(moduleUrl)});`], {cwd: repoRoot, encoding: 'utf8'});
  assert.equal(stdout, '');
  assert.equal(stderr, '');
});
