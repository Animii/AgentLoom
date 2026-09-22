import { createHash } from 'node:crypto';
import type { Run } from '../shared/types.js';

export function automationContract(run: Run): string {
  const escalation = run.automation?.escalation;
  return createHash('sha256')
    .update(
      JSON.stringify({
        task: run.task,
        plan: run.steps[0].output,
        definitions: run.steps.map((s) => s.definition),
        // Preserve old authorizations exactly. Mutable usage counters are not policy.
        ...(escalation
          ? {
              escalation: {
                provider: escalation.provider,
                model: escalation.model,
                effort: escalation.effort,
                maxAttempts: 1,
              },
            }
          : {}),
      }),
    )
    .digest('hex');
}
