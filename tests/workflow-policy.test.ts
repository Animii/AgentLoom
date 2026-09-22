import test from 'node:test';
import assert from 'node:assert/strict';
import { routingOptions } from '../src/shared/workflow-policy.js';
import type { Run, StepRun } from '../src/shared/types.js';

function reviewedRun(): Run {
  const step = (id: string): StepRun => ({
    definition: {
      id,
      name: id,
      role: id,
      provider: 'codex',
      model: 'fake',
      effort: 'high',
      instructions: '',
      access: 'read-only',
      approval: true,
      planning: false,
    },
    status: 'completed',
    attempt: 1,
    output: '',
    error: null,
    sessionId: null,
    feedback: '',
    startedAt: null,
    finishedAt: null,
    costUsd: null,
  });
  const build = step('build');
  build.definition.access = 'workspace-write';
  const validation = step('validation');
  const command = { executable: 'npm', args: ['test'], timeoutMs: 1000 };
  validation.definition.validation = { commands: [command] };
  validation.validation = {
    attempt: 1,
    status: 'passed',
    before: 'source',
    after: 'source',
    startedAt: '',
    commands: [
      {
        command,
        status: 'passed',
        exitCode: 0,
        output: 'Passed',
        truncated: false,
        startedAt: '',
      },
    ],
  };
  const review = step('review');
  review.status = 'waiting_approval';
  const member = {
    id: 'reviewer',
    name: 'Reviewer',
    focus: 'Correctness',
    provider: 'codex' as const,
    model: 'fake',
    effort: 'high',
  };
  review.definition.council = { reviewers: [member] };
  review.council = {
    attempt: 1,
    source: 'source',
    bundleHash: 'bundle',
    bundle: '',
    status: 'pass',
    issues: [],
    startedAt: '',
    reviewers: [
      {
        member,
        status: 'completed',
        output: '',
        costUsd: null,
        report: {
          verdict: 'PASS',
          summary: 'Criteria met',
          criteria: [
            { id: 'AC1', status: 'met', evidence: ['recorded check'] },
          ],
          findings: [],
          resolutions: [],
        },
      },
    ],
  };
  return {
    id: 'run',
    title: 'Task',
    task: 'Approved task',
    project: 'project',
    workflowId: 'workflow',
    workflowName: 'Workflow',
    mode: 'live',
    status: 'waiting_approval',
    steps: [build, validation, review],
    currentStep: 2,
    createdAt: '',
    updatedAt: '',
    workspace: '/virtual',
    error: null,
    automation: {
      version: 1,
      publication: 'manual',
      status: 'active',
      approvedAt: 'approved',
      repairsUsed: 0,
      maxRepairs: 2,
      message: '',
      decisions: [],
    },
  };
}

void test('completion requires validation and independent review of the same source', () => {
  const run = reviewedRun();
  assert.ok(routingOptions(run).criteria.complete);
  const validation = run.steps[1]?.validation;
  assert.ok(validation);
  validation.after = 'different-source';
  assert.equal(routingOptions(run).criteria.complete, undefined);
  assert.deepEqual(Object.keys(routingOptions(run).criteria), [
    'request_clarification',
  ]);
});

void test('a concrete blocker is repairable only within the approved repair budget', () => {
  const run = reviewedRun();
  const evidence = run.steps[2]?.council;
  const report = evidence?.reviewers[0]?.report;
  assert.ok(evidence && report && run.automation);
  run.status = 'blocked';
  evidence.status = 'blocked';
  report.verdict = 'BLOCKED';
  report.findings = [
    {
      id: 'F1',
      criterion: 'AC1',
      severity: 'blocker',
      summary: 'Incorrect transition',
      evidence: ['policy.ts:10'],
    },
  ];
  assert.ok(routingOptions(run).criteria.return_to_implementer);
  run.automation.repairsUsed = run.automation.maxRepairs;
  assert.deepEqual(Object.keys(routingOptions(run).criteria), [
    'request_clarification',
  ]);
});
