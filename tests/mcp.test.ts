import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createAppFixture } from './helpers/app-fixture.js';
import type { Run, Workflow } from '../src/shared/types.js';

interface Rpc {
  result?: {
    content?: { text: string }[];
    isError?: boolean;
    tools?: { name: string; annotations?: Record<string, unknown> }[];
    serverInfo?: { name: string };
  };
}
interface RunView {
  id: string;
  status: Run['status'];
  project: string;
  next_actions: string[];
  steps: { output?: string; attempt: number }[];
  events: unknown[];
  last_event_id?: number;
}

void test('external MCP endpoint exposes run control tools over the local API boundary', async (t) => {
  const f = await createAppFixture(t, {
    project: 'sample',
    config: { port: 4317 },
    options: {
      serveStatic: false,
      execute: async (_s, p, w) => {
        await writeFile(
          path.join(w, 'result.txt'),
          'line one\nline two\nline three',
        );
        return {
          output: p.includes('Use blue') ? 'Revised blue' : 'Initial answer',
          sessionId: null,
          costUsd: null,
        };
      },
    },
  });
  const address = await f.app.listen({ port: 0, host: '127.0.0.1' });
  let id = 0;
  const rpc = async (
    method: string,
    params: object = {},
    headers: Record<string, string> = {},
  ) => {
    const response = await fetch(address + '/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    const text = await response.text();
    const body = response.headers
      .get('content-type')
      ?.includes('text/event-stream')
      ? text
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5))
          .join('')
      : text;
    return {
      status: response.status,
      body: (body ? JSON.parse(body) : {}) as Rpc,
    };
  };
  // onError is the data returned when the tool reports an error.
  const call = async <T>(name: string, args: object, onError: T) => {
    const { body } = await rpc('tools/call', { name, arguments: args });
    const text = body.result?.content?.[0]?.text ?? '';
    const isError = body.result?.isError === true;
    return { isError, text, data: isError ? onError : (JSON.parse(text) as T) };
  };
  const runView = (runId: string, extra: object = {}) =>
    call<RunView | undefined>(
      'agentloom_get_run',
      { run_id: runId, ...extra },
      undefined,
    );

  await t.test('initializes and lists annotated agentloom_ tools', async () => {
    const init = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    assert.equal(init.status, 200);
    assert.equal(init.body.result?.serverInfo?.name, 'agentloom');
    const tools = (await rpc('tools/list')).body.result?.tools ?? [];
    assert.equal(tools.length, 16);
    assert.ok(
      tools.every(
        (tool) =>
          tool.name.startsWith('agentloom_') &&
          typeof tool.annotations?.readOnlyHint === 'boolean',
      ),
    );
    const hint = (name: string, key: string) =>
      tools.find((tool) => tool.name === name)?.annotations?.[key];
    assert.equal(hint('agentloom_cancel_run', 'destructiveHint'), true);
    assert.equal(hint('agentloom_get_run', 'readOnlyHint'), true);
  });

  await t.test(
    'rejects foreign origins and hosts like the rest of the API',
    async () => {
      const foreign = await rpc(
        'tools/list',
        {},
        { origin: 'https://evil.example' },
      );
      assert.equal(foreign.status, 403);
      const hostile = await f.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { host: 'evil.example' },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      });
      assert.equal(hostile.statusCode, 403);
    },
  );

  await t.test(
    'lists workflows and projects with readable summaries',
    async () => {
      const concise = await call<{
        workflows: { id: string; steps: unknown[] }[];
      }>('agentloom_list_workflows', {}, { workflows: [] });
      const summary = concise.data.workflows.find(
        (w) => w.id === 'review-build',
      );
      assert.equal(typeof summary?.steps[0], 'string');
      const detailed = await call<{ workflows: Workflow[] }>(
        'agentloom_list_workflows',
        { workflow_id: 'review-build', response_format: 'detailed' },
        { workflows: [] },
      );
      assert.equal(
        typeof detailed.data.workflows[0]?.steps[0]?.instructions,
        'string',
      );
      const missing = await call(
        'agentloom_list_workflows',
        {
          workflow_id: 'nope',
        },
        {},
      );
      assert.equal(missing.isError, true);
      assert.match(missing.text, /agentloom_list_workflows/);
      const projects = await call<{ projects: { id: string }[] }>(
        'agentloom_list_projects',
        {},
        { projects: [] },
      );
      assert.equal(projects.data.projects[0]?.id, 'sample');
    },
  );

  await t.test(
    'saves workflows through the strict API validation',
    async () => {
      const template = (
        await call<{ workflows: Workflow[] }>(
          'agentloom_list_workflows',
          {
            workflow_id: 'review-build',
            response_format: 'detailed',
          },
          { workflows: [] },
        )
      ).data.workflows.at(0);
      const first = template?.steps.at(0);
      assert.ok(template && first);
      const step = { ...first, id: 'only', approval: true, planning: false };
      const workflow = {
        ...template,
        id: 'mcp-test',
        name: 'MCP test',
        steps: [step],
      };
      const saved = await call<{ saved: { id: string } }>(
        'agentloom_save_workflow',
        { workflow },
        { saved: { id: '' } },
      );
      assert.equal(saved.data.saved.id, 'mcp-test');
      const rejected = await call(
        'agentloom_save_workflow',
        {
          workflow: { ...workflow, steps: [step, step] },
        },
        {},
      );
      assert.equal(rejected.isError, true);
      assert.match(rejected.text, /duplicate step id/);
    },
  );

  await t.test('starts, revises, approves and inspects a run', async () => {
    const started = await call<{ started: { id: string } }>(
      'agentloom_start_run',
      {
        title: 'MCP run',
        task: 'Make it',
        workflow_id: 'mcp-test',
        project_id: 'sample',
        mode: 'live',
      },
      { started: { id: '' } },
    );
    const runId = started.data.started.id;
    await f.wait(runId, 'waiting_approval');
    const waiting = (await runView(runId)).data;
    assert.ok(waiting);
    assert.deepEqual(waiting.next_actions.slice(0, 2), ['approve', 'revise']);
    assert.equal(waiting.steps[0]?.output, 'Initial answer');
    assert.ok((waiting.last_event_id ?? 0) > 0);

    const search = await call<{ runs: { id: string; project: string }[] }>(
      'agentloom_search_runs',
      { query: 'mcp run' },
      { runs: [] },
    );
    assert.equal(search.data.runs[0]?.id, runId);
    assert.equal(search.data.runs[0]?.project, 'sample');

    const noText = await call(
      'agentloom_respond_to_run',
      {
        run_id: runId,
        action: 'revise',
      },
      {},
    );
    assert.equal(noText.isError, true);
    assert.match(noText.text, /needs text/);
    const wrongState = await call(
      'agentloom_respond_to_run',
      {
        run_id: runId,
        action: 'retry',
      },
      {},
    );
    assert.equal(wrongState.isError, true);
    assert.match(wrongState.text, /Cannot retry.*agentloom_get_run/);

    await call(
      'agentloom_respond_to_run',
      {
        run_id: runId,
        action: 'revise',
        text: 'Use blue',
      },
      {},
    );
    await f.wait(
      runId,
      (run) => run.status === 'waiting_approval' && run.steps[0]?.attempt === 2,
    );
    const revised = (await runView(runId)).data;
    assert.ok(revised);
    assert.equal(revised.steps[0]?.output, 'Revised blue');
    const newer = await runView(runId, { events_after: revised.last_event_id });
    assert.equal(newer.data?.events.length, 0);

    await call(
      'agentloom_respond_to_run',
      {
        run_id: runId,
        action: 'approve',
      },
      {},
    );
    await f.wait(runId, 'completed');

    const files = await call<{ files: string[] }>(
      'agentloom_list_run_files',
      {
        run_id: runId,
      },
      { files: [] },
    );
    assert.ok(files.data.files.some((file) => file.startsWith('result.txt')));
    const file = await call<{ content: string; next_start_line?: number }>(
      'agentloom_read_run_file',
      { run_id: runId, path: 'result.txt', start_line: 2, max_lines: 1 },
      { content: '' },
    );
    assert.equal(file.data.content, 'line two');
    assert.equal(file.data.next_start_line, 3);
    const escape = await call(
      'agentloom_read_run_file',
      {
        run_id: runId,
        path: '../../outside',
      },
      {},
    );
    assert.equal(escape.isError, true);
    const cancel = await call('agentloom_cancel_run', { run_id: runId }, {});
    assert.equal(cancel.isError, true);
    const finished = await call<{ total: number; hint?: string }>(
      'agentloom_search_runs',
      {},
      { total: 0 },
    );
    assert.equal(finished.data.total, 0);
    assert.match(finished.data.hint ?? '', /status/);

    await f.request('/api/projects/sample', {
      method: 'PATCH',
      payload: { status: 'archived' },
    });
    const archived = await call<{ runs: { project: string }[] }>(
      'agentloom_search_runs',
      { status: ['completed'], project: 'sample' },
      { runs: [] },
    );
    assert.equal(archived.data.runs[0]?.project, 'sample (archived)');
    const archivedView = await runView(runId);
    assert.equal(archivedView.data?.project, 'sample (archived)');
  });

  await t.test(
    'reports unknown runs and invalid arguments as tool errors',
    async () => {
      const unknown = await runView('missing');
      assert.equal(unknown.isError, true);
      assert.match(unknown.text, /agentloom_search_runs/);
      const invalid = await call(
        'agentloom_start_run',
        {
          title: 'x',
          task: 'x',
          workflow_id: 'mcp-test',
          project_id: 'sample',
          mode: 'sometimes',
        },
        {},
      );
      assert.equal(invalid.isError, true);
    },
  );
});
