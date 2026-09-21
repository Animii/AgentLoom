#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_URL = 'http://127.0.0.1:4317';
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const ORIGIN_PATTERN = /^(https?):\/\/([^/?#\\\s]+)\/?$/i;
const REQUEST_TIMEOUT_MS = 3000;
const USAGE = 'usage: node scripts/run-status.mjs RUN_ID [--url URL] [--json]';

class UsageError extends Error {}

export function summarizeRun(run) {
  if (run === null || typeof run !== 'object' || Array.isArray(run)) {
    throw new TypeError('run response must be an object');
  }
  if (typeof run.id !== 'string') throw new TypeError('run.id must be a string');
  if (typeof run.title !== 'string') throw new TypeError('run.title must be a string');
  if (typeof run.status !== 'string') throw new TypeError('run.status must be a string');
  if (!Array.isArray(run.steps)) throw new TypeError('run.steps must be an array');
  if (!Number.isInteger(run.currentStep) || run.currentStep < 0) {
    throw new TypeError('run.currentStep must be a non-negative integer');
  }

  let step = null;
  if (run.currentStep < run.steps.length) {
    const entry = run.steps[run.currentStep];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError(`run.steps[${run.currentStep}] must be an object`);
    }
    const definition = entry.definition;
    if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
      throw new TypeError(`run.steps[${run.currentStep}].definition must be an object`);
    }
    if (typeof definition.name !== 'string') {
      throw new TypeError(`run.steps[${run.currentStep}].definition.name must be a string`);
    }
    step = definition.name;
  }

  return {
    id: run.id,
    title: run.title,
    status: run.status,
    step,
    automation: optionalField(run, 'automation', 'status'),
    prUrl: optionalField(run, 'git', 'prUrl'),
  };
}

function optionalField(run, containerKey, fieldKey) {
  const container = run[containerKey];
  if (container === undefined || container === null) return null;
  if (typeof container !== 'object' || Array.isArray(container)) {
    throw new TypeError(`run.${containerKey} must be an object when present`);
  }
  const value = container[fieldKey];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new TypeError(`run.${containerKey}.${fieldKey} must be a string when present`);
  }
  return value;
}

function parseOrigin(value) {
  if (!ORIGIN_PATTERN.test(value)) {
    throw new UsageError('--url must be an http(s) origin without credentials, query, fragment or path');
  }
  if (value.includes('@')) {
    throw new UsageError('--url must not contain credentials');
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new UsageError('invalid --url value');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UsageError('--url must use http or https');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new UsageError('--url must not contain credentials');
  }
  if (parsed.search !== '' || parsed.hash !== '' || parsed.pathname !== '/') {
    throw new UsageError('--url must not contain a query, fragment or path');
  }
  return parsed.origin;
}

function parseArgs(argv) {
  let id = null;
  let url = DEFAULT_URL;
  let json = false;
  let urlSeen = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      if (json) throw new UsageError('duplicate argument: --json');
      json = true;
      continue;
    }
    if (arg === '--url') {
      if (urlSeen) throw new UsageError('duplicate argument: --url');
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError('missing value for --url');
      url = parseOrigin(value);
      urlSeen = true;
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) throw new UsageError('unknown argument');
    if (id !== null) throw new UsageError('duplicate run id');
    id = arg;
  }

  if (id === null) throw new UsageError('missing RUN_ID');
  if (!RUN_ID_PATTERN.test(id)) throw new UsageError('invalid RUN_ID');
  return { id, url, json };
}

async function fetchRun(origin, id) {
  const target = new URL(`/api/runs/${id}`, origin);
  let response;
  try {
    response = await fetch(target, {
      method: 'GET',
      redirect: 'error',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(describeRequestError(error));
  }
  if (!response.ok) throw new Error(`request failed with HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error('response was not valid JSON');
  }
}

function describeRequestError(error) {
  if (error !== null && typeof error === 'object' && error.name === 'TimeoutError') {
    return `request timed out after ${REQUEST_TIMEOUT_MS}ms`;
  }
  const cause = error !== null && typeof error === 'object' && error.cause && error.cause.message;
  if (typeof cause === 'string' && cause.toLowerCase().includes('redirect')) {
    return 'redirects are not allowed';
  }
  return 'request failed';
}

function display(value) {
  return value === null || value === undefined ? '-' : String(value);
}

function formatText(summary) {
  return [
    `ID: ${display(summary.id)}`,
    `Title: ${display(summary.title)}`,
    `Status: ${display(summary.status)}`,
    `Step: ${display(summary.step)}`,
    `Automation: ${display(summary.automation)}`,
    `PR: ${display(summary.prUrl)}`,
  ].join('\n');
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`run-status: ${error.message}`);
      console.error(USAGE);
      return 2;
    }
    throw error;
  }

  let run;
  try {
    run = await fetchRun(options.url, options.id);
  } catch (error) {
    console.error(`run-status: ${error.message}`);
    return 1;
  }

  let summary;
  try {
    summary = summarizeRun(run);
  } catch (error) {
    const message = error instanceof TypeError ? error.message : 'invalid run response';
    console.error(`run-status: ${message}`);
    return 1;
  }

  if (options.json) console.log(JSON.stringify(summary));
  else console.log(formatText(summary));
  return 0;
}

const isDirectExecution = (() => {
  if (typeof process.argv[1] !== 'string') return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isDirectExecution) {
  process.exitCode = await main(process.argv.slice(2));
}
