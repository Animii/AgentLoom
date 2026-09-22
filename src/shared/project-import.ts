export const IMPORT_MAX_FILES = 10000;
export const IMPORT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const IMPORT_MAX_BYTES = 100 * 1024 * 1024;
export const IMPORT_MARKER = '.agentloom-importing';
const excluded = new Set([
  '.git',
  'node_modules',
  '.env',
  '.auth',
  '.data',
  IMPORT_MARKER,
]);
export function excludedProjectPath(value: string): boolean {
  return value.split('/').some((part) => {
    const name = part.toLowerCase();
    return (
      excluded.has(name) ||
      (name.startsWith('.env.') && name !== '.env.example')
    );
  });
}
export function projectSlug(value: string): string {
  return (
    value
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^[-_]+|[-_]+$/g, '')
      .slice(0, 80) || 'my-project'
  );
}
