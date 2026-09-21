import {createHash} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const USAGE = 'usage: node scripts/check-evidence-hash.mjs FILE EXPECTED_SHA256';

export async function checkEvidenceHash(file, expectedHash) {
  if (typeof file !== 'string' || file.length === 0) {
    throw new TypeError('file must be a nonempty string');
  }
  if (typeof expectedHash !== 'string' || !HASH_PATTERN.test(expectedHash)) {
    throw new TypeError('expectedHash must be exactly 64 lowercase hexadecimal characters');
  }
  const bytes = await readFile(file);
  const actual = createHash('sha256').update(bytes).digest('hex');
  return {ok: actual === expectedHash, expected: expectedHash, actual, bytes: bytes.length};
}

function isMainModule() {
  if (typeof process.argv[1] !== 'string') return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  const [file, expectedHash] = args;
  try {
    const result = await checkEvidenceHash(file, expectedHash);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    if (error instanceof TypeError) {
      process.stderr.write(`invalid argument: ${error.message}\n${USAGE}\n`);
      process.exitCode = 2;
      return;
    }
    const detail = typeof error?.code === 'string' ? error.code : error?.name ?? 'unreadable';
    process.stderr.write(`error: cannot read ${JSON.stringify(file)}: ${detail}\n`);
    process.exitCode = 1;
  }
}

if (isMainModule()) {
  await main();
}
