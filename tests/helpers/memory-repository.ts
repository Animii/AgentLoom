import type { Repository } from '../../src/server/ports/repository.js';
import type {
  ManagedProject,
  Run,
  RunEvent,
  Workflow,
} from '../../src/shared/types.js';

// Match the persisted JSON contract, including omitted undefined properties.
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Explicitly seeded test repository: never reads disk or starts integrations. */
export class MemoryRepository implements Repository {
  private readonly workflows = new Map<string, Workflow>();
  private readonly projects = new Map<string, ManagedProject>();
  private readonly runs = new Map<
    string,
    { value: Run; createdAt: string; order: number }
  >();
  private readonly events: RunEvent[] = [];
  private readonly listeners = new Map<string, Set<() => void>>();
  private closed = false;

  private assertOpen(): void {
    if (this.closed) throw new Error('Repository is closed.');
  }

  listWorkflows(): Workflow[] {
    this.assertOpen();
    return [...this.workflows.values()].map(copy);
  }
  getWorkflow(id: string): Workflow | undefined {
    this.assertOpen();
    const value = this.workflows.get(id);
    return value ? copy(value) : undefined;
  }
  saveWorkflow(value: Workflow): void {
    this.assertOpen();
    this.workflows.set(value.id, copy(value));
  }
  listProjects(): ManagedProject[] {
    this.assertOpen();
    return [...this.projects.values()].map(copy);
  }
  getProject(id: string): ManagedProject | undefined {
    this.assertOpen();
    const value = this.projects.get(id);
    return value ? copy(value) : undefined;
  }
  saveProject(value: ManagedProject): void {
    this.assertOpen();
    this.projects.set(value.id, copy(value));
  }
  listRuns(): Run[] {
    this.assertOpen();
    return [...this.runs.values()]
      .sort(
        (a, b) => b.createdAt.localeCompare(a.createdAt) || b.order - a.order,
      )
      .map(({ value }) => copy(value));
  }
  getRun(id: string): Run | undefined {
    this.assertOpen();
    const entry = this.runs.get(id);
    return entry ? copy(entry.value) : undefined;
  }
  saveRun(run: Run): void {
    this.saveRuns([run]);
  }
  saveRuns(runs: Run[]): void {
    this.assertOpen();
    // Serialize the complete batch before committing, so failure is atomic.
    const values = runs.map((run) =>
      copy({ ...run, updatedAt: new Date().toISOString() }),
    );
    for (const value of values) {
      const existing = this.runs.get(value.id);
      this.runs.set(value.id, {
        value,
        createdAt: existing?.createdAt ?? value.createdAt,
        order: existing?.order ?? this.runs.size,
      });
    }
    for (const run of runs) {
      for (const listener of this.listeners.get(run.id) ?? []) listener();
    }
  }
  subscribe(runId: string, listener: () => void): () => void {
    const group = this.listeners.get(runId) ?? new Set<() => void>();
    group.add(listener);
    this.listeners.set(runId, group);
    return () => {
      group.delete(listener);
      if (group.size === 0) this.listeners.delete(runId);
    };
  }
  addEvent(
    runId: string,
    stepId: string | null,
    type: RunEvent['type'],
    message: string,
  ): RunEvent {
    this.assertOpen();
    const event: RunEvent = {
      id: this.events.length + 1,
      runId,
      stepId,
      type,
      message: message.slice(0, 100_000),
      timestamp: new Date().toISOString(),
    };
    this.events.push(event);
    return copy(event);
  }
  getEvents(runId: string, after = 0): RunEvent[] {
    this.assertOpen();
    return this.events
      .filter((event) => event.runId === runId && event.id > after)
      .slice(0, 2_000)
      .map(copy);
  }
  close(): void {
    this.closed = true;
    this.listeners.clear();
  }
}
