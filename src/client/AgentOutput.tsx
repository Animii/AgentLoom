import { memo } from 'react';
import { Streamdown, defaultRehypePlugins, type Components } from 'streamdown';

// Use semantic elements and local CSS; no Tailwind runtime or generated content actions.
// Keep provider HTML inert and preserve the existing no-external-resource policy.
const components: Components = {
  h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h5', h6: 'h6',
  p: 'p', ul: 'ul', ol: 'ol', li: 'li', blockquote: 'blockquote',
  strong: 'strong', em: 'em', del: 'del',
  pre: 'pre', code: 'code', inlineCode: ({ children }) => <code>{children}</code>, hr: 'hr',
  table: ({ children }) => <div className="markdown-table-scroll" role="region" aria-label="Markdown table" tabIndex={0}><table>{children}</table></div>,
  thead: 'thead', tbody: 'tbody', tr: 'tr',
  th: ({ children, style }) => <th scope="col" style={{ textAlign: style?.textAlign }}>{children}</th>,
  td: ({ children, style }) => <td style={{ textAlign: style?.textAlign }}>{children}</td>,
  a: ({ children }) => <span>{children}</span>,
  img: ({ alt }) => <span>{alt ?? ''}</span>,
};
const safePlugins = [defaultRehypePlugins.sanitize, defaultRehypePlugins.harden];

function AgentOutput({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return <Streamdown className="agent-output" mode={streaming ? 'streaming' : 'static'}
    isAnimating={streaming} parseIncompleteMarkdown={streaming} components={components}
    controls={false} skipHtml rehypePlugins={safePlugins}>{text}</Streamdown>;
}

export default memo(AgentOutput);
