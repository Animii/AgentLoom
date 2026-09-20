import type { PlanningToolCall, RunEvent } from '../shared/types';
import StreamingReply from './StreamingReply';
import ToolCalls from './ToolCalls';

export function toolGroups(text: string, calls: PlanningToolCall[], events: RunEvent[], since: string) {
  const groups = new Map<number, PlanningToolCall[]>();
  for (const call of calls) {
    let offset = call.outputOffset;
    if (offset === undefined) {
      // Recover text boundaries for calls saved before offsets were recorded.
      offset = 0;
      for (const event of events) {
        if (event.type !== 'output' || event.timestamp < since || event.timestamp > call.startedAt) continue;
        const position = text.indexOf(event.message, offset);
        if (position >= 0) offset = position + event.message.length;
      }
    }
    offset = Math.max(0, Math.min(text.length, offset));
    const group = groups.get(offset) ?? [];
    group.push(call); groups.set(offset, group);
  }
  return [...groups].sort(([left], [right]) => left - right);
}

export default function ReplyWithTools({ text, calls, events, since, live, running, activeSince }: {
  text: string; calls: PlanningToolCall[]; events: RunEvent[]; since: string;
  live: boolean; running: boolean; activeSince: string | null;
}) {
  let cursor = 0;
  const groups = toolGroups(text, calls, events, since);
  return <>{groups.map(([offset, group]) => {
    const segment = text.slice(cursor, offset); cursor = offset;
    return <div key={group[0].id} className="reply-tool-segment">
      {segment && <StreamingReply text={segment} active={false} />}
      <ToolCalls calls={group} running={running} activeSince={activeSince} />
    </div>;
  })}<StreamingReply text={text.slice(cursor)} active={live} /></>;
}
