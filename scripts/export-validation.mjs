import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const USAGE = 'Usage: node scripts/export-validation.mjs RUN_JSON_FILE';

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireObject(value, label) {
  if (!isObject(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function requireString(value, label, allowEmpty = false) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string.`);
  if (!allowEmpty && value.length === 0) throw new TypeError(`${label} must not be empty.`);
  return value;
}

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean.`);
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer.`);
  return value;
}

function requireIntegerOrNull(value, label) {
  if (value !== null && !Number.isInteger(value)) throw new TypeError(`${label} must be an integer or null.`);
  return value;
}

function optionalString(value, label) {
  if (value === undefined || value === null) return null;
  return requireString(value, label, true);
}

function projectCommand(record, index) {
  const label = `steps[].validation.commands[${index}]`;
  requireObject(record, label);
  const command = requireObject(record.command, `${label}.command`);
  const executable = requireString(command.executable, `${label}.command.executable`);
  if (!Array.isArray(command.args)) throw new TypeError(`${label}.command.args must be an array of strings.`);
  const args = [];
  for (let argIndex = 0; argIndex < command.args.length; argIndex += 1) {
    args.push(requireString(command.args[argIndex], `${label}.command.args[${argIndex}]`, true));
  }
  return {
    executable,
    args,
    status: requireString(record.status, `${label}.status`),
    exitCode: requireIntegerOrNull(record.exitCode, `${label}.exitCode`),
    startedAt: requireString(record.startedAt, `${label}.startedAt`),
    finishedAt: optionalString(record.finishedAt, `${label}.finishedAt`),
    truncated: requireBoolean(record.truncated, `${label}.truncated`),
  };
}

function projectStep(step, index) {
  const label = `steps[${index}]`;
  requireObject(step, label);
  if (step.validation === undefined || step.validation === null) return null;
  const validation = requireObject(step.validation, `${label}.validation`);
  const definition = requireObject(step.definition, `${label}.definition`);
  if (!Array.isArray(validation.commands)) throw new TypeError(`${label}.validation.commands must be an array.`);
  const commands = [];
  for (let commandIndex = 0; commandIndex < validation.commands.length; commandIndex += 1) {
    commands.push(projectCommand(validation.commands[commandIndex], commandIndex));
  }
  return {
    stepId: requireString(definition.id, `${label}.definition.id`),
    attempt: requirePositiveInteger(step.attempt, `${label}.attempt`),
    status: requireString(validation.status, `${label}.validation.status`),
    before: requireString(validation.before, `${label}.validation.before`, true),
    after: optionalString(validation.after, `${label}.validation.after`),
    commands,
  };
}

export function summarizeValidation(run) {
  requireObject(run, 'run');
  const runId = requireString(run.id, 'run.id');
  const runStatus = requireString(run.status, 'run.status');
  if (!Array.isArray(run.steps)) throw new TypeError('run.steps must be an array.');
  const steps = [];
  for (let index = 0; index < run.steps.length; index += 1) {
    const projected = projectStep(run.steps[index], index);
    if (projected !== null) steps.push(projected);
  }
  return {runId, runStatus, steps};
}

async function main(argv) {
  const args = argv.slice(2);
  if (args.length !== 1) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  const file = args[0];
  try {
    const text = await readFile(file, 'utf8');
    let run;
    try {
      run = JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON in ${file}.`);
    }
    process.stdout.write(`${JSON.stringify(summarizeValidation(run), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`export-validation: ${error instanceof Error ? error.message : 'export failed'}\n`);
    process.exitCode = 1;
  }
}

function isMainModule() {
  const entry = process.argv[1];
  return Boolean(entry) && pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  await main(process.argv);
}
