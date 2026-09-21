import ReplyWithTools from './ReplyWithTools';
import { isPlanningStep } from '../shared/planning';
import { stepToolCalls } from '../shared/native-tools';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Run, StepRun, RunEvent, PlanningToolCall } from '../shared/types';
import AgentOutput from './AgentOutput';
import PlanningQuestions from './PlanningQuestions';
import StreamingReply from './StreamingReply';
import ToolCalls from './ToolCalls';

export default function PlanningChat({ run, step, current, busy, events, onSend, draftSuggestion }: {
  run: Run; step: StepRun; current: boolean; busy: boolean;
  events: RunEvent[];
  draftSuggestion?: {text:string;nonce:number} | null;
  onSend: (stepId: string, text: string, messageId: string) => Promise<void>;
}) {
  const planning = isPlanningStep(step.definition);
  const draftKey = `agentloom-chat-${run.id}-${step.definition.id}`;
  const [draft, setDraft] = useState(() => { try { return sessionStorage.getItem(draftKey) ?? ''; } catch { return ''; } });
  useEffect(() => { try { if (draft) sessionStorage.setItem(draftKey, draft); else sessionStorage.removeItem(draftKey); } catch { /* Storage may be unavailable. */ } }, [draftKey, draft]);
  const scroll = useRef<HTMLDivElement>(null);
  const contentBox = useRef<HTMLOListElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (draftSuggestion) { setDraft(draftSuggestion.text); composer.current?.focus(); } }, [draftSuggestion]);
  const following = useRef(true);
  const lastScrollTop = useRef(0);
  const [away, setAway] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<{ id: string; content: string } | null>(null);
  const [chatInstead, setChatInstead] = useState<string | null>(null);
  const working = current && ['queued', 'running'].includes(run.status);
  const published = Boolean(run.git?.publishing || (run.git?.prUrl && !run.crate?.updatingPr) || run.crate?.join==='waiting');
  const canSend = !published && step.status !== 'pending' && !busy && ['waiting_input', 'waiting_approval', 'blocked', 'completed'].includes(run.status);
  const messages = step.conversation ?? [
    { id: 'task', role: 'user' as const, content: run.task, createdAt: run.createdAt },
    ...(step.output && !working ? [{ id: 'previous', role: 'assistant' as const, content: step.output, createdAt: step.finishedAt ?? run.updatedAt }] : []),
  ];

  const pending = current ? messages.find(item => item.id === step.pendingAskId && item.questions) : undefined;
  const calls: PlanningToolCall[] = stepToolCalls(step, events).map(call => ({ ...call, turnId: call.turnId ?? messages.findLast(item => item.role === 'user' && item.createdAt <= call.startedAt)?.id }));
  for (const event of events) {
    if (event.stepId !== step.definition.id) continue;
    const name = /^Planner used (ask_user|list_project_files|read_project_file|search_project)[. (]/.exec(event.message)?.[1];
    if (!name || calls.some(call => call.name === name && Math.abs(Date.parse(call.finishedAt ?? call.startedAt) - Date.parse(event.timestamp)) < 2000)) continue;
    calls.push({ id: `legacy-${event.id}`, name, status: 'completed', input: {}, summary: 'Recorded in activity. Detailed arguments were not saved for this call.', startedAt: event.timestamp,
      turnId: messages.findLast(item => item.role === 'user' && item.createdAt <= event.timestamp)?.id });
  }
  const firstUser = messages.find(item => item.role === 'user')?.id;

  const visibleMessages = messages.filter(item => item.id !== pending?.id);
  let userId = 'initial';
  let assistantIndex = 0;
  const rows = visibleMessages.map(item => {
    if (item.role === 'user') { userId = item.id; assistantIndex = 0; return { ...item, turnId: userId, renderKey: item.id }; }
    return { ...item, turnId: userId, renderKey: `reply-${userId}-${assistantIndex++}` };
  });
  const liveKey = `reply-${userId}-${assistantIndex}`;
  const liveText = step.output.replace(/(?:\n|^)(?:P|PL|PLA|PLAN(?:_[A-Z_]*)?)\s*$/, '');
  const showLive = working && !step.pendingAskId;
  const renderedRows = [...rows.map(item => ({ ...item, live: false })), ...(showLive ? [{
    id: 'live', turnId: userId, role: 'assistant' as const, content: liveText, createdAt: run.updatedAt, renderKey: liveKey, live: true,
  }] : [])];
  function latest() {
    following.current = true; setAway(false);
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      if (following.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    });
    if (contentBox.current) observer.observe(contentBox.current);
    if (scroll.current) observer.observe(scroll.current);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (following.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [step.output, messages.length, pending?.id]);
  useLayoutEffect(() => {
    if (composer.current) {
      composer.current.style.height = 'auto';
      composer.current.style.height = `${Math.min(160, composer.current.scrollHeight)}px`;
    }
  }, [draft]);

  async function send(text = draft) {
    const content = text.trim();
    if (!canSend || !content) return false;
    setError(null);
    latest();
    if (request.current?.content !== content) request.current = { id: crypto.randomUUID(), content };
    try {
      await onSend(step.definition.id, content, request.current.id);
      if (text === draft) setDraft('');
      request.current = null;
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not send the message. Try again.');
      return false;
    }
  }

  return <section className={`planning-chat${pending ? ' has-questions' : ''}`} aria-label={planning ? 'Planning conversation' : `${step.definition.name} conversation`}>
    <div className="chat-scroll" ref={scroll} aria-label="Conversation history" tabIndex={0} onScroll={() => {
      const element = scroll.current;
      if (!element) return;
      const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 72;
      if (atBottom) following.current = true;
      else if (element.scrollTop < lastScrollTop.current - 2) following.current = false;
      lastScrollTop.current = element.scrollTop;
      setAway(!following.current);
    }}>
    <ol className="chat-messages" ref={contentBox}>
      {renderedRows.map(item => <li key={item.renderKey} className={`chat-message chat-${item.role}${item.live ? ' chat-partial' : ''}`}>
        <div className="chat-message-meta"><strong>{item.role === 'user' ? 'You' : `${planning ? 'Planner' : step.definition.name} · ${step.definition.provider}`}</strong></div>
        {item.role === 'assistant' ? <ReplyWithTools text={item.content} live={item.live} calls={renderedRows.find(row => row.role === 'assistant' && row.turnId === item.turnId)?.id === item.id ? calls.filter(call => (call.turnId ?? firstUser) === item.turnId) : []} events={events.filter(event => event.stepId === step.definition.id)} since={messages.find(message => message.id === item.turnId)?.createdAt ?? run.createdAt} running={working} activeSince={step.startedAt} /> : <AgentOutput text={item.content} />}
        {item.role === 'user' && !renderedRows.some(row => row.role === 'assistant' && row.turnId === item.id) && <ToolCalls calls={calls.filter(call => (call.turnId ?? firstUser) === item.id)} running={working && item.id === messages.findLast(message => message.role === 'user')?.id} activeSince={step.startedAt} />}
      </li>)}

    </ol>
    </div>
    {away && <button className="button chat-jump" type="button" onClick={latest}>Jump to latest ↓</button>}
    <div className="chat-dock">
    {pending?.questions && <PlanningQuestions key={pending.id} storageKey={`agentloom-ask-${run.id}-${pending.id}`} questions={pending.questions} disabled={!canSend} onSubmit={send} />}
    {pending && <button className="button button-ghost" type="button" onClick={() => setChatInstead(chatInstead === pending.id ? null : pending.id)}>{chatInstead === pending.id ? 'Hide chat reply' : 'Reply in chat instead'}</button>}
    {error && <p role="alert" className="error-banner">{error}</p>}
    {run.status !== 'cancelled' ? <form hidden={Boolean(pending && chatInstead !== pending.id)} className="chat-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
      <label className="sr-only" htmlFor={`planning-message-${step.definition.id}`}>{planning ? 'Message the planner' : `Message ${step.definition.name}`}</label>
      <textarea ref={composer} id={`planning-message-${step.definition.id}`} rows={2} maxLength={8000} value={draft} disabled={busy || published} placeholder={planning ? 'Message the planner…' : `Message ${step.definition.name}…`} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
      <div className="composer-context"><span>{step.execution?.model || step.definition.model || step.definition.provider}</span><span>{step.execution?.effort || step.definition.effort || 'Default effort'}</span><span>Full access</span></div>
      <div className="chat-composer-actions"><button className="button button-primary" disabled={!canSend || !draft.trim()} type="submit">{busy ? 'Sending…' : 'Send message'}</button><span className="field-helper">{working ? 'Replying · you can draft your next message' : 'Enter to send · Shift + Enter for a new line'}</span></div>
      {['failed', 'interrupted'].includes(run.status) && <p className="field-helper">Retry the step below to continue. Your conversation is saved.</p>}
    </form> : <p className="field-helper">This conversation is saved with the run and is now read-only.</p>}
    </div>
    <p className="chat-footnote">{step.definition.validation ? 'Messages rerun these same approved commands. Change requirements by returning to the planning step.' : published ? 'This run is publishing or has a PR. Start a new run for follow-up work.' : step.status === 'pending' ? 'This step has not started yet.' : !current ? 'Sending a follow-up reopens this step. Later steps and their approvals will need to run again.' : planning ? 'The next step starts only after you approve the plan.' : 'Sending a message continues this step. Approval is a separate action.'}</p>
  </section>;
}
