import { useEffect, useId, useRef, useState } from 'react';
import type { PlanningQuestion } from '../shared/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

interface Answer {
  selected: string[];
  custom: string;
  customActive: boolean;
}
const empty = (): Answer => ({ selected: [], custom: '', customActive: false });

export default function PlanningQuestions({
  storageKey,
  questions,
  disabled,
  onSubmit,
}: {
  storageKey: string;
  questions: PlanningQuestion[];
  disabled: boolean;
  onSubmit: (text: string) => Promise<boolean>;
}) {
  const [answers, setAnswers] = useState<Answer[]>(() => {
    try {
      const saved: unknown = JSON.parse(
        sessionStorage.getItem(storageKey) ?? 'null',
      );
      if (
        Array.isArray(saved) &&
        saved.length === questions.length &&
        saved.every(
          (a: unknown): a is Answer =>
            isRecord(a) &&
            Array.isArray(a.selected) &&
            a.selected.every((s: unknown) => typeof s === 'string') &&
            typeof a.custom === 'string' &&
            typeof a.customActive === 'boolean',
        )
      )
        return saved;
    } catch {
      /* Storage may be unavailable. */
    }
    return questions.map(empty);
  });
  const [index, setIndex] = useState(0);
  const [sending, setSending] = useState(false);
  const answerId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const question = questions[index];
  const answer = answers[index];
  const locked = disabled || sending;
  const value = (a: Answer) =>
    a.customActive ? a.custom.trim() : a.selected.join(', ');
  const complete = answers.every((a) => value(a));
  const options = (question.options ?? []).map((o) =>
    typeof o === 'string' ? { label: o } : o,
  );

  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(answers));
    } catch {
      /* Best effort draft. */
    }
  }, [answers, storageKey]);
  useEffect(() => {
    heading.current?.focus();
  }, [index]);

  function update(next: Answer) {
    setAnswers((previous) => previous.map((a, i) => (i === index ? next : a)));
  }
  function select(label: string) {
    if (locked) return;
    update({
      ...answer,
      customActive: false,
      selected: question.multiSelect
        ? answer.selected.includes(label)
          ? answer.selected.filter((s) => s !== label)
          : [...answer.selected, label]
        : [label],
    });
    if (!question.multiSelect && index < questions.length - 1)
      setIndex(index + 1);
  }
  async function submit() {
    if (locked || !complete) return;
    setSending(true);
    try {
      if (
        await onSubmit(
          questions
            .map((q, i) => `${q.question}\nAnswer: ${value(answers[i])}`)
            .join('\n\n'),
        )
      ) {
        try {
          sessionStorage.removeItem(storageKey);
        } catch {
          /* Storage may be unavailable. */
        }
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <section
      className="planning-questions"
      aria-label="Planner questions"
      onKeyDown={(event) => {
        if (
          locked ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.target instanceof HTMLTextAreaElement ||
          event.target instanceof HTMLInputElement
        )
          return;
        const pressed = Number(event.key);
        const option =
          Number.isInteger(pressed) && pressed >= 1 && pressed <= options.length
            ? options.at(pressed - 1)
            : undefined;
        if (option) {
          event.preventDefault();
          select(option.label);
        }
      }}
    >
      <div className="question-topline">
        <strong>{question.header ?? 'Your input'}</strong>
        <span aria-live="polite">
          Question {index + 1} of {questions.length}
        </span>
      </div>
      <h3 ref={heading} tabIndex={-1}>
        {question.question}
      </h3>
      {question.multiSelect && (
        <p className="field-helper">Choose all that apply, then continue.</p>
      )}
      <div className="question-options">
        {options.map((option, i) => (
          <button
            type="button"
            className="question-option"
            key={option.label}
            disabled={locked}
            aria-pressed={
              !answer.customActive && answer.selected.includes(option.label)
            }
            onClick={() => {
              select(option.label);
            }}
          >
            <span>
              <strong>{option.label}</strong>
              {option.recommended && (
                <span className="question-recommended">Recommended</span>
              )}
              {option.description && <small>{option.description}</small>}
            </span>
            <kbd>
              {!answer.customActive && answer.selected.includes(option.label)
                ? '✓'
                : i + 1}
            </kbd>
          </button>
        ))}
      </div>
      {options.length > 0 && (
        <button
          type="button"
          className="button button-ghost question-custom"
          aria-pressed={answer.customActive}
          disabled={locked}
          onClick={() => {
            update({ ...answer, customActive: !answer.customActive });
          }}
        >
          Write my own answer
        </button>
      )}
      {(answer.customActive || !options.length) && (
        <div className="question-custom-field">
          <label htmlFor={answerId}>Your answer</label>
          <textarea
            id={answerId}
            rows={3}
            maxLength={1800}
            value={answer.custom}
            disabled={locked}
            placeholder="Tell the planner what you have in mind…"
            onChange={(event) => {
              update({
                ...answer,
                customActive: true,
                custom: event.target.value,
              });
            }}
          />
        </div>
      )}
      <div className="question-navigation">
        <button
          className="button button-secondary"
          type="button"
          disabled={locked || index === 0}
          onClick={() => {
            setIndex(index - 1);
          }}
        >
          Back
        </button>
        {index < questions.length - 1 ? (
          <button
            className="button button-primary"
            type="button"
            disabled={locked || !value(answer)}
            onClick={() => {
              setIndex(index + 1);
            }}
          >
            Next question
          </button>
        ) : (
          <button
            className="button button-primary"
            type="button"
            disabled={locked || !complete}
            onClick={() => void submit()}
          >
            {sending ? 'Sending…' : 'Submit answers'}
          </button>
        )}
      </div>
      <p className="field-helper">
        {index === questions.length - 1
          ? 'Review earlier answers with Back. Nothing is sent until you submit.'
          : 'Select an option or write your own answer. Number keys select options.'}
      </p>
    </section>
  );
}
