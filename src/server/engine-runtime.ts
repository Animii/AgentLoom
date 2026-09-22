import { existsSync } from 'node:fs';
import type {
  AppConfig,
  ExecuteAgent,
  Run,
  ValidationEvidence,
  ValidationSignals,
} from '../shared/types.js';
import type { Repository } from './ports/repository.js';
import type { EngineEffects, ProjectAccess } from './ports/execution.js';
import { Engine } from './engine.js';
import { Projects } from './projects.js';
import { prepareGitWorkspace, previewRunGit } from './git-workspaces.js';
import { prepareWorkspace, prepareWorkspaceFrom } from './workspaces.js';
import {
  readSourceSnapshot,
  sourceFingerprint,
  runValidationCommand,
} from './validation.js';
import { writeEvidencePacket } from './evidence-packet.js';
import { runCouncil, assertCouncilCurrent } from './council.js';

/** Runtime composition only. Isolated workflow tests construct Engine with fake effects. */
export function createRuntimeEngine(
  store: Repository,
  config: AppConfig,
  execute: ExecuteAgent,
  projects: ProjectAccess = new Projects(store, config),
  assessReview?: (runId: string, stepId: string) => Promise<void> | undefined,
  evaluateValidation?: (
    run: Run,
    evidence: ValidationEvidence,
  ) => Promise<ValidationSignals>,
  overrides: Partial<EngineEffects> = {},
): Engine {
  return new Engine(
    store,
    config,
    execute,
    {
      projects,
      prepareGitWorkspace,
      previewRunGit,
      prepareWorkspace,
      prepareWorkspaceFrom,
      workspaceExists: existsSync,
      readSourceSnapshot,
      sourceFingerprint,
      writeEvidencePacket,
      runValidationCommand,
      runCouncil,
      assertCouncilCurrent,
      ...overrides,
    },
    assessReview,
    evaluateValidation,
  );
}
