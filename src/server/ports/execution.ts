import type { CouncilEvidence } from '../../shared/council.js';
import type {
  AgentEvent,
  AppConfig,
  ExecuteAgent,
  GitPreview,
  ManagedProject,
  Run,
  RunGit,
  StepRun,
  ValidationCommand,
  ValidationResult,
} from '../../shared/types.js';

export interface ProjectAccess {
  forRun(id: string): Promise<ManagedProject | undefined>;
  assertNoConflict(run: Run): void;
  resolve(project: ManagedProject): Promise<string>;
  directFolder(run: Run): Promise<string>;
}

export interface GitEffects {
  prepare(
    config: AppConfig,
    source: string,
    run: Run,
    onPlan?: (metadata: RunGit) => void,
  ): Promise<{ workspace: string; git: RunGit }>;
  preview(run: Run, config: AppConfig): Promise<GitPreview>;
  join(parent: Run, children: Run[], config: AppConfig): Promise<string>;
  readPr(run: Run): Promise<{
    state: 'OPEN' | 'CLOSED' | 'MERGED';
    head: string;
    events: {
      id: string;
      head: string;
      kind: 'review' | 'ci';
      summary: string;
    }[];
  }>;
  publishPr(
    run: Run,
    config: AppConfig,
    input: { token: string; title: string; body: string },
  ): Promise<{ url: string; commit: string }>;
}

/** All environmental effects needed to drive a workflow. Pure policies stay outside. */
export interface EngineEffects {
  projects: ProjectAccess;
  prepareGitWorkspace: GitEffects['prepare'];
  previewRunGit: GitEffects['preview'];
  prepareWorkspace(
    root: string,
    project: string,
    runId: string,
  ): Promise<string>;
  prepareWorkspaceFrom(
    root: string,
    source: string,
    runId: string,
  ): Promise<string>;
  workspaceExists(path: string): boolean;
  readSourceSnapshot(
    root: string,
  ): Promise<{ relative: string; content: Buffer }[]>;
  sourceFingerprint(root: string): Promise<string>;
  writeEvidencePacket(
    run: Run,
    dataDir: string,
  ): Promise<{ path: string; sha256: string }>;
  runValidationCommand(
    command: ValidationCommand,
    cwd: string,
    signal: AbortSignal,
    onUpdate: (result: ValidationResult) => void,
  ): Promise<ValidationResult>;
  runCouncil(
    run: Run,
    step: StepRun,
    config: AppConfig,
    execute: ExecuteAgent,
    signal: AbortSignal,
    save: (evidence: CouncilEvidence) => void,
    event: (event: AgentEvent) => void,
  ): Promise<CouncilEvidence>;
  assertCouncilCurrent(run: Run, step: StepRun): Promise<void>;
}
