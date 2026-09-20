import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listProjects } from './workspaces.js';
import { excludedProjectPath, IMPORT_MARKER, IMPORT_MAX_BYTES, IMPORT_MAX_FILE_BYTES, IMPORT_MAX_FILES } from '../shared/project-import.js';

interface ImportJob { id: string; name: string; directory: string; paths: Set<string>; entries: Set<string>; bytes: number; expected: number; busy: boolean; touched: number }
const idSchema = z.string().uuid();
const nameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/).refine(name => !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name), 'Choose a different project name');

export function registerProjectImports(app: FastifyInstance, workspaceRoot: string) {
  const jobs = new Map<string, ImportJob>();
  const reserved = new Set<string>();
  const stagingRoot = path.resolve(workspaceRoot, '.imports');
  async function cleanAbandoned() {
    const stat = await fs.lstat(stagingRoot).catch(() => null);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return;
    for (const entry of await fs.readdir(stagingRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !idSchema.safeParse(entry.name).success || jobs.has(entry.name)) continue;
      const directory = path.resolve(stagingRoot, entry.name);
      const info = await fs.lstat(directory).catch(() => null);
      if (info && !info.isSymbolicLink() && Date.now() - info.mtimeMs > 86400000 && path.dirname(directory) === stagingRoot) await fs.rm(directory, { recursive: true, force: true });
    }
  }
  async function realDirectory(directory: string) {
    await fs.mkdir(directory, { recursive: true });
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Import storage must be a real directory.');
  }
  async function discard(job: ImportJob) {
    if (path.dirname(path.resolve(job.directory)) !== stagingRoot || path.basename(job.directory) !== job.id || !idSchema.safeParse(job.id).success) throw new Error('Invalid import storage path.');
    await fs.rm(job.directory, { recursive: true, force: true });
    jobs.delete(job.id); reserved.delete(job.name.toLowerCase());
  }
  const expiry = setInterval(() => {
    for (const job of jobs.values()) if (!job.busy && Date.now() - job.touched > 3600000) { job.busy = true; void discard(job).catch(() => { job.busy = false; }); }
  }, 60000);
  expiry.unref();
  app.addHook('onClose', async () => { clearInterval(expiry); await Promise.allSettled([...jobs.values()].map(discard)); });

  app.post('/api/project-imports', async (request, reply) => {
    const parsed = z.strictObject({ name: nameSchema, fileCount: z.number().int().min(1).max(IMPORT_MAX_FILES) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Use a project name with letters, numbers, hyphens or underscores, and select 1–10,000 files.' });
    const key = parsed.data.name.toLowerCase();
    if (jobs.size >= 8) return reply.code(409).send({ error: 'Too many imports are in progress. Finish or cancel one first.' });
    if (reserved.has(key)) return reply.code(409).send({ error: 'That project name is already being imported. Choose another name.' });
    reserved.add(key);
    try {
      if (app.store.getProject(parsed.data.name)?.status === 'disconnected') throw new Error('That name belongs to a disconnected project. Reconnect it in Projects or choose another name.');
      const projects = await listProjects(workspaceRoot);
      if (projects.some(project => project.id.toLowerCase() === key)) throw new Error('A project with that name already exists. Choose another name.');
      await realDirectory(stagingRoot);
      await cleanAbandoned();
      const id = randomUUID(); const directory = path.join(stagingRoot, id); await fs.mkdir(directory);
      jobs.set(id, { id, name: parsed.data.name, directory, expected: parsed.data.fileCount, paths: new Set(), entries: new Set(), bytes: 0, busy: false, touched: Date.now() });
      return reply.code(201).send({ id });
    } catch (error) { reserved.delete(key); return reply.code(409).send({ error: error instanceof Error ? error.message : 'Could not start import.' }); }
  });

  app.put<{ Params: { id: string } }>('/api/project-imports/:id/files', { bodyLimit: 14 * 1024 * 1024 }, async (request, reply) => {
    const job = jobs.get(request.params.id);
    if (!job) return reply.code(404).send({ error: 'Import expired. Select the folder and try again.' });
    if (job.busy) return reply.code(409).send({ error: 'An upload is already in progress.' });
    const parsed = z.strictObject({ path: z.string().min(1).max(1000), data: z.string().max(14 * 1024 * 1024) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid file upload.' });
    job.busy = true;
    try {
      const relative = parsed.data.path; const parts = relative.split('/');
      if (parts.length > 50 || parts.some(p => !p || p === '.' || p === '..' || /[\\:\x00-\x1f<>"|?*]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)) || excludedProjectPath(relative)) throw new Error('This file path is not allowed.');
      const key = relative.toLowerCase();
      if (job.paths.has(key)) throw new Error('This file was already uploaded.');
      const data = Buffer.from(parsed.data.data, 'base64');
      if (data.toString('base64') !== parsed.data.data) throw new Error('Invalid file encoding.');
      if (data.length > IMPORT_MAX_FILE_BYTES) throw new Error('Files must be 10 MB or smaller.');
      if (job.bytes + data.length > IMPORT_MAX_BYTES || job.paths.size >= job.expected) throw new Error('Project exceeds the import limits.');
      const entries = new Set(job.entries); for (let i = 1; i <= parts.length; i++) entries.add(parts.slice(0, i).join('/').toLowerCase());
      if (entries.size > IMPORT_MAX_FILES) throw new Error('Project exceeds 10,000 files and folders.');
      const target = path.resolve(job.directory, ...parts);
      if (!target.startsWith(job.directory + path.sep)) throw new Error('File path escapes the selected folder.');
      await realDirectory(job.directory);
      let parent = job.directory;
      for (const part of parts.slice(0, -1)) { parent = path.join(parent, part); await realDirectory(parent); }
      await fs.writeFile(target, data, { flag: 'wx' });
      job.paths.add(key); job.entries = entries; job.bytes += data.length; job.touched = Date.now();
      return { uploaded: job.paths.size, total: job.expected };
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'Could not upload file.' }); }
    finally { job.busy = false; }
  });

  app.post<{ Params: { id: string } }>('/api/project-imports/:id/complete', async (request, reply) => {
    const job = jobs.get(request.params.id);
    if (!job) return reply.code(404).send({ error: 'Import expired. Try again.' });
    if (job.busy || job.paths.size !== job.expected) return reply.code(409).send({ error: 'Wait until all files have uploaded.' });
    job.busy = true;
    const target = path.resolve(workspaceRoot, 'projects', job.name);
    let owned = false;
    try {
      await listProjects(workspaceRoot); // Recheck project-root directories before publication.
      await fs.mkdir(target); owned = true; // Exclusive reservation: never overwrite an existing project.
      await fs.writeFile(path.join(target, IMPORT_MARKER), job.id, { flag: 'wx' });
      for (const entry of await fs.readdir(job.directory)) await fs.rename(path.join(job.directory, entry), path.join(target, entry));
      await fs.unlink(path.join(target, IMPORT_MARKER));
      await discard(job);
      return reply.code(201).send({ id: job.name, name: job.name });
    } catch (error) {
      if (owned && path.dirname(target) === path.resolve(workspaceRoot, 'projects') && path.basename(target) === job.name) await fs.rm(target, { recursive: true, force: true });
      await discard(job);
      return reply.code(409).send({ error: error instanceof Error ? error.message : 'Could not create project. Please import again.' });
    } finally { job.busy = false; }
  });

  app.delete<{ Params: { id: string } }>('/api/project-imports/:id', async (request, reply) => {
    const job = jobs.get(request.params.id);
    if (job?.busy) return reply.code(409).send({ error: 'Wait for the current file to finish uploading.' });
    if (job) await discard(job);
    return reply.code(204).send();
  });
}
