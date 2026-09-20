import { checkGitSource } from './git-workspaces.js';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig, ManagedProject, Run } from '../shared/types.js';
import type { Store } from './store.js';
import { listProjects } from './workspaces.js';

const liveStatuses = new Set(['queued', 'running', 'waiting_input', 'waiting_approval', 'blocked', 'interrupted']);
const normalize = (value: string) => value.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
const overlaps = (a: string, b: string) => normalize(a) === normalize(b) || normalize(a).startsWith(normalize(b) + '/') || normalize(b).startsWith(normalize(a) + '/');

export class Projects {
  constructor(private store: Store, private config: AppConfig) {}

  async list(): Promise<ManagedProject[]> {
    for (const entry of await listProjects(this.config.workspaceRoot)) {
      if (!this.store.getProject(entry.id)) this.store.saveProject({ ...entry, kind: 'imported', workspaceMode: 'isolated', status: 'active', sourcePath: path.resolve(this.config.workspaceRoot, 'projects', entry.id), hostPath: `workspaces/projects/${entry.id}` });
    }
    const runs = this.store.listRuns();
    return Promise.all(this.store.listProjects().map(async project => ({ ...project, available: await this.resolve(project).then(() => true, () => false), runCount: runs.filter(run => run.project === project.id).length })));
  }

  async folder(value: string): Promise<{ relative: string; sourcePath: string; hostPath: string }> {
    if (!this.config.projectRoot) throw new Error('Folder access is not configured. Set PROJECTS_FOLDER in .env and restart Docker Compose.');
    let relative = value.trim().replaceAll('\\', '/').replace(/\/$/, '');
    const host = (this.config.projectHostRoot ?? this.config.projectRoot).replaceAll('\\', '/').replace(/\/$/, '');
    if (normalize(relative) === normalize(host)) relative = '';
    else if (normalize(relative).startsWith(normalize(host) + '/')) relative = relative.slice(host.length + 1);
    const parts = relative ? relative.split('/') : [];
    if (relative.length > 1000 || parts.some(part => !part || part === '.' || part === '..' || /[:\x00-\x1f]/.test(part))) throw new Error('Choose a folder inside the configured project directory.');
    const root = path.resolve(this.config.projectRoot);
    let current = root;
    for (const part of ['', ...parts]) {
      if (part) current = path.join(current, part);
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Choose a real folder, not a shortcut or symlink.');
    }
    const real = await fs.realpath(current); const realRoot = await fs.realpath(root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new Error('Folder escapes the configured directory.');
    return { relative: parts.join('/'), sourcePath: current, hostPath: host + (parts.length ? '/' + parts.join('/') : '') };
  }

  async browse(value = '') {
    const location = await this.folder(value);
    const entries = await fs.readdir(location.sourcePath, { withFileTypes: true });
    return { path: location.relative, hostPath: location.hostPath, folders: entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.') && entry.name !== 'node_modules').map(entry => ({ name: entry.name, path: [location.relative, entry.name].filter(Boolean).join('/') })).sort((a, b) => a.name.localeCompare(b.name)), canConnect: Boolean(location.relative) };
  }

  async connect(input: { name: string; folder: string; workspaceMode: 'direct' | 'isolated' | 'worktree' }) {
    const location = await this.folder(input.folder);
    if (!location.relative) throw new Error('Open the project folder before connecting.');
    if(input.workspaceMode === 'worktree') await checkGitSource(location.sourcePath);
    await this.list();
    const existing = this.store.listProjects().find(project => normalize(project.sourcePath) === normalize(location.sourcePath));
    if (existing && existing.status !== 'disconnected') throw new Error('This folder is already connected. Manage the existing project instead.');
    const project: ManagedProject = { id: existing?.id ?? `project-${randomUUID()}`, name: input.name, kind: 'connected', workspaceMode: input.workspaceMode, status: 'active', sourcePath: location.sourcePath, hostPath: location.hostPath, folder: location.relative };
    this.store.saveProject(project); return project;
  }

  async resolve(project: ManagedProject): Promise<string> {
    if (project.kind === 'connected') {
      const location = await this.folder(project.folder ?? '');
      if (normalize(location.sourcePath) !== normalize(project.sourcePath) || normalize(location.hostPath) !== normalize(project.hostPath)) throw new Error('The folder mount changed. Disconnect and reconnect this project.');
    } else if (path.resolve(project.sourcePath) !== path.resolve(this.config.workspaceRoot, 'projects', project.id)) throw new Error('Invalid imported project folder.');
    const stat = await fs.lstat(project.sourcePath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Project folder is unavailable.');
    return project.sourcePath;
  }

  async forRun(id: string): Promise<ManagedProject | undefined> {
    await this.list();
    const project = this.store.getProject(id);
    if (!project) return undefined; // Legacy missing-folder runs retain explicit recovery behavior.
    if (project.status !== 'active') throw new Error('This project is archived or disconnected. Restore or reconnect it first.');
    await this.resolve(project);
    return project;
  }

  async update(id: string, changes: { name?: string; workspaceMode?: 'direct' | 'isolated' | 'worktree'; status?: 'active' | 'archived' | 'disconnected' }) {
    const project = this.store.getProject(id);
    if (!project) throw new Error('Project not found.');
    if (changes.workspaceMode === 'worktree') await checkGitSource(await this.resolve(project));
    if (changes.status === 'active') await this.resolve(project);
    if ((changes.workspaceMode && changes.workspaceMode !== project.workspaceMode || changes.status && changes.status !== project.status) && this.store.listRuns().some(run => run.project === id && liveStatuses.has(run.status))) throw new Error('Finish or cancel this project’s active runs before changing access or status.');
    const updated = { ...project, ...changes }; this.store.saveProject(updated); return updated;
  }

  assertNoConflict(run: Run) {
    if (!run.projectLocation) return;
    const project = this.store.getProject(run.project);
    if (project && project.status !== 'active') throw new Error('This project is archived or disconnected.');
    if (run.mode === 'demo') return;
    const conflict = this.store.listRuns().find(other => other.id !== run.id && other.mode === 'live' && liveStatuses.has(other.status) && other.projectLocation && (run.projectLocation!.workspaceMode === 'direct' || other.projectLocation.workspaceMode === 'direct') && overlaps(run.projectLocation!.sourcePath, other.projectLocation.sourcePath));
    if (conflict) throw new Error(`Folder is in use by "${conflict.title}". Finish or cancel that run first.`);
  }

  async directFolder(run: Run) {
    const project = this.store.getProject(run.project);
    if (!project || project.status === 'disconnected' || !run.projectLocation) throw new Error('Project is disconnected. Its run history is still available.');
    return this.resolve(run.projectLocation);
  }
}

export function registerProjects(app: FastifyInstance, projects: Projects) {
  app.get('/api/projects', async () => projects.list());
  app.get<{ Querystring: { path?: string } }>('/api/project-folders', async (request, reply) => {
    try { return await projects.browse(request.query.path ?? ''); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'Folder unavailable.' }); }
  });
  const name = z.string().trim().min(1).max(100);
  app.post('/api/projects', async (request, reply) => {
    const parsed = z.strictObject({ name, folder: z.string().min(1).max(1000), workspaceMode: z.enum(['direct', 'isolated', 'worktree']) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Provide a name, folder and workspace mode.' });
    try { return reply.code(201).send(await projects.connect(parsed.data)); } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : 'Could not connect folder.' }); }
  });
  app.patch<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
    const parsed = z.strictObject({ name: name.optional(), workspaceMode: z.enum(['direct', 'isolated', 'worktree']).optional(), status: z.enum(['active', 'archived', 'disconnected']).optional() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid project changes.' });
    try { return await projects.update(request.params.id, parsed.data); } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : 'Could not update project.' }); }
  });
}
