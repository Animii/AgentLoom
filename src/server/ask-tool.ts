import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PlanningQuestion, PlanningToolCall } from '../shared/types.js';
import { toolInput, projectToolSummary } from './tool-activity.js';
import { createProjectTools, PROJECT_TOOL_NAMES } from './project-tools.js';

export const askSchema = z.strictObject({ questions: z.array(z.strictObject({
  question: z.string().trim().min(1).max(500),
  header: z.string().trim().min(1).max(40).optional(),
  multiSelect: z.boolean().optional(),
  options: z.array(z.union([z.string().trim().min(1).max(120), z.strictObject({
    label: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(300).optional(),
    recommended: z.boolean().optional(),
  })])).min(2).max(4).optional(),
})).min(1).max(3) });

// Turn-scoped MCP tools; filesystem access is read-only and rooted in this run's project.
export async function createAskTool(onAsk: (questions: PlanningQuestion[]) => void, workspace?: string, onRead?: (name: string) => void, onTool?: (call: PlanningToolCall) => void) {
  const project = workspace ? await createProjectTools(workspace) : undefined;
  const token = randomBytes(32).toString('hex');
  let asked = false;
  const server = createServer(async (request, response) => {
    const json = (value: unknown, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (request.url !== `/mcp/${token}` || request.headers.origin || !request.headers.host?.startsWith('127.0.0.1:')) { json({ error: 'Forbidden' }, 403); return; }
    if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }); response.end(); return; }
    let rpc: { id?: string | number; method?: string; params?: { protocolVersion?: string; name?: string; arguments?: unknown } };
    try {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of request) { bytes += Buffer.byteLength(chunk); if (bytes > 16000) { json({ error: 'Request too large' }, 413); return; } chunks.push(Buffer.from(chunk)); }
      rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!rpc || typeof rpc !== 'object' || Array.isArray(rpc)) throw new Error('Invalid request');
    } catch { json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON request' } }); return; }
    if (rpc.id === undefined) { response.writeHead(202); response.end(); return; }
    const result = (value: unknown) => json({ jsonrpc: '2.0', id: rpc.id, result: value });
    if (rpc.method === 'initialize') { result({ protocolVersion: rpc.params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'agentloom', version: '1.0.0' } }); return; }
    if (rpc.method === 'ping') { result({}); return; }
    if (rpc.method === 'tools/call' && project && PROJECT_TOOL_NAMES.includes(rpc.params?.name ?? '')) {
      if (asked) { result({ isError: true, content: [{ type: 'text', text: 'Questions are pending. End this turn and wait for the user.' }] }); return; }
      const call: PlanningToolCall = { id: randomUUID(), name: rpc.params!.name!, status: 'running', input: toolInput(rpc.params?.arguments), startedAt: new Date().toISOString() };
      onTool?.(call);
      try {
        const data = await project.call(rpc.params!.name!, rpc.params?.arguments ?? {});
        onRead?.(rpc.params!.name!);
        onTool?.({ ...call, status: 'completed', finishedAt: new Date().toISOString(), summary: projectToolSummary(call.name, data) });
        result({ content: [{ type: 'text', text: JSON.stringify(data) }] });
      } catch {
        onTool?.({ ...call, status: 'failed', finishedAt: new Date().toISOString(), summary: 'Unable to inspect this path. Check the path, access restrictions and file limits.' });
        result({ isError: true, content: [{ type: 'text', text: 'Cannot read this project path with those arguments. Use project-relative paths, valid line ranges and regular text files. Secrets, symlinks, paths outside the project and files over 1 MB are excluded.' }] });
      }
      return;
    }
    if (rpc.method === 'tools/list') { result({ tools: [{ name: 'ask_user', description: 'Ask the human 1–3 focused planning questions, optionally with choices. Free text is always allowed. This queues questions in the UI, not a human answer. After success, end your turn and wait for the next user message. Never assume an answer or proceed to implementation.', inputSchema: z.toJSONSchema(askSchema) }, ...(project?.definitions ?? [])] }); return; }
    if (rpc.method === 'tools/call' && rpc.params?.name === 'ask_user') {
      const parsed = askSchema.safeParse(rpc.params.arguments);
      if (!parsed.success || asked) { result({ isError: true, content: [{ type: 'text', text: asked ? 'Questions already queued. End this turn and wait for the user.' : 'Invalid questions: provide 1–3 questions, each with optional 2–4 short choices.' }] }); return; }
      try { onAsk(parsed.data.questions); asked = true; }
      catch { result({ isError: true, content: [{ type: 'text', text: 'Unable to queue questions. End the turn and report the failure.' }] }); return; }
      const now = new Date().toISOString();
      onTool?.({ id: randomUUID(), name: 'ask_user', status: 'completed', input: {}, summary: `${parsed.data.questions.length} questions shown; waiting for your answer`, startedAt: now, finishedAt: now });
      result({ content: [{ type: 'text', text: 'Questions saved and shown to the user. No answer yet. End your turn now with PLAN_QUESTIONS. The next user turn will contain their answer; do not invent it or produce a ready plan.' }] }); return;
    }
    json({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not found' } });
  });
  server.requestTimeout = 5000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to start question tool');
  return { url: `http://127.0.0.1:${address.port}/mcp/${token}`, close: () => { server.closeAllConnections(); server.close(); } };
}
