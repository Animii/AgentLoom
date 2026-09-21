#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const usage = 'Usage: node scripts/summarize-run-cost.mjs RUN_JSON_FILE';

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
}

function assertAttempt(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a nonnegative safe integer`);
}

function assertCost(value, label) {
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) throw new TypeError(`${label} must be a finite nonnegative number or null`);
}

export function summarizeRunCost(run) {
  assertObject(run, 'run');
  if (typeof run.id !== 'string') throw new TypeError('run.id must be a string');
  if (!Array.isArray(run.steps)) throw new TypeError('run.steps must be an array');
  const attempts = [];
  let knownUsd = 0;
  let unreportedAttempts = 0;
  for (let index = 0; index < run.steps.length; index++) {
    const step = run.steps[index];
    const label = `run.steps[${index}]`;
    assertObject(step, label);
    assertObject(step.definition, `${label}.definition`);
    if (typeof step.definition.id !== 'string') throw new TypeError(`${label}.definition.id must be a string`);
    assertAttempt(step.attempt, `${label}.attempt`);
    assertCost(step.costUsd, `${label}.costUsd`);
    const history = step.history;
    if (history !== undefined && !Array.isArray(history)) throw new TypeError(`${label}.history must be an array`);
    const entries = [];
    if (Array.isArray(history)) {
      for (let position = 0; position < history.length; position++) {
        const entry = history[position];
        assertObject(entry, `${label}.history[${position}]`);
        assertAttempt(entry.attempt, `${label}.history[${position}].attempt`);
        assertCost(entry.costUsd, `${label}.history[${position}].costUsd`);
        entries.push(entry);
      }
    }
    entries.push(step);
    for (const entry of entries) {
      if (entry.attempt === 0) continue;
      attempts.push({stepId: step.definition.id, attempt: entry.attempt, costUsd: entry.costUsd});
      if (entry.costUsd === null) unreportedAttempts++;
      else {
        knownUsd += entry.costUsd;
        if (!Number.isFinite(knownUsd)) throw new TypeError('Cost sum is not a finite number');
      }
    }
  }
  return {runId: run.id, knownUsd, unreportedAttempts, attempts};
}

async function main() {
  const files = process.argv.slice(2);
  if (files.length !== 1) {
    process.stderr.write(`${usage}\n`);
    process.exitCode = 2;
    return;
  }
  let contents;
  try {
    contents = await readFile(files[0], 'utf8');
  } catch {
    process.stderr.write('summarize-run-cost: could not read the run JSON file\n');
    process.exitCode = 1;
    return;
  }
  let run;
  try {
    run = JSON.parse(contents);
  } catch {
    process.stderr.write('summarize-run-cost: the run JSON file is not valid JSON\n');
    process.exitCode = 1;
    return;
  }
  let summary;
  try {
    summary = summarizeRunCost(run);
  } catch {
    process.stderr.write('summarize-run-cost: the run JSON does not match the expected shape\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
