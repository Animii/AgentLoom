import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ManagedProject, Run, RunEvent, Workflow } from '../shared/types.js';
import { initialWorkflows, evidenceWorkflow, councilWorkflow, singleReviewWorkflow, crateWorkflow } from './templates.js';

const MAX_EVENT_MESSAGE_LENGTH = 100000;
const MAX_EVENTS_PER_QUERY = 2000;

interface WorkflowRow {
  data: string;
}

interface RunRow {
  data: string;
}

interface EventRow {
  id: number | bigint;
  run_id: string;
  step_id: string | null;
  timestamp: string;
  type: string;
  message: string;
}

interface CountRow {
  count: number | bigint;
}

export class Store {
  private readonly db: DatabaseSync;
  private readonly listeners = new Map<string, Set<() => void>>();

  subscribe(runId: string, listener: () => void): () => void {
    const group = this.listeners.get(runId) ?? new Set<() => void>();
    group.add(listener); this.listeners.set(runId, group);
    return () => { group.delete(listener); if (!group.size) this.listeners.delete(runId); };
  }

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'agentloom.sqlite'));
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        step_id TEXT,
        timestamp TEXT NOT NULL,
        type TEXT NOT NULL,
        message TEXT NOT NULL
      );
    `);
    this.seedTemplates();
  }

  private seedTemplates(): void {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM workflows').get() as unknown as CountRow;
    if (Number(row.count) > 0) {
      if (!this.getWorkflow(crateWorkflow.id)) this.saveWorkflow(crateWorkflow);
      if (!this.getWorkflow(singleReviewWorkflow.id)) this.saveWorkflow(singleReviewWorkflow);
      if (!this.getWorkflow(councilWorkflow.id)) this.saveWorkflow(councilWorkflow);
      if (!this.getWorkflow(evidenceWorkflow.id)) this.saveWorkflow(evidenceWorkflow);
      return;
    }
    for (const workflow of initialWorkflows) {
      this.saveWorkflow(workflow);
    }
  }

  listWorkflows(): Workflow[] {
    const rows = this.db.prepare('SELECT data FROM workflows ORDER BY rowid ASC').all() as unknown as WorkflowRow[];
    return rows.map((row) => JSON.parse(row.data) as Workflow);
  }

  listProjects(): ManagedProject[] {
    return (this.db.prepare('SELECT data FROM projects ORDER BY rowid').all() as unknown as { data: string }[]).map(row => JSON.parse(row.data));
  }
  getProject(id: string): ManagedProject | undefined {
    const row = this.db.prepare('SELECT data FROM projects WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  saveProject(project: ManagedProject): void {
    this.db.prepare('INSERT INTO projects (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(project.id, JSON.stringify(project));
  }

  getWorkflow(id: string): Workflow | undefined {
    const row = this.db.prepare('SELECT data FROM workflows WHERE id = ?').get(id) as WorkflowRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    return JSON.parse(row.data) as Workflow;
  }

  saveWorkflow(workflow: Workflow): void {
    this.db
      .prepare('INSERT INTO workflows (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .run(workflow.id, JSON.stringify(workflow));
  }

  listRuns(): Run[] {
    const rows = this.db
      .prepare('SELECT data FROM runs ORDER BY created_at DESC, rowid DESC')
      .all() as unknown as RunRow[];
    return rows.map((row) => JSON.parse(row.data) as Run);
  }

  getRun(id: string): Run | undefined {
    const row = this.db.prepare('SELECT data FROM runs WHERE id = ?').get(id) as RunRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    return JSON.parse(row.data) as Run;
  }

  saveRun(run: Run): void {
    const stored: Run = { ...run, updatedAt: new Date().toISOString() };
    this.db
      .prepare(
        'INSERT INTO runs (id, data, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
      )
      .run(stored.id, JSON.stringify(stored), stored.createdAt);
    for (const listener of this.listeners.get(run.id) ?? []) listener();
  }

  saveRuns(runs: Run[]): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const statement=this.db.prepare('INSERT INTO runs (id,data,created_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data');
      for(const run of runs)statement.run(run.id,JSON.stringify({...run,updatedAt:new Date().toISOString()}),run.createdAt);
      this.db.exec('COMMIT');
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
    for(const run of runs)for(const listener of this.listeners.get(run.id)??[])listener();
  }

  addEvent(runId: string, stepId: string | null, type: RunEvent['type'], message: string): RunEvent {
    const cappedMessage = message.slice(0, MAX_EVENT_MESSAGE_LENGTH);
    const timestamp = new Date().toISOString();
    const result = this.db
      .prepare('INSERT INTO events (run_id, step_id, timestamp, type, message) VALUES (?, ?, ?, ?, ?)')
      .run(runId, stepId, timestamp, type, cappedMessage);
    return {
      id: Number(result.lastInsertRowid),
      runId,
      stepId,
      timestamp,
      type,
      message: cappedMessage,
    };
  }

  getEvents(runId: string, after = 0): RunEvent[] {
    const rows = this.db
      .prepare(
        'SELECT id, run_id, step_id, timestamp, type, message FROM events WHERE run_id = ? AND id > ? ORDER BY id ASC LIMIT ?',
      )
      .all(runId, after, MAX_EVENTS_PER_QUERY) as unknown as EventRow[];
    return rows.map((row) => ({
      id: Number(row.id),
      runId: row.run_id,
      stepId: row.step_id,
      timestamp: row.timestamp,
      type: row.type as RunEvent['type'],
      message: row.message,
    }));
  }

  close(): void {
    this.db.close();
  }
}
