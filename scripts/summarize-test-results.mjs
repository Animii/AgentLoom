import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const USAGE = 'usage: node scripts/summarize-test-results.mjs RUN_JSON_FILE';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value) {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (typeof value[index] !== 'string') return false;
  }
  return true;
}

export function summarizeTestResults(run) {
  if (!isPlainObject(run)) throw new TypeError('run must be an object');
  if (typeof run.id !== 'string') throw new TypeError('run.id must be a string');
  if (!Array.isArray(run.steps)) throw new TypeError('run.steps must be an array');
  const checks = [];
  for (let stepIndex = 0; stepIndex < run.steps.length; stepIndex += 1) {
    const step = run.steps[stepIndex];
    if (!isPlainObject(step)) throw new TypeError(`run.steps[${stepIndex}] must be an object`);
    if (step.validation === undefined) continue;
    if (!isPlainObject(step.validation)) throw new TypeError(`run.steps[${stepIndex}].validation must be an object`);
    const validation = step.validation;
    if (!isPlainObject(step.definition) || typeof step.definition.id !== 'string') throw new TypeError(`run.steps[${stepIndex}].definition.id must be a string`);
    if (typeof validation.status !== 'string') throw new TypeError(`run.steps[${stepIndex}].validation.status must be a string`);
    if (typeof validation.before !== 'string') throw new TypeError(`run.steps[${stepIndex}].validation.before must be a string`);
    if (validation.after !== undefined && typeof validation.after !== 'string') throw new TypeError(`run.steps[${stepIndex}].validation.after must be a string or undefined`);
    if (!Array.isArray(validation.commands)) throw new TypeError(`run.steps[${stepIndex}].validation.commands must be an array`);
    const sourceUnchanged = typeof validation.after === 'string' && validation.after === validation.before;
    for (let commandIndex = 0; commandIndex < validation.commands.length; commandIndex += 1) {
      const result = validation.commands[commandIndex];
      const where = `run.steps[${stepIndex}].validation.commands[${commandIndex}]`;
      if (!isPlainObject(result)) throw new TypeError(`${where} must be an object`);
      if (!isPlainObject(result.command)) throw new TypeError(`${where}.command must be an object`);
      if (typeof result.command.executable !== 'string') throw new TypeError(`${where}.command.executable must be a string`);
      if (!isStringArray(result.command.args)) throw new TypeError(`${where}.command.args must be an array of strings`);
      if (typeof result.status !== 'string') throw new TypeError(`${where}.status must be a string`);
      if (result.exitCode !== null && !Number.isInteger(result.exitCode)) throw new TypeError(`${where}.exitCode must be an integer or null`);
      if (typeof result.truncated !== 'boolean') throw new TypeError(`${where}.truncated must be a boolean`);
      checks.push({
        stepId: step.definition.id,
        executable: result.command.executable,
        args: [...result.command.args],
        status: result.status,
        exitCode: result.exitCode,
        truncated: result.truncated,
        sourceUnchanged,
      });
    }
  }
  return {runId: run.id, checks};
}

function readInput(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return {error: 'summarize-test-results: cannot read input file'};
  }
  try {
    return {value: JSON.parse(text)};
  } catch {
    return {error: 'summarize-test-results: input file is not valid JSON'};
  }
}

function runCli(argv) {
  if (argv.length !== 1) {
    process.stderr.write(USAGE + '\n');
    return 2;
  }
  const input = readInput(argv[0]);
  if (input.error) {
    process.stderr.write(input.error + '\n');
    return 1;
  }
  let summary;
  try {
    summary = summarizeTestResults(input.value);
  } catch (error) {
    const detail = error instanceof TypeError ? error.message : 'invalid test results shape';
    process.stderr.write(`summarize-test-results: ${detail}\n`);
    return 1;
  }
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  return 0;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = runCli(process.argv.slice(2));
}
