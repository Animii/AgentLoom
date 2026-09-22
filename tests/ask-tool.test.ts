import test from 'node:test';
import assert from 'node:assert/strict';
import { createAskTool, askSchema } from '../src/server/ask-tool.js';

interface RpcResponse {
  result: {
    protocolVersion?: string;
    tools?: { name: string }[];
    isError?: boolean;
    content: { text: string }[];
  };
}

void test('question tool supports described choices, recommendations and multiple selections', () => {
  const input = {
    questions: [
      {
        header: 'Audience',
        question: 'Who is it for?',
        multiSelect: true,
        options: [
          {
            label: 'Developers',
            description: 'Focus on local development.',
            recommended: true,
          },
          { label: 'Players', description: 'Focus on the game.' },
        ],
      },
    ],
  };
  assert.deepEqual(askSchema.parse(input), input);
  assert.equal(
    askSchema.safeParse({
      questions: [{ question: 'Why?', options: [{ label: '' }, 'Valid'] }],
    }).success,
    false,
  );
});

void test('real MCP tool discovery, validation, one question batch and turn isolation', async () => {
  const calls: unknown[] = [];
  const tool = await createAskTool((q) => calls.push(q));
  const other = await createAskTool(() => {
    throw Error('wrong turn');
  });
  const rpc = async (
    method: string,
    params: unknown = {},
  ): Promise<RpcResponse> => {
    const response = await fetch(tool.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return (await response.json()) as RpcResponse;
  };
  try {
    assert.equal(
      (await rpc('initialize', { protocolVersion: '2025-03-26' })).result
        .protocolVersion,
      '2025-03-26',
    );
    assert.equal((await rpc('tools/list')).result.tools?.[0]?.name, 'ask_user');
    assert.equal(
      (
        await rpc('tools/call', {
          name: 'ask_user',
          arguments: { questions: [] },
        })
      ).result.isError,
      true,
    );
    assert.equal(
      (
        await fetch(tool.url, {
          method: 'POST',
          headers: { origin: 'https://evil.example' },
          body: '{}',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(tool.url.replace(/[^/]+$/, 'wrong'), {
          method: 'POST',
          body: '{}',
        })
      ).status,
      403,
    );
    assert.equal((await fetch(tool.url)).status, 405);
    const answer = await rpc('tools/call', {
      name: 'ask_user',
      arguments: {
        questions: [
          { question: 'Audience?', options: ['Developers', 'Players'] },
        ],
      },
    });
    assert.match(answer.result.content[0].text, /No answer yet/);
    assert.equal(calls.length, 1);
    assert.equal(
      (
        await rpc('tools/call', {
          name: 'ask_user',
          arguments: { questions: [{ question: 'Again?' }] },
        })
      ).result.isError,
      true,
    );
    assert.equal(calls.length, 1);
    assert.notEqual(tool.url, other.url);
  } finally {
    tool.close();
    other.close();
  }
  await assert.rejects(fetch(tool.url));
});

void test('unexpected callback failures return a generic HTTP error without an unhandled rejection', async () => {
  const tool = await createAskTool(
    () => {},
    undefined,
    undefined,
    () => {
      throw new Error('boom');
    },
  );
  try {
    const response = await fetch(tool.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'ask_user',
          arguments: { questions: [{ question: 'Audience?' }] },
        },
      }),
    });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'Internal error' });
    const followUp = await fetch(tool.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'ping',
        params: {},
      }),
    });
    assert.equal(followUp.status, 200);
  } finally {
    tool.close();
  }
});
