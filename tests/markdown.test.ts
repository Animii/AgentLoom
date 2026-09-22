import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import AgentOutput from '../src/client/AgentOutput';

void test('Markdown renders semantic tables, inline code, lists and unfinished streamed rows', () => {
  const markdown =
    '| Area | Location | Behavior |\n| --- | --- | --- |\n| Tool | `src/ask.ts` | **Choices** |\n| UI | `src/chat.ts` | Partial';
  for (const streaming of [false, true]) {
    const html = renderToStaticMarkup(
      createElement(AgentOutput, { text: markdown, streaming }),
    );
    assert.match(html, /<table>/);
    assert.equal((html.match(/<th /g) ?? []).length, 3);
    assert.match(html, /<code>src\/ask.ts<\/code>/);
    assert.match(html, /<strong>Choices<\/strong>/);
    assert.match(html, /Partial/);
  }
  const html = renderToStaticMarkup(
    createElement(AgentOutput, {
      text: '1. First\n2. Second\n\n> Quoted\n\n```ts\nconst n = 1;\n```',
    }),
  );
  assert.match(html, /<ol>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /<pre>/);
});

void test('generated Markdown cannot execute HTML or load external resources', () => {
  const text =
    '<script>alert(1)</script>\n\n<img src="https://example.com/tracker" onerror="alert(1)">\n\n![Tracking](https://example.com/pixel)\n\n[Execute](javascript:alert(1))\n\n[Website](https://example.com)';
  const html = renderToStaticMarkup(createElement(AgentOutput, { text }));
  assert.doesNotMatch(
    html,
    /<(script|img|iframe)\b|<[^>]+\s(?:onerror|href|src)=/i,
  );
  assert.match(html, /Tracking/);
  assert.match(html, /Website/);
});
