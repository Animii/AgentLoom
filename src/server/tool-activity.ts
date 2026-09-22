import type { PlanningToolCall } from '../shared/types.js';

// Keep useful routing arguments, never raw result bodies, credentials or MCP URLs.
export function toolInput(input: unknown): PlanningToolCall['input'] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const result: PlanningToolCall['input'] = {};
  for (const key of [
    'path',
    'file_path',
    'filePath',
    'query',
    'pattern',
    'startLine',
    'lineCount',
    'offset',
    'limit',
    'caseSensitive',
  ]) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === 'string') result[key] = value.slice(0, 500);
    else if (typeof value === 'number' || typeof value === 'boolean')
      result[key] = value;
  }
  return result;
}

export function projectToolSummary(name: string, data: unknown): string {
  const result = data as Record<string, unknown>;
  if (name === 'list_project_files' && Array.isArray(result.entries))
    return `${String(result.entries.length)} entries${result.nextOffset !== null ? ' (more available)' : ''}`;
  if (name === 'read_project_file' && Array.isArray(result.lines))
    return `${String(result.lines.length)} lines read${result.nextLine !== null ? ' (more available)' : ''}`;
  if (name === 'search_project' && Array.isArray(result.matches)) {
    const scannedFiles =
      typeof result.scannedFiles === 'number' ? result.scannedFiles : 0;
    return `${String(result.matches.length)} matches in ${String(scannedFiles)} files${result.truncated ? ' (search limit reached)' : ''}`;
  }
  return 'Completed';
}
