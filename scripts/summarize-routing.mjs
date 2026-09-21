import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const USAGE = 'Usage: node scripts/summarize-routing.mjs RUN_JSON_FILE';

function isAbsent(value) {
  return value === undefined;
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function projectDecision(decision, index) {
  const at = `run.automation.decisions[${index}]`;
  if (!isObject(decision)) throw new TypeError(`${at} must be an object.`);
  const { choice, action, confidence, offeredActions } = decision;
  if (typeof choice !== 'string') throw new TypeError(`${at}.choice must be a string.`);
  if (typeof action !== 'string') throw new TypeError(`${at}.action must be a string.`);
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new TypeError(`${at}.confidence must be a finite number between 0 and 1.`);
  }
  let projectedOfferedActions = null;
  if (!isAbsent(offeredActions)) {
    if (!Array.isArray(offeredActions)) throw new TypeError(`${at}.offeredActions must be an array of strings when present.`);
    for (const offered of offeredActions) {
      if (typeof offered !== 'string') throw new TypeError(`${at}.offeredActions must contain only strings.`);
    }
    projectedOfferedActions = offeredActions.slice();
  }
  return { choice, action, confidence, offeredActions: projectedOfferedActions };
}

export function summarizeRouting(run) {
  if (!isObject(run)) throw new TypeError('run must be an object.');
  if (typeof run.id !== 'string') throw new TypeError('run.id must be a string.');
  if (typeof run.status !== 'string') throw new TypeError('run.status must be a string.');
  if (isAbsent(run.automation)) {
    return { runId: run.id, status: run.status, repairsUsed: 0, escalationUsed: false, decisions: [] };
  }
  if (!isObject(run.automation)) throw new TypeError('run.automation must be an object when present.');
  const { repairsUsed, decisions, escalation } = run.automation;
  if (!Number.isSafeInteger(repairsUsed) || repairsUsed < 0) {
    throw new TypeError('run.automation.repairsUsed must be a nonnegative safe integer.');
  }
  if (!Array.isArray(decisions)) throw new TypeError('run.automation.decisions must be an array.');
  let escalationUsed = false;
  if (!isAbsent(escalation)) {
    if (!isObject(escalation)) throw new TypeError('run.automation.escalation must be an object when present.');
    if (typeof escalation.used !== 'boolean') throw new TypeError('run.automation.escalation.used must be a boolean.');
    escalationUsed = escalation.used;
  }
  const projectedDecisions = [];
  for (let index = 0; index < decisions.length; index += 1) {
    if (!(index in decisions)) throw new TypeError(`run.automation.decisions[${index}] is missing; sparse arrays are not allowed.`);
    projectedDecisions.push(projectDecision(decisions[index], index));
  }
  return {
    runId: run.id,
    status: run.status,
    repairsUsed,
    escalationUsed,
    decisions: projectedDecisions,
  };
}

function fail(code, message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = code;
}

async function runCli(argv) {
  const args = argv.slice(2);
  if (args.length !== 1) {
    fail(2, USAGE);
    return;
  }
  const file = args[0];
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    fail(1, `Could not read ${file}.`);
    return;
  }
  let run;
  try {
    run = JSON.parse(text);
  } catch {
    fail(1, `Could not parse JSON from ${file}.`);
    return;
  }
  let summary;
  try {
    summary = summarizeRouting(run);
  } catch (error) {
    fail(1, error instanceof TypeError ? error.message : 'The run file has an invalid shape.');
    return;
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli(process.argv);
}
