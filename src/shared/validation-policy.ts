import { createHash } from 'node:crypto';
import type { ValidationEvidence } from './types.js';

export function snapshotFingerprint(
  files: { relative: string; content: Buffer }[],
): string {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.relative + '\0');
    hash.update(createHash('sha256').update(file.content).digest());
  }
  return hash.digest('hex');
}
export function evidenceSummary(evidence: ValidationEvidence) {
  return `Recorded validation: ${evidence.status}.\n${evidence.commands.map((c) => `${JSON.stringify([c.command.executable, ...c.command.args])}: ${c.status}; exit=${String(c.exitCode ?? 'none')}${c.truncated ? ' (output truncated)' : ''}`).join('\n')}\nSource unchanged during validation: ${String(evidence.before === evidence.after)}.\nJev signals (advisory): ${JSON.stringify(evidence.signals ?? { status: 'unavailable' })}`;
}
