import type { ProviderId } from './types.js';

export type ModelCatalogStatus =
  | 'discovered'
  | 'builtin'
  | 'empty'
  | 'missing'
  | 'unsupported'
  | 'timeout'
  | 'malformed'
  | 'failed';

export type ModelCatalogSource = 'discovered' | 'builtin';

export type ModelFallbackStatus = Exclude<ModelCatalogStatus, 'discovered'>;

export interface ModelChoice {
  id: string;
  label: string | null;
  source: ModelCatalogSource;
}

export interface ModelCatalog {
  provider: ProviderId;
  status: ModelCatalogStatus;
  message: string | null;
  models: ModelChoice[];
  fetchedAt: string;
}

export const MODEL_ID_MAX_LENGTH = 120;

export const BUILTIN_MODELS: Record<ProviderId, ModelChoice[]> = {
  claude: [
    { id: 'sonnet', label: null, source: 'builtin' },
    { id: 'opus', label: null, source: 'builtin' },
    { id: 'haiku', label: null, source: 'builtin' },
  ],
  codex: [{ id: 'gpt-5.6-sol', label: null, source: 'builtin' }],
  opencode: [{ id: 'opencode/gpt-5.1-codex', label: null, source: 'builtin' }],
};

const PROVIDER_NAMES: Record<ProviderId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

const STATUS_MESSAGES: Record<ModelFallbackStatus, string> = {
  builtin: 'Live model discovery is not available for {provider}. Showing built-in suggestions.',
  empty: '{provider} reported no models. Showing built-in suggestions.',
  missing: 'The {provider} CLI was not found on the AgentLoom server. Showing built-in suggestions.',
  unsupported: 'This {provider} version does not support model listing. Showing built-in suggestions.',
  timeout: '{provider} model discovery timed out. Showing built-in suggestions.',
  malformed: '{provider} model discovery returned an unusable response. Showing built-in suggestions.',
  failed: '{provider} model discovery failed. Showing built-in suggestions.',
};

export function providerDisplayName(provider: ProviderId): string {
  return PROVIDER_NAMES[provider];
}

export function modelCatalogMessage(provider: ProviderId, status: ModelCatalogStatus): string | null {
  if (status === 'discovered') return null;
  return STATUS_MESSAGES[status].replace('{provider}', PROVIDER_NAMES[provider]);
}

export function isValidModelId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MODEL_ID_MAX_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    !value.startsWith('-')
  );
}

export function suggestedCatalog(provider: ProviderId, status: ModelFallbackStatus = 'builtin'): ModelCatalog {
  return {
    provider,
    status,
    message: modelCatalogMessage(provider, status),
    models: BUILTIN_MODELS[provider].map((choice) => ({ ...choice })),
    fetchedAt: new Date().toISOString(),
  };
}
