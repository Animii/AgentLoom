import { Fragment, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import {
  isValidModelId,
  providerDisplayName,
  type ModelCatalog,
  type ModelChoice,
} from '../shared/model-catalog';
import type { ProviderId } from '../shared/types';

interface PickerOption {
  key: string;
  kind: 'default' | 'saved' | 'model' | 'custom';
  value: string;
  choice?: ModelChoice;
}

interface ModelPickerProps {
  provider: ProviderId;
  value: string;
  catalog?: ModelCatalog;
  loading: boolean;
  fieldKey: string;
  label?: string;
  allowDefault?: boolean;
  onChange: (value: string) => void;
  onRefresh: () => void;
}

export default function ModelPicker({
  provider,
  value,
  catalog,
  loading,
  fieldKey,
  label = 'Model',
  allowDefault = true,
  onChange,
  onRefresh,
}: ModelPickerProps) {
  const baseId = `model-picker-${fieldKey.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const listboxId = `${baseId}-listbox`;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [search, setSearch] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    setDraft(value);
    setSearch(null);
  }, [value]);

  const providerName = providerDisplayName(provider);
  const models = catalog?.models ?? [];
  const query = (search ?? '').trim().toLowerCase();
  const customValue = draft.trim();
  const matches =
    search === null
      ? models
      : models.filter(
          (choice) =>
            query.length === 0 ||
            choice.id.toLowerCase().includes(query) ||
            (choice.label ?? '').toLowerCase().includes(query),
        );
  const savedMissing =
    value.length > 0 && !models.some((choice) => choice.id === value);
  const options: PickerOption[] = allowDefault
    ? [{ key: 'cli-default', kind: 'default', value: '' }]
    : [];
  if (savedMissing) options.push({ key: 'saved', kind: 'saved', value });
  for (const choice of matches) {
    options.push({
      key: `model:${choice.id}`,
      kind: 'model',
      value: choice.id,
      choice,
    });
  }
  const canUseCustom =
    customValue.length > 0 &&
    isValidModelId(customValue) &&
    !models.some((choice) => choice.id === customValue);
  if (canUseCustom)
    options.push({ key: 'custom', kind: 'custom', value: customValue });
  const invalidHint = customValue.length > 0 && !isValidModelId(customValue);
  const boundedIndex =
    options.length === 0 ? -1 : Math.min(activeIndex, options.length - 1);
  const groupLabel =
    catalog?.status === 'discovered'
      ? `Discovered from ${providerName}`
      : 'Built-in suggestions';

  useEffect(() => {
    if (!open || boundedIndex < 0) return;
    const list = listRef.current;
    const option = list?.querySelector<HTMLElement>(
      `#${baseId}-option-${String(boundedIndex)}`,
    );
    if (!list || !option) return;
    const listRect = list.getBoundingClientRect();
    const optionRect = option.getBoundingClientRect();
    if (optionRect.top < listRect.top)
      list.scrollTop -= listRect.top - optionRect.top;
    else if (optionRect.bottom > listRect.bottom)
      list.scrollTop += optionRect.bottom - listRect.bottom;
  }, [baseId, boundedIndex, open]);

  function select(option: PickerOption): void {
    onChange(option.value);
    setDraft(option.value);
    setOpen(false);
    setSearch(null);
    setActiveIndex(0);
  }

  function updateDraft(next: string): void {
    setDraft(next);
    setSearch(next);
    setActiveIndex(0);
    setOpen(true);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setActiveIndex(0);
        return;
      }
      setActiveIndex((index) => Math.min(index + 1, options.length - 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setActiveIndex(Math.max(options.length - 1, 0));
        return;
      }
      setActiveIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === 'Home' && open) {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === 'End' && open) {
      event.preventDefault();
      setActiveIndex(Math.max(options.length - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (open && boundedIndex >= 0) select(options[boundedIndex]);
      return;
    }
    if (event.key === 'Escape') {
      setOpen(false);
      setDraft(value);
      setSearch(null);
      setActiveIndex(0);
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
      setDraft(value);
      setSearch(null);
    }
  }

  function statusText(): string {
    if (loading) return 'Loading models…';
    if (catalog && catalog.message) return catalog.message;
    if (value.length === 0 && !allowDefault)
      return 'An explicit model is required for this reviewer.';
    if (value.length > 0) {
      const match = models.find((choice) => choice.id === value);
      if (match) {
        return match.source === 'discovered'
          ? `Current model was discovered from ${providerName}.`
          : 'Current model is a built-in suggestion.';
      }
      return 'Saved model is not in the current catalog.';
    }
    return 'Catalog membership does not guarantee account access.';
  }

  function renderOption(option: PickerOption): ReactNode {
    if (option.kind === 'default') {
      return (
        <>
          <span className="model-picker-option-label">CLI default</span>
          <span className="quiet">Uses the provider default model</span>
        </>
      );
    }
    if (option.kind === 'saved') {
      return (
        <>
          <span className="model-picker-option-label">Saved model</span>
          <code>{option.value}</code>
        </>
      );
    }
    if (option.kind === 'custom') {
      return (
        <span className="model-picker-option-label">
          Use custom model &quot;{option.value}&quot;
        </span>
      );
    }
    if (!option.choice) return null;
    return (
      <>
        {option.choice.label !== null && (
          <span className="model-picker-option-label">
            {option.choice.label}
          </span>
        )}
        <code>{option.choice.id}</code>
      </>
    );
  }

  return (
    <div className="model-picker">
      <div className="model-picker-control">
        <input
          ref={inputRef}
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={
            open && boundedIndex >= 0
              ? `${baseId}-option-${String(boundedIndex)}`
              : undefined
          }
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          maxLength={120}
          required={!allowDefault}
          placeholder={allowDefault ? 'CLI default' : 'Select a model'}
          value={draft}
          onFocus={(event) => {
            event.currentTarget.select();
            setOpen(true);
            setSearch(null);
            setActiveIndex(0);
          }}
          onBlur={(event) => {
            if (event.relatedTarget === toggleRef.current) return;
            setOpen(false);
            setDraft(value);
            setSearch(null);
            setActiveIndex(0);
          }}
          onChange={(event) => {
            updateDraft(event.target.value);
          }}
          onKeyDown={handleKeyDown}
          onClick={() => {
            if (!open) {
              setOpen(true);
              setSearch(null);
              setActiveIndex(0);
            }
          }}
        />
        <button
          ref={toggleRef}
          type="button"
          className="button model-picker-toggle"
          aria-label={
            open ? `Hide ${providerName} models` : `Show ${providerName} models`
          }
          aria-expanded={open}
          aria-controls={listboxId}
          onClick={() => {
            if (open) {
              setOpen(false);
              setDraft(value);
              setSearch(null);
              setActiveIndex(0);
              return;
            }
            setOpen(true);
            setSearch(null);
            setActiveIndex(0);
            inputRef.current?.focus();
          }}
        >
          <span aria-hidden="true">▾</span>
        </button>
        {catalog && catalog.status !== 'builtin' && (
          <button
            type="button"
            className="button model-picker-refresh"
            aria-label={`Refresh ${provider} models`}
            disabled={loading}
            onClick={onRefresh}
          >
            Refresh models
          </button>
        )}
        {open && (
          <ul
            className="model-picker-list"
            id={listboxId}
            ref={listRef}
            role="listbox"
            aria-label={`${providerName} models`}
          >
            {options.map((option, index) => (
              <Fragment key={option.key}>
                {option.kind === 'model' &&
                  (index === 0 || options[index - 1].kind !== 'model') && (
                    <li role="presentation" className="model-picker-group">
                      {groupLabel}
                    </li>
                  )}
                <li
                  id={`${baseId}-option-${String(index)}`}
                  role="option"
                  aria-selected={index === boundedIndex}
                  className={`model-picker-option${index === boundedIndex ? ' is-active' : ''}`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                  }}
                  onClick={() => {
                    select(option);
                  }}
                >
                  {renderOption(option)}
                </li>
              </Fragment>
            ))}
            {invalidHint && (
              <li role="presentation" className="model-picker-hint">
                Model identifiers must not begin with &quot;-&quot;, contain
                control characters, or exceed 120 characters.
              </li>
            )}
          </ul>
        )}
      </div>
      <p className="field-helper" role="status">
        {statusText()}
      </p>
    </div>
  );
}
