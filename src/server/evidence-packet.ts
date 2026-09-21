import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Run, ValidationEvidence } from '../shared/types.js';

/** All retained process evidence, including failures and Docker receipts when configured.
 * A previous result is historical evidence, never proof for changed source. */
export function validationPacket(run: Run) {
  return {
    version: 1, runId: run.id, sourceBaseline: run.sourceBaseline?.fingerprint ?? null,
    validation: run.steps.filter(s => s.definition.validation).map(s => ({
      stepId: s.definition.id, contract: s.definition.validation,
      current: s.validation ?? null,
      history: (s.history ?? []).flatMap(a => a.validation ? [a.validation] : []),
    })),
  };
}

export function packetContents(run: Run): string { return JSON.stringify(validationPacket(run), null, 2); }
export function evidenceHash(contents: string): string { return createHash('sha256').update(contents).digest('hex'); }

export function validationSummary(evidence: ValidationEvidence) {
  return { ...evidence, commands: evidence.commands.map(c => ({ ...c, output: c.output.slice(-2000), fullRecordedOutputInPacket: true })) };
}

export async function writeEvidencePacket(run: Run, dataDir: string): Promise<{ path: string; sha256: string }> {
  const contents = packetContents(run), sha256 = evidenceHash(contents);
  const dir = path.join(dataDir, 'evidence', run.id);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sha256}.json`);
  try { await writeFile(file, contents, { flag: 'wx' }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (evidenceHash(await readFile(file, 'utf8')) !== sha256) throw Error('Saved validation evidence was modified. Inspect the evidence before continuing.');
  }
  return { path: file, sha256 };
}
