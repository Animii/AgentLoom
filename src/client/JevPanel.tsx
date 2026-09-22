import { useCallback, useEffect, useState } from 'react';
import type { ReactNode, SubmitEvent } from 'react';

type JevSource = 'saved' | 'environment' | 'none';
type JevQuestionType = 'noul' | 'choice' | 'score';
type JevAction = 'save' | 'remove' | 'test' | 'evaluate';
type Criteria = Record<string, string> | string[];

interface JevSettings {
  configured: boolean;
  source: JevSource;
}
interface JevQuestionPayload {
  type: JevQuestionType;
  instructions: string;
  criteria?: Criteria;
}
interface EvaluatorState {
  state: string;
  question: string;
  type: JevQuestionType;
  model: string;
  options: string;
  scale: string;
}

const DEFAULT_QUESTION =
  'Does this text describe a task blocked by missing requirements?';
const DEFAULT_OPTIONS =
  'authentication\ntimeout\nrequirements\ntest failure\nother';
const DEFAULT_SCALE = 'Low\nMedium\nHigh';
const NETWORK_ERROR =
  'Could not reach the local server. Check that it is running and try again.';
const UNEXPECTED = 'The server returned an unexpected response.';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

class ApiError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function describe(error: unknown): string {
  return error instanceof ApiError ? error.message : NETWORK_ERROR;
}

function trimLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

async function parseBody(response: Response): Promise<unknown> {
  try {
    if (typeof response.text === 'function') {
      const text = await response.text();
      if (text !== '') return JSON.parse(text) as unknown;
    }
  } catch {
    /* Fall through to response.json() when the body cannot be read as text. */
  }
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

async function requestJson(url: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new ApiError(NETWORK_ERROR);
  }
  const body = await parseBody(response);
  if (response.ok) return body;
  if (isRecord(body) && typeof body.error === 'string' && body.error !== '')
    throw new ApiError(body.error);
  throw new ApiError(`Request failed (HTTP ${String(response.status)}).`);
}

function parseSettings(value: unknown): JevSettings {
  if (!isRecord(value)) throw new ApiError(UNEXPECTED);
  const source: JevSource =
    value.source === 'saved' || value.source === 'environment'
      ? value.source
      : 'none';
  return { configured: value.configured === true, source };
}

function statusLabel(settings: JevSettings): string {
  if (settings.source === 'saved') return 'API key saved';
  if (settings.source === 'environment') return 'Using environment API key';
  return 'No API key configured';
}

function verifiedLabel(value: unknown): string {
  const model = isRecord(value) ? value.model : undefined;
  return typeof model === 'string' && model !== ''
    ? `Connection verified (${model})`
    : 'Connection verified.';
}

function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
    </div>
  );
}

export default function JevPanel() {
  const [settings, setSettings] = useState<JevSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [pending, setPending] = useState<JevAction | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [testSuccess, setTestSuccess] = useState<string | null>(null);
  const [evalError, setEvalError] = useState<string | null>(null);
  const [evalResult, setEvalResult] = useState<string | null>(null);
  const [evaluation, setEvaluation] = useState<EvaluatorState>({
    state: '',
    question: DEFAULT_QUESTION,
    type: 'noul',
    model: 'jev-latest',
    options: DEFAULT_OPTIONS,
    scale: DEFAULT_SCALE,
  });

  const configured = settings?.configured === true;
  const saved = settings?.source === 'saved';
  const evaluating = pending === 'evaluate';
  const evaluateDisabled =
    pending !== null ||
    !configured ||
    evaluation.state.trim() === '' ||
    evaluation.question.trim() === '';

  const loadSettings = useCallback(async (): Promise<void> => {
    setSettingsLoading(true);
    try {
      setSettings(parseSettings(await requestJson('/api/jev/settings')));
      setSettingsError(null);
    } catch (error) {
      setSettingsError(describe(error));
    } finally {
      setSettingsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  async function handleSave(
    event: SubmitEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    setPending('save');
    setSaveError(null);
    try {
      await requestJson('/api/jev/settings', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ apiKey }),
      });
      setApiKey('');
      setTestError(null);
      setTestSuccess(null);
      await loadSettings();
    } catch (error) {
      setSaveError(describe(error));
    } finally {
      setPending(null);
    }
  }

  async function handleRemove(): Promise<void> {
    setPending('remove');
    setSaveError(null);
    try {
      await requestJson('/api/jev/settings', { method: 'DELETE' });
      setTestError(null);
      setTestSuccess(null);
      await loadSettings();
    } catch (error) {
      setSaveError(describe(error));
    } finally {
      setPending(null);
    }
  }

  async function handleTest(): Promise<void> {
    setPending('test');
    setTestError(null);
    setTestSuccess(null);
    try {
      const data = await requestJson('/api/jev/test', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: '{}',
      });
      setTestSuccess(verifiedLabel(data));
    } catch (error) {
      setTestError(describe(error));
    } finally {
      setPending(null);
    }
  }

  async function sendEvaluation(criteria: Criteria | undefined): Promise<void> {
    const payload: JevQuestionPayload = {
      type: evaluation.type,
      instructions: evaluation.question.trim(),
    };
    if (criteria !== undefined) payload.criteria = criteria;
    setPending('evaluate');
    try {
      const data = await requestJson('/api/jev/evaluate', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          state: evaluation.state,
          model: evaluation.model,
          questions: { assessment: payload },
        }),
      });
      setEvalResult(JSON.stringify(data, null, 2));
    } catch (error) {
      setEvalError(describe(error));
    } finally {
      setPending(null);
    }
  }

  async function handleEvaluate(
    event: SubmitEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    setEvalError(null);
    setEvalResult(null);
    let criteria: Criteria | undefined;
    if (evaluation.type === 'choice') {
      const lines = [...new Set(trimLines(evaluation.options))];
      if (lines.length < 2 || lines.length > 255) {
        setEvalError('Options must be 2 to 255 unique, non-empty lines.');
        return;
      }
      criteria = Object.fromEntries(
        lines.map((line): [string, string] => [line, line]),
      );
    } else if (evaluation.type === 'score') {
      const levels = trimLines(evaluation.scale);
      if (levels.length < 2 || levels.length > 10) {
        setEvalError('Scale levels must be 2 to 10 non-empty lines.');
        return;
      }
      criteria = levels;
    }
    await sendEvaluation(criteria);
  }

  return (
    <section className="jev-panel" aria-label="Jev settings">
      <h2>Jev (TypeSafe)</h2>
      <p className="providers-hint">
        Optional scoring and classification. Jev does not approve workflow
        steps.
      </p>
      <p className="provider-meta">
        {settingsLoading
          ? 'Checking Jev configuration…'
          : settings === null
            ? 'Jev configuration unavailable.'
            : statusLabel(settings)}
      </p>

      {settingsError !== null && (
        <p className="alert" role="alert">
          {settingsError}
        </p>
      )}
      {saveError !== null && (
        <p className="wf-message" role="alert">
          {saveError}
        </p>
      )}
      {testError !== null && (
        <p className="wf-message" role="alert">
          {testError}
        </p>
      )}
      {testSuccess !== null && <p className="wf-message">{testSuccess}</p>}

      <details className="jev-settings">
        <summary>API key and connection</summary>
        <form
          className="wf-form"
          onSubmit={(event) => {
            void handleSave(event);
          }}
          aria-label="Jev API key settings"
        >
          <Field id="jev-api-key" label="Jev API key">
            <input
              id="jev-api-key"
              type="password"
              value={apiKey}
              autoComplete="off"
              spellCheck={false}
              disabled={pending === 'save'}
              placeholder={saved ? 'Enter a new key to replace' : undefined}
              onChange={(event) => {
                setApiKey(event.target.value);
              }}
            />
            <span className="field-helper">
              Stored encrypted in the local server data volume. The local
              encryption key lives in the same volume.
            </span>
            <span className="field-helper">
              <a
                href="https://console.typesafe.ai"
                target="_blank"
                rel="noreferrer"
              >
                Get a TypeSafe API key
              </a>
            </span>
          </Field>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flexWrap: 'wrap',
            }}
          >
            <button
              type="submit"
              className="button button-primary"
              disabled={settingsLoading || pending !== null}
            >
              {pending === 'save' ? 'Saving…' : 'Save API key'}
            </button>
            <button
              type="button"
              className="button"
              disabled={!saved || settingsLoading || pending !== null}
              onClick={() => void handleRemove()}
            >
              {pending === 'remove' ? 'Removing…' : 'Remove saved key'}
            </button>
            <button
              type="button"
              className="button"
              disabled={!configured || settingsLoading || pending !== null}
              onClick={() => void handleTest()}
            >
              {pending === 'test' ? 'Testing…' : 'Test connection'}
            </button>
          </div>
          <p className="field-helper">
            Test connection sends a small sample to TypeSafe and may count
            toward your usage.
          </p>
        </form>
      </details>
      <details className="jev-evaluator">
        <summary>Try an evaluation</summary>
        <form
          className="wf-form"
          onSubmit={(event) => {
            void handleEvaluate(event);
          }}
          aria-label="Evaluate with Jev"
        >
          <Field id="jev-state" label="Text to evaluate">
            <textarea
              id="jev-state"
              value={evaluation.state}
              disabled={evaluating}
              onChange={(event) => {
                setEvaluation((previous) => ({
                  ...previous,
                  state: event.target.value,
                }));
              }}
            />
          </Field>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 16,
            }}
          >
            <Field id="jev-question" label="Question">
              <textarea
                id="jev-question"
                value={evaluation.question}
                disabled={evaluating}
                onChange={(event) => {
                  setEvaluation((previous) => ({
                    ...previous,
                    question: event.target.value,
                  }));
                }}
              />
            </Field>
            <Field id="jev-question-type" label="Question type">
              <select
                id="jev-question-type"
                value={evaluation.type}
                disabled={evaluating}
                onChange={(event) => {
                  setEvaluation((previous) => ({
                    ...previous,
                    type: event.target.value as JevQuestionType,
                  }));
                }}
              >
                <option value="noul">Probability (Noul)</option>
                <option value="choice">Choose an option</option>
                <option value="score">Score a scale</option>
              </select>
            </Field>
            <Field id="jev-model" label="Jev model">
              <input
                id="jev-model"
                value={evaluation.model}
                disabled={evaluating}
                onChange={(event) => {
                  setEvaluation((previous) => ({
                    ...previous,
                    model: event.target.value,
                  }));
                }}
              />
            </Field>
          </div>
          {evaluation.type === 'choice' && (
            <Field id="jev-options" label="Options (one per line)">
              <textarea
                id="jev-options"
                value={evaluation.options}
                disabled={evaluating}
                onChange={(event) => {
                  setEvaluation((previous) => ({
                    ...previous,
                    options: event.target.value,
                  }));
                }}
              />
            </Field>
          )}
          {evaluation.type === 'score' && (
            <Field id="jev-scale" label="Scale levels (low to high)">
              <textarea
                id="jev-scale"
                value={evaluation.scale}
                disabled={evaluating}
                onChange={(event) => {
                  setEvaluation((previous) => ({
                    ...previous,
                    scale: event.target.value,
                  }));
                }}
              />
            </Field>
          )}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              flexWrap: 'wrap',
            }}
          >
            <button
              type="submit"
              className="button button-primary"
              disabled={evaluateDisabled}
            >
              {evaluating ? 'Evaluating…' : 'Evaluate'}
            </button>
            <span className="field-helper">
              Evaluate sends the text above to TypeSafe.
              {configured ? '' : ' Add an API key above to enable evaluation.'}
            </span>
          </div>
          {evalError !== null && (
            <p className="wf-message" role="alert">
              {evalError}
            </p>
          )}
          {evalResult !== null && (
            <div className="field">
              <p className="field-helper">
                Advisory only: Jev results never approve handoffs or change your
                workflows.
              </p>
              <p className="provider-meta" id="jev-result-label">
                Jev result
              </p>
              <pre
                aria-labelledby="jev-result-label"
                style={{
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                }}
              >
                <code>{evalResult}</code>
              </pre>
            </div>
          )}
        </form>
      </details>
    </section>
  );
}
