import type { CreateAppOptions } from '../../src/server/app.js';
import type { ProviderId, ProviderInfo } from '../../src/shared/types.js';
import { suggestedCatalog } from '../../src/shared/model-catalog.js';

function unexpected(effect: string): never {
  throw new Error(`Unexpected ${effect} in test. Supply an explicit fixture.`);
}

export function fakeProviderStatus(): ProviderInfo[] {
  const ids: ProviderId[] = ['claude', 'codex', 'opencode'];
  return ids.map((id) => ({
    id,
    name: `${id} (test fixture)`,
    installed: true,
    version: 'test-fixture',
    authentication: 'not_checked',
    error: null,
    suggestedModel: suggestedCatalog(id).models[0]?.id ?? '',
    efforts: ['low', 'medium', 'high', 'max'],
    loginCommand: 'Test fixture: authentication is disabled',
  }));
}

/** All external operations are explicit test dependencies, never live defaults. */
export function safeAppOptions(
  overrides: CreateAppOptions = {},
): CreateAppOptions {
  return {
    ...overrides,
    logger: overrides.logger ?? false,
    execute: overrides.execute ?? (() => unexpected('provider execution')),
    getProviders:
      overrides.getProviders ?? (() => Promise.resolve(fakeProviderStatus())),
    discoverModels:
      overrides.discoverModels ??
      ((provider) => Promise.resolve(suggestedCatalog(provider))),
    jevFetch: overrides.jevFetch ?? (() => unexpected('Jev network request')),
    prepareGit:
      overrides.prepareGit ?? (() => unexpected('Git workspace preparation')),
    previewGit:
      overrides.previewGit ?? (() => unexpected('Git workspace preview')),
    joinGit: overrides.joinGit ?? (() => unexpected('Git worktree join')),
    readPr: overrides.readPr ?? (() => unexpected('GitHub PR read')),
    publishPr:
      overrides.publishPr ?? (() => unexpected('GitHub PR publication')),
  };
}
