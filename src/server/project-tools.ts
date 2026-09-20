import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { isExcludedFromCopy, readDirectoryFile } from './workspaces.js';

const directory = z.string().max(1000).default('');
const schemas = {
  list_project_files: z.strictObject({ path: directory, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(200).default(100) }),
  read_project_file: z.strictObject({ path: z.string().min(1).max(1000), startLine: z.number().int().min(1).default(1), lineCount: z.number().int().min(1).max(300).default(200) }),
  search_project: z.strictObject({ query: z.string().min(1).max(200), path: directory, caseSensitive: z.boolean().default(false) }),
};
export const PROJECT_TOOL_NAMES = Object.keys(schemas);
export const PLANNING_TOOL_NAMES = ['ask_user', ...PROJECT_TOOL_NAMES];
const descriptions = {
  list_project_files: 'List files and subdirectories in the selected project, without shell commands. Paths are project-relative; empty path means root. Paginated, with nextOffset. Excludes credentials, dependencies and symlinks.',
  read_project_file: 'Read a UTF-8 project file with line numbers, without shell commands. Use project-relative path and startLine/lineCount to page through files. Read-only, at most 1 MB per file and 24,000 characters per response.',
  search_project: 'Search project file contents for a literal string, without shell commands. Returns paths, line numbers and excerpts. Bounded to 200 files and 50 matches; narrow path to a subdirectory when truncated. Read-only.',
};

export async function createProjectTools(workspace: string) {
  const root = path.resolve(workspace);
  if ((await fs.lstat(root)).isSymbolicLink()) throw new Error('Project root must not be a symlink.');
  const canonical = await fs.realpath(root);
  async function resolveDirectory(relative: string) {
    if ((await fs.lstat(root)).isSymbolicLink() || await fs.realpath(root) !== canonical) throw new Error('Project location changed.');
    if (relative.includes('\\') || relative.includes(':') || relative.includes('\0') || path.isAbsolute(relative)) throw new Error('Use a project-relative path.');
    const parts = relative ? relative.split('/') : [];
    if (parts.some(part => !part || part === '.' || part === '..' || isExcludedFromCopy(part))) throw new Error('Project path is not accessible.');
    let current = root;
    for (const part of parts) {
      current = path.join(current, part);
      const info = await fs.lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Project path is not a regular directory.');
    }
    const real = await fs.realpath(current);
    const delta = path.relative(canonical, real);
    if (delta === '..' || delta.startsWith(`..${path.sep}`) || path.isAbsolute(delta)) throw new Error('Project path is not accessible.');
    return current;
  }
  return {
    definitions: PROJECT_TOOL_NAMES.map(name => ({ name, description: descriptions[name as keyof typeof schemas], inputSchema: z.toJSONSchema(schemas[name as keyof typeof schemas]) })),
    async call(name: string, args: unknown): Promise<unknown> {
      if (name === 'list_project_files') {
        const input = schemas.list_project_files.parse(args);
        const location = await resolveDirectory(input.path);
        const entries = (await fs.readdir(location, { withFileTypes: true })).filter(entry => !isExcludedFromCopy(entry.name) && !entry.isSymbolicLink() && (entry.isFile() || entry.isDirectory())).sort((a, b) => a.name.localeCompare(b.name));
        return { path: input.path, entries: entries.slice(input.offset, input.offset + input.limit).map(entry => ({ path: [input.path, entry.name].filter(Boolean).join('/'), type: entry.isDirectory() ? 'directory' : 'file' })), nextOffset: entries.length > input.offset + input.limit ? input.offset + input.limit : null };
      }
      if (name === 'read_project_file') {
        const input = schemas.read_project_file.parse(args);
        await resolveDirectory('');
        const text = await readDirectoryFile(root, input.path);
        if (text.includes('\0')) throw new Error('Binary files are not supported.');
        const lines = text.split(/\r?\n/);
        const content: { line: number; text: string }[] = [];
        let size = 0;
        for (let i = input.startLine - 1; i < Math.min(lines.length, input.startLine - 1 + input.lineCount); i++) {
          if (size + lines[i].length > 24000) {
            if (!content.length) throw new Error('This line exceeds the read response limit. Use search_project for an excerpt.');
            break;
          }
          content.push({ line: i + 1, text: lines[i] }); size += lines[i].length;
        }
        return { path: input.path, totalLines: lines.length, lines: content, nextLine: content.length && content.at(-1)!.line < lines.length ? content.at(-1)!.line + 1 : null };
      }
      if (name === 'search_project') {
        const input = schemas.search_project.parse(args);
        await resolveDirectory(input.path);
        const queue = [input.path]; const matches: { path: string; line: number; text: string }[] = [];
        let scannedFiles = 0; let skippedFiles = 0; let visited = 0; let truncated = false;
        const needle = input.caseSensitive ? input.query : input.query.toLowerCase();
        outer: while (queue.length) {
          const dir = queue.shift()!;
          const entries = await fs.readdir(await resolveDirectory(dir), { withFileTypes: true });
          for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (++visited > 3000 || scannedFiles >= 200) { truncated = true; break outer; }
            if (isExcludedFromCopy(entry.name) || entry.isSymbolicLink()) continue;
            const relative = [dir, entry.name].filter(Boolean).join('/');
            if (entry.isDirectory()) { queue.push(relative); continue; }
            if (!entry.isFile()) continue;
            scannedFiles++;
            let text: string;
            try { text = await readDirectoryFile(root, relative); } catch { skippedFiles++; continue; }
            if (text.includes('\0')) { skippedFiles++; continue; }
            const lines = text.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              const at = (input.caseSensitive ? lines[i] : lines[i].toLowerCase()).indexOf(needle);
              if (at < 0) continue;
              matches.push({ path: relative, line: i + 1, text: lines[i].slice(Math.max(0, at - 80), at + 320) });
              if (matches.length >= 50) { truncated = true; break outer; }
            }
          }
        }
        return { matches, scannedFiles, skippedFiles, truncated };
      }
      throw new Error('Unknown project tool.');
    },
  };
}
