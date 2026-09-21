import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const BASELINE_PATTERN = /^[0-9a-f]{64}$/;
const CHANGE_LISTS = ['added', 'modified', 'deleted'];
const USAGE = 'Usage: node scripts/summarize-changes.mjs RUN_JSON_FILE';

export function summarizeChanges(run) {
  if (run === null || typeof run !== 'object' || !Array.isArray(run.steps)) {
    throw new TypeError('run.steps must be an array');
  }

  let changes;
  for (let index = run.steps.length - 1; index >= 0; index -= 1) {
    const step = run.steps[index];
    if (step === null || typeof step !== 'object') continue;
    const council = step.council;
    if (council === null || typeof council !== 'object') continue;
    if (council.changes !== undefined) {
      changes = council.changes;
      break;
    }
  }

  if (changes === undefined) return null;
  if (changes === null || typeof changes !== 'object' || Array.isArray(changes)) {
    throw new TypeError('council.changes must be an object when present');
  }

  const baseline = changes.baseline;
  if (typeof baseline !== 'string' || baseline.length !== 64 || !BASELINE_PATTERN.test(baseline)) {
    throw new TypeError('changes.baseline must be exactly 64 lowercase hexadecimal characters');
  }

  const seen = new Set();
  const summary = {baseline, added: [], modified: [], deleted: [], total: 0};
  for (const name of CHANGE_LISTS) {
    const list = changes[name];
    if (!Array.isArray(list)) {
      throw new TypeError(`changes.${name} must be an array of nonempty strings`);
    }
    const paths = [];
    for (const value of list) {
      if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`changes.${name} must contain only nonempty strings`);
      }
      if (seen.has(value)) throw new TypeError('changes must not contain duplicate paths');
      seen.add(value);
      paths.push(value);
    }
    paths.sort();
    summary[name] = paths;
    summary.total += paths.length;
  }

  return summary;
}

function printError(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function runCli(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    printError('Unable to read the input file');
    return;
  }

  let run;
  try {
    run = JSON.parse(raw);
  } catch {
    printError('Input file does not contain valid JSON');
    return;
  }

  let summary;
  try {
    summary = summarizeChanges(run);
  } catch (error) {
    printError(error instanceof TypeError ? error.message : 'Unable to summarize the input run');
    return;
  }

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
  } else {
    runCli(args[0]);
  }
}
