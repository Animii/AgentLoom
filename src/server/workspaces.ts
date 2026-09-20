import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import * as path from 'node:path';
import type { ProjectInfo } from '../shared/types.js';
import { IMPORT_MARKER } from '../shared/project-import.js';

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;

const PROJECTS_DIR_NAME = 'projects';
const RUNS_DIR_NAME = 'runs';

const MAX_COPY_ENTRIES = 10_000;
const MAX_COPY_FILE_BYTES = 10 * 1024 * 1024;
const MAX_COPY_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_LIST_ENTRIES = 500;
const MAX_READ_BYTES = 1024 * 1024;

const COPY_EXCLUDED_NAMES = new Set(['.git', 'node_modules', '.env', '.auth', '.data']);
const LIST_SKIPPED_DIRECTORY_NAMES = new Set(['.git', 'node_modules']);

interface CopyBudget {
  entries: number;
  bytes: number;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function isNotFound(error: unknown): boolean {
  return isErrnoException(error) && error.code === 'ENOENT';
}

async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

function assertValidId(kind: 'project' | 'run', id: string): void {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new Error(`Invalid ${kind} id`);
  }
}

export function isExcludedFromCopy(name: string): boolean {
  const normalized = name.toLowerCase();
  if (COPY_EXCLUDED_NAMES.has(normalized)) {
    return true;
  }
  return normalized.startsWith('.env.') && normalized !== '.env.example';
}

function joinLabel(prefix: string, name: string): string {
  return prefix.length === 0 ? name : `${prefix}/${name}`;
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function ensureRealDirectory(directory: string, label: string): Promise<void> {
  const existing = await lstatOrNull(directory);
  if (existing) {
    if (existing.isSymbolicLink()) {
      throw new Error(`Refusing to use symlinked ${label}`);
    }
    if (!existing.isDirectory()) {
      throw new Error(`${label} is not a directory`);
    }
    return;
  }
  try {
    await fs.mkdir(directory);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'EEXIST') {
      throw error;
    }
  }
  const created = await fs.lstat(directory);
  if (created.isSymbolicLink() || !created.isDirectory()) {
    throw new Error(`${label} is not a directory`);
  }
}

async function ensureRoot(root: string): Promise<void> {
  if (typeof root !== 'string' || root.length === 0) {
    throw new Error('Workspace root is required');
  }
  await fs.mkdir(root, { recursive: true });
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink()) {
    throw new Error('Workspace root must not be a symlink');
  }
  if (!rootStat.isDirectory()) {
    throw new Error('Workspace root is not a directory');
  }
  await ensureRealDirectory(path.join(root, PROJECTS_DIR_NAME), 'projects directory');
  await ensureRealDirectory(path.join(root, RUNS_DIR_NAME), 'runs directory');
}

async function resolveProjectDirectory(root: string, project: string): Promise<string> {
  const projectDirectory = path.join(root, PROJECTS_DIR_NAME, project);
  if (await lstatOrNull(path.join(projectDirectory, IMPORT_MARKER))) throw new Error('Project is still importing.');
  const projectStat = await lstatOrNull(projectDirectory);
  if (!projectStat) {
    throw new Error('Project not found');
  }
  if (projectStat.isSymbolicLink()) {
    throw new Error('Project directory must not be a symlink');
  }
  if (!projectStat.isDirectory()) {
    throw new Error('Project path is not a directory');
  }
  return projectDirectory;
}

async function resolveRunDirectory(root: string, runId: string): Promise<string> {
  const runsDirectory = path.join(root, RUNS_DIR_NAME);
  const runsStat = await lstatOrNull(runsDirectory);
  if (!runsStat || runsStat.isSymbolicLink() || !runsStat.isDirectory()) {
    throw new Error('Runs directory is unavailable');
  }
  const runDirectory = path.join(runsDirectory, runId);
  const runStat = await lstatOrNull(runDirectory);
  if (!runStat) {
    throw new Error('Run workspace not found');
  }
  if (runStat.isSymbolicLink()) {
    throw new Error('Run workspace must not be a symlink');
  }
  if (!runStat.isDirectory()) {
    throw new Error('Run workspace is not a directory');
  }
  return runDirectory;
}

function enforceCopyBudget(budget: CopyBudget): void {
  if (budget.entries > MAX_COPY_ENTRIES) {
    throw new Error(`Workspace copy exceeds ${MAX_COPY_ENTRIES} entries`);
  }
}

async function copyFileWithinBudget(
  sourcePath: string,
  destinationPath: string,
  label: string,
  budget: CopyBudget,
): Promise<void> {
  const sourceStat = await fs.lstat(sourcePath);
  if (sourceStat.isSymbolicLink()) {
    throw new Error(`Refusing to copy symlink: ${label}`);
  }
  if (sourceStat.size > MAX_COPY_FILE_BYTES) {
    throw new Error(`File exceeds 10 MB copy limit: ${label}`);
  }
  const data = await fs.readFile(sourcePath);
  if (data.byteLength > MAX_COPY_FILE_BYTES) {
    throw new Error(`File exceeds 10 MB copy limit: ${label}`);
  }
  budget.bytes += data.byteLength;
  if (budget.bytes > MAX_COPY_TOTAL_BYTES) {
    throw new Error('Workspace copy exceeds 100 MB limit');
  }
  await fs.writeFile(destinationPath, data, { flag: 'wx' });
}

async function copyDirectoryContents(
  sourceDirectory: string,
  destinationDirectory: string,
  prefix: string,
  budget: CopyBudget,
): Promise<void> {
  const entries = await fs.readdir(sourceDirectory, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (isExcludedFromCopy(entry.name)) {
      continue;
    }
    const label = joinLabel(prefix, entry.name);
    const sourcePath = path.join(sourceDirectory, entry.name);
    const destinationPath = path.join(destinationDirectory, entry.name);
    const entryStat = await fs.lstat(sourcePath);
    if (entryStat.isSymbolicLink()) {
      throw new Error(`Refusing to copy symlink: ${label}`);
    }
    if (entryStat.isDirectory()) {
      budget.entries += 1;
      enforceCopyBudget(budget);
      await fs.mkdir(destinationPath);
      const createdStat = await fs.lstat(destinationPath);
      if (createdStat.isSymbolicLink() || !createdStat.isDirectory()) {
        throw new Error(`Failed to create copied directory: ${label}`);
      }
      await copyDirectoryContents(sourcePath, destinationPath, label, budget);
      continue;
    }
    if (entryStat.isFile()) {
      budget.entries += 1;
      enforceCopyBudget(budget);
      await copyFileWithinBudget(sourcePath, destinationPath, label, budget);
      continue;
    }
    throw new Error(`Unsupported entry type: ${label}`);
  }
}

export async function listProjects(root: string): Promise<ProjectInfo[]> {
  await ensureRoot(root);
  const projectsDirectory = path.join(root, PROJECTS_DIR_NAME);
  const entries = await fs.readdir(projectsDirectory, { withFileTypes: true });
  const projects: ProjectInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }
    const entryPath = path.join(projectsDirectory, entry.name);
    if (await lstatOrNull(path.join(entryPath, IMPORT_MARKER))) continue;
    const entryStat = await fs.lstat(entryPath);
    if (entryStat.isSymbolicLink() || !entryStat.isDirectory()) {
      continue;
    }
    projects.push({ id: entry.name, name: entry.name });
  }
  projects.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return projects;
}

export async function prepareWorkspace(root: string, project: string, runId: string): Promise<string> {
  assertValidId('project', project);
  assertValidId('run', runId);
  await ensureRoot(root);
  const sourceDirectory = await resolveProjectDirectory(root, project);
  return prepareWorkspaceFrom(root, sourceDirectory, runId);
}

export async function prepareWorkspaceFrom(root: string, sourceDirectory: string, runId: string): Promise<string> {
  assertValidId('run', runId);
  await ensureRoot(root);
  const runsDirectory = path.join(root, RUNS_DIR_NAME);
  const runDirectory = path.join(runsDirectory, runId);
  const existingRun = await lstatOrNull(runDirectory);
  if (existingRun) {
    throw new Error('Run workspace already exists');
  }
  await fs.mkdir(runDirectory);
  const createdRun = await fs.lstat(runDirectory);
  if (createdRun.isSymbolicLink() || !createdRun.isDirectory()) {
    throw new Error('Failed to create run workspace');
  }
  const budget: CopyBudget = { entries: 0, bytes: 0 };
  await copyDirectoryContents(sourceDirectory, runDirectory, '', budget);
  return runDirectory;
}

async function collectRunFiles(
  directory: string,
  prefix: string,
  collected: { path: string; bytes: number }[],
): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (collected.length >= MAX_LIST_ENTRIES) return;
    if (LIST_SKIPPED_DIRECTORY_NAMES.has(entry.name.toLowerCase()) || isExcludedFromCopy(entry.name)) {
      continue;
    }
    const entryPath = path.join(directory, entry.name);
    const entryStat = await fs.lstat(entryPath);
    if (entryStat.isSymbolicLink()) {
      continue;
    }
    if (entryStat.isDirectory()) {
      await collectRunFiles(entryPath, joinLabel(prefix, entry.name), collected);
      continue;
    }
    if (!entryStat.isFile()) {
      continue;
    }
    if (collected.length >= MAX_LIST_ENTRIES) {
      throw new Error(`Run workspace listing exceeds ${MAX_LIST_ENTRIES} entries`);
    }
    collected.push({ path: joinLabel(prefix, entry.name), bytes: entryStat.size });
  }
}

export async function listRunFiles(root: string, runId: string): Promise<{ path: string; bytes: number }[]> {
  assertValidId('run', runId);
  await ensureRoot(root);
  const runDirectory = await resolveRunDirectory(root, runId);
  return listDirectoryFiles(runDirectory);
}

export async function listDirectoryFiles(runDirectory: string): Promise<{ path: string; bytes: number }[]> {
  const collected: { path: string; bytes: number }[] = [];
  await collectRunFiles(runDirectory, '', collected);
  collected.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return collected;
}

function parseRelativePath(relative: string): string[] {
  if (typeof relative !== 'string' || relative.length === 0 || relative.includes('\0')) {
    throw new Error('Invalid relative file path');
  }
  if (relative.includes('\\') || /^[a-zA-Z]:/.test(relative) || path.isAbsolute(relative)) {
    throw new Error('Windows or absolute file paths are not allowed');
  }
  if (relative.startsWith('/')) {
    throw new Error('Absolute file paths are not allowed');
  }
  const segments = relative.split('/');
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..' || segment.includes(':')) {
      throw new Error('Invalid relative file path');
    }
  }
  return segments;
}

export async function readRunFile(root: string, runId: string, relative: string): Promise<string> {
  assertValidId('run', runId);
  await ensureRoot(root);
  const runDirectory = await resolveRunDirectory(root, runId);
  return readDirectoryFile(runDirectory, relative);
}

export async function readDirectoryFile(runDirectory: string, relative: string): Promise<string> {
  const segments = parseRelativePath(relative);
  if (segments.some(isExcludedFromCopy)) throw new Error('This file is excluded from project access.');
  const resolved = path.resolve(runDirectory, ...segments);
  if (!isWithin(runDirectory, resolved)) {
    throw new Error('Resolved path escapes the run workspace');
  }
  let current = runDirectory;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const componentStat = await lstatOrNull(current);
    if (!componentStat) {
      throw new Error('Run file not found');
    }
    if (componentStat.isSymbolicLink()) {
      throw new Error('Refusing to read through a symlink');
    }
    if (index < segments.length - 1 && !componentStat.isDirectory()) {
      throw new Error('Run path component is not a directory');
    }
  }
  const fileStat = await fs.lstat(resolved);
  if (!fileStat.isFile()) {
    throw new Error('Run path is not a regular file');
  }
  if (fileStat.size > MAX_READ_BYTES) {
    throw new Error('Run file exceeds 1 MB read limit');
  }
  const [realRunDirectory, realFile] = await Promise.all([fs.realpath(runDirectory), fs.realpath(resolved)]);
  if (!isWithin(realRunDirectory, realFile)) {
    throw new Error('Resolved path escapes the run workspace');
  }
  const data = await fs.readFile(resolved);
  if (data.byteLength > MAX_READ_BYTES) {
    throw new Error('Run file exceeds 1 MB read limit');
  }
  return data.toString('utf8');
}
