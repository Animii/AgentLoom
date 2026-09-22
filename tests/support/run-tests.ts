import { spawn } from 'node:child_process';
import { readdir, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

// Pure tests are explicitly reviewed; all new files remain covered by integration
// until deliberately moved here. npm test always includes both sets.
const unitFiles = new Set([
  'workflow-policy.test.ts',
  'native-tools.test.ts',
  'tool-order.test.ts',
  'output.test.ts',
  'markdown.test.ts',
]);
const mode = process.argv[2] ?? 'all';
if (!['all', 'unit', 'integration', 'watch', 'coverage'].includes(mode)) {
  throw new Error(`Unknown test mode: ${mode}`);
}
const files = (await readdir('tests'))
  .filter((file) => file.endsWith('.test.ts'))
  .sort()
  .filter((file) =>
    mode === 'unit'
      ? unitFiles.has(file)
      : mode === 'integration'
        ? !unitFiles.has(file)
        : true,
  )
  .map((file) => `tests/${file}`);
const flags = ['--import', 'tsx', '--test'];
if (mode === 'watch') flags.push('--watch');
let command = [...flags, ...process.argv.slice(3), ...files];
if (mode === 'coverage') {
  await mkdir('artifacts/coverage', { recursive: true });
  const require = createRequire(import.meta.url);
  command = [
    require.resolve('c8/bin/c8.js'),
    '--reporter=text',
    '--reporter=lcovonly',
    '--reporter=json',
    '--reports-dir=artifacts/coverage',
    '--include=src/**/*.ts',
    '--include=src/**/*.tsx',
    process.execPath,
    ...command,
  ];
}
const child = spawn(process.execPath, command, {
  stdio: 'inherit',
  windowsHide: true,
});
const code = await new Promise<number>((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (exitCode) => {
    resolve(exitCode ?? 1);
  });
});
process.exitCode = code;
