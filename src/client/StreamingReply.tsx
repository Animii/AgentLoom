import { useEffect, useRef, useState } from 'react';
import AgentOutput from './AgentOutput';

// Never invent tokens: ease only text already received, with a short bounded catch-up.
export default function StreamingReply({
  text,
  active,
}: {
  text: string;
  active: boolean;
}) {
  const [visible, setVisible] = useState(text);
  const shown = useRef(text);
  const target = useRef(text);
  target.current = text;
  useEffect(() => {
    if (
      !active ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
      !text.startsWith(shown.current)
    ) {
      shown.current = text;
      setVisible(text);
      return;
    }
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const remaining = target.current.length - shown.current.length;
      if (remaining <= 0) return;
      const elapsed = Math.min(64, now - last);
      last = now;
      const count = Math.max(1, Math.ceil((remaining * elapsed) / 90));
      let end = Math.min(target.current.length, shown.current.length + count);
      // Keep UTF-16 surrogate pairs together.
      if (
        end < target.current.length &&
        /[\uD800-\uDBFF]/.test(target.current[end - 1])
      )
        end++;
      shown.current = target.current.slice(0, end);
      setVisible(shown.current);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [text, active]);
  return (
    <div
      className={active ? 'streaming-reply is-streaming' : 'streaming-reply'}
    >
      <AgentOutput text={active ? visible : text} streaming={active} />
      {active && !text && (
        <span className="chat-thinking" role="status">
          <span className="chat-pulse" />
          Thinking…
        </span>
      )}
    </div>
  );
}
