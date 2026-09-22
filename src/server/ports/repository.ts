import type {
  ManagedProject,
  Run,
  RunEvent,
  Workflow,
} from '../../shared/types.js';

export interface WorkflowRepository {
  listWorkflows(): Workflow[];
  getWorkflow(id: string): Workflow | undefined;
  saveWorkflow(workflow: Workflow): void;
}

export interface ProjectRepository {
  listProjects(): ManagedProject[];
  getProject(id: string): ManagedProject | undefined;
  saveProject(project: ManagedProject): void;
}

/** Reads and writes detach values; callers explicitly save their mutations. */
export interface RunRepository {
  listRuns(): Run[];
  getRun(id: string): Run | undefined;
  saveRun(run: Run): void;
  /** All writes are visible before subscribers receive notifications. */
  saveRuns(runs: Run[]): void;
  subscribe(runId: string, listener: () => void): () => void;
  addEvent(
    runId: string,
    stepId: string | null,
    type: RunEvent['type'],
    message: string,
  ): RunEvent;
  /** Ascending global event IDs, after is exclusive; at most 2,000 entries. */
  getEvents(runId: string, after?: number): RunEvent[];
}

export interface WorkflowRunRepository
  extends WorkflowRepository, RunRepository {}

export interface Repository extends WorkflowRunRepository, ProjectRepository {
  close(): void;
}
