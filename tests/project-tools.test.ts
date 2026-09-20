import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { PlanningToolCall } from '../src/shared/types.js';
import { createAskTool } from '../src/server/ask-tool.js';

test('planner MCP reads, lists and searches only its project, with bounded results', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-project-tools-'));
  const workspace = path.join(root, 'project');
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  await writeFile(path.join(workspace, 'src/main.ts'), 'export const answer = 42;\n// implementation detail\n');
  await writeFile(path.join(workspace, '.env'), 'SECRET=private');
  await writeFile(path.join(root, 'outside.txt'), 'outside');
  await mkdir(path.join(root, 'outside'));await writeFile(path.join(root, 'outside/secret.txt'), 'outside');
  await symlink(path.join(root, 'outside'), path.join(workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const activity: PlanningToolCall[] = [];
  const tool = await createAskTool(() => {}, workspace, undefined, call => activity.push(call));
  const rpc = async (method: string, params: unknown = {}) => (await (await fetch(tool.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()) as any;
  const call = (name: string, args: unknown) => rpc('tools/call', { name, arguments: args });
  const content = (result: any) => { assert.notEqual(result.result.isError, true); return JSON.parse(result.result.content[0].text); };
  try {
    assert.deepEqual((await rpc('tools/list')).result.tools.map((t: any) => t.name), ['ask_user', 'list_project_files', 'read_project_file', 'search_project']);
    assert.deepEqual(content(await call('list_project_files', {})).entries, [{ path: 'src', type: 'directory' }]);
    assert.equal(content(await call('list_project_files', { path: 'src' })).entries[0].path, 'src/main.ts');
    const first = content(await call('read_project_file', { path: 'src/main.ts', lineCount: 1 }));
    assert.deepEqual(first.lines, [{ line: 1, text: 'export const answer = 42;' }]);assert.equal(first.nextLine, 2);
    assert.equal(content(await call('read_project_file', { path: 'src/main.ts', startLine: 2 })).lines[0].text, '// implementation detail');
    const matches = content(await call('search_project', { query: 'ANSWER' })).matches;
    assert.equal(matches.length, 1);assert.equal(matches[0].path, 'src/main.ts');assert.equal(matches[0].line, 1);
    for (const name of ['list_project_files', 'read_project_file', 'search_project']) {
      for (const target of ['../outside.txt', path.join(root, 'outside'), 'linked', 'linked/secret.txt', '.env', 'src/../../outside.txt']) {
        assert.equal((await call(name, { path: target, ...(name === 'search_project' ? { query: 'outside' } : {}) })).result.isError, true, `${name}: ${target}`);
      }
    }
    assert.equal((await call('read_project_file', { path: 'src/main.ts', startLine: 0 })).result.isError, true);
    assert.ok((await call('write_project_file', { path: 'src/main.ts', text: 'changed' })).error);
    assert.equal(await readFile(path.join(workspace, 'src/main.ts'), 'utf8'), 'export const answer = 42;\n// implementation detail\n');
    await writeFile(path.join(workspace, 'many.txt'), 'match\n'.repeat(60));
    const search = content(await call('search_project', { query: 'match' }));assert.equal(search.matches.length, 50);assert.equal(search.truncated, true);
    assert.ok(activity.some(call => call.status === 'running'));
    assert.ok(activity.some(call => call.status === 'failed'));
    assert.ok(activity.some(call => call.name === 'read_project_file' && call.status === 'completed' && call.summary?.includes('lines read')));
    assert.ok(activity.every(call => !JSON.stringify(call).includes('export const answer')));
    await call('ask_user', { questions: [{ question: 'Anything else?' }] });
    assert.equal((await call('read_project_file', { path: 'src/main.ts' })).result.isError, true);
  } finally { tool.close();await rm(root, { recursive: true, force: true }); }
});
