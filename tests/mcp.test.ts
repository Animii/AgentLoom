import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server/app.js';
import type { Workflow } from '../src/shared/types.js';

type Rpc = { result?: { content?: { text: string }[]; isError?: boolean; tools?: { name: string; annotations?: Record<string, unknown>; inputSchema: unknown }[]; serverInfo?: { name: string } }; error?: { message: string } };

test('external MCP endpoint exposes run control tools over the local API boundary', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-mcp-')); const work = path.join(root, 'workspaces'); await mkdir(path.join(work, 'projects/sample'), { recursive: true });
  const app = await createApp({ dataDir: path.join(root, 'data'), workspaceRoot: work, host: '127.0.0.1', port: 4317, cliTimeoutMs: 1000, maxOutputBytes: 10000 }, { serveStatic: false, execute: async (_s, p, w) => { await writeFile(path.join(w, 'result.txt'), 'line one\nline two\nline three'); return { output: p.includes('Use blue') ? 'Revised blue' : 'Initial answer', sessionId: null, costUsd: null }; } });
  const address = await app.listen({ port: 0, host: '127.0.0.1' }); let id = 0;
  const rpc = async (method: string, params: object = {}, headers: Record<string, string> = {}) => {
    const response = await fetch(address + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    const text = await response.text();
    const body = response.headers.get('content-type')?.includes('text/event-stream') ? text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).join('') : text;
    return { status: response.status, body: (body ? JSON.parse(body) : {}) as Rpc };
  };
  const call = async (name: string, args: object) => {
    const { body } = await rpc('tools/call', { name, arguments: args });
    const text = body.result?.content?.[0]?.text ?? ''; return { isError: !!body.result?.isError, text, data: body.result?.isError ? undefined : JSON.parse(text) };
  };
  try {
    await t.test('initializes and lists annotated agentloom_ tools', async () => {
      const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
      assert.equal(init.status, 200); assert.equal(init.body.result?.serverInfo?.name, 'agentloom');
      const tools = (await rpc('tools/list')).body.result!.tools!;
      assert.ok(tools.length >= 15); assert.ok(tools.every(tool => tool.name.startsWith('agentloom_') && tool.annotations && typeof tool.annotations.readOnlyHint === 'boolean'));
      assert.equal(tools.find(tool => tool.name === 'agentloom_cancel_run')!.annotations!.destructiveHint, true);
      assert.equal(tools.find(tool => tool.name === 'agentloom_get_run')!.annotations!.readOnlyHint, true);
    });

    await t.test('rejects foreign origins and hosts like the rest of the API', async () => {
      assert.equal((await rpc('tools/list', {}, { origin: 'https://evil.example' })).status, 403);
      const hostile = await app.inject({ method: 'POST', url: '/mcp', headers: { host: 'evil.example' }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
      assert.equal(hostile.statusCode, 403);
    });

    await t.test('lists workflows and projects with readable summaries', async () => {
      const workflows = await call('agentloom_list_workflows', {});
      assert.ok(workflows.data.workflows.some((w: { id: string; steps: string[] }) => w.id === 'review-build' && typeof w.steps[0] === 'string'));
      const detailed = await call('agentloom_list_workflows', { workflow_id: 'review-build', response_format: 'detailed' });
      assert.ok(Array.isArray(detailed.data.workflows[0].steps[0].instructions.split('')));
      const missing = await call('agentloom_list_workflows', { workflow_id: 'nope' }); assert.equal(missing.isError, true); assert.match(missing.text, /agentloom_list_workflows/);
      const projects = await call('agentloom_list_projects', {}); assert.equal(projects.data.projects[0].id, 'sample');
    });

    let template: Workflow;
    await t.test('saves workflows through the strict API validation', async () => {
      template = (await call('agentloom_list_workflows', { workflow_id: 'review-build', response_format: 'detailed' })).data.workflows[0];
      const workflow = { ...template, id: 'mcp-test', name: 'MCP test', steps: [{ ...template.steps[0], id: 'only', approval: true, planning: false }] };
      const saved = await call('agentloom_save_workflow', { workflow }); assert.equal(saved.data.saved.id, 'mcp-test');
      const rejected = await call('agentloom_save_workflow', { workflow: { ...workflow, steps: [workflow.steps[0], workflow.steps[0]] } });
      assert.equal(rejected.isError, true); assert.match(rejected.text, /duplicate step id/);
    });

    await t.test('starts, revises, approves and inspects a run', async () => {
      const started = await call('agentloom_start_run', { title: 'MCP run', task: 'Make it', workflow_id: 'mcp-test', project_id: 'sample', mode: 'live' });
      const runId: string = started.data.started.id; assert.ok(runId);
      const waitFor = async (status: string) => { for (let i = 0; i < 200; i++) { const run = await call('agentloom_get_run', { run_id: runId }); if (run.data.status === status) return run.data; await delay(20); } throw new Error('Timed out ' + status); };
      const waiting = await waitFor('waiting_approval');
      assert.deepEqual(waiting.next_actions.slice(0, 2), ['approve', 'revise']); assert.equal(waiting.steps[0].output, 'Initial answer'); assert.ok(waiting.last_event_id > 0);
      const search = await call('agentloom_search_runs', { query: 'mcp run' }); assert.equal(search.data.runs[0].id, runId); assert.equal(search.data.runs[0].project, 'sample');
      const noText = await call('agentloom_respond_to_run', { run_id: runId, action: 'revise' }); assert.equal(noText.isError, true); assert.match(noText.text, /needs text/);
      const wrongState = await call('agentloom_respond_to_run', { run_id: runId, action: 'retry' }); assert.equal(wrongState.isError, true); assert.match(wrongState.text, /Cannot retry.*agentloom_get_run/);
      await call('agentloom_respond_to_run', { run_id: runId, action: 'revise', text: 'Use blue' });
      const revised = await waitFor('waiting_approval'); assert.equal(revised.steps[0].output, 'Revised blue'); assert.equal(revised.steps[0].attempt, 2);
      const newer = await call('agentloom_get_run', { run_id: runId, events_after: revised.last_event_id }); assert.equal(newer.data.events.length, 0);
      await call('agentloom_respond_to_run', { run_id: runId, action: 'approve' }); await waitFor('completed');
      const files = await call('agentloom_list_run_files', { run_id: runId }); assert.ok(files.data.files.some((f: string) => f.startsWith('result.txt')));
      const file = await call('agentloom_read_run_file', { run_id: runId, path: 'result.txt', start_line: 2, max_lines: 1 });
      assert.equal(file.data.content, 'line two'); assert.equal(file.data.next_start_line, 3);
      const escape = await call('agentloom_read_run_file', { run_id: runId, path: '../../outside' }); assert.equal(escape.isError, true);
      const cancel = await call('agentloom_cancel_run', { run_id: runId }); assert.equal(cancel.isError, true);
      const finished = await call('agentloom_search_runs', {}); assert.equal(finished.data.total, 0); assert.match(finished.data.hint, /status/);
    });

    await t.test('reports unknown runs and invalid arguments as tool errors', async () => {
      const unknown = await call('agentloom_get_run', { run_id: 'missing' }); assert.equal(unknown.isError, true); assert.match(unknown.text, /agentloom_search_runs/);
      const invalid = await call('agentloom_start_run', { title: 'x', task: 'x', workflow_id: 'mcp-test', project_id: 'sample', mode: 'sometimes' }); assert.equal(invalid.isError, true);
    });
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
