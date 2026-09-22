import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import AgentOutput from '../src/client/AgentOutput.js';

void test('agent output renders readable text without interpreting provider HTML or links', () => {
  const text =
    '# Review\n\n**Ready** to inspect `src/main.ts`.\n\n<img src=x onerror=alert(1)>\n[click](javascript:alert(1))\n\n```html\n<script>alert(1)</script>\n```';
  const html = renderToStaticMarkup(createElement(AgentOutput, { text }));
  assert.match(html, /<h1>Review<\/h1>/);
  assert.match(html, /<strong>Ready<\/strong>/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<(?:img|script|a)\b/);
});

void test('streamed output with an unfinished code block keeps all code visible', () => {
  const html = renderToStaticMarkup(
    createElement(AgentOutput, {
      text: '```js\nconst value = 1;\n  value + 2;',
    }),
  );
  assert.match(html, /const value = 1;\n {2}value \+ 2;/);
});
