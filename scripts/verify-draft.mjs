#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PR_NUMBER_PATTERN = /^[1-9][0-9]*$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const GH_TIMEOUT_MS = 15000;
const GH_MAX_BUFFER = 1024 * 1024;
const GH_FIELDS = 'state,isDraft,headRefOid,url';
const USAGE = 'Usage: node scripts/verify-draft.mjs OWNER/REPO PR_NUMBER EXPECTED_COMMIT';

export function verifyDraftMetadata(pr, expectedCommit) {
  if (typeof expectedCommit !== 'string' || !COMMIT_PATTERN.test(expectedCommit)) {
    throw new TypeError('Expected commit must be exactly 40 lowercase hexadecimal characters.');
  }
  if (pr === null || typeof pr !== 'object' || Array.isArray(pr)) {
    throw new TypeError('Pull request metadata must be an object.');
  }
  if (typeof pr.state !== 'string') {
    throw new TypeError('Pull request metadata state must be a string.');
  }
  if (typeof pr.isDraft !== 'boolean') {
    throw new TypeError('Pull request metadata isDraft must be a boolean.');
  }
  if (typeof pr.headRefOid !== 'string' || !COMMIT_PATTERN.test(pr.headRefOid)) {
    throw new TypeError('Pull request metadata headRefOid must be exactly 40 lowercase hexadecimal characters.');
  }
  if (typeof pr.url !== 'string') {
    throw new TypeError('Pull request metadata url must be a string.');
  }
  const issues = [];
  if (pr.state !== 'OPEN') issues.push(`state is ${JSON.stringify(pr.state)}, expected OPEN`);
  if (pr.isDraft !== true) issues.push(`isDraft is ${JSON.stringify(pr.isDraft)}, expected true`);
  if (pr.headRefOid !== expectedCommit) {
    issues.push(`headRefOid ${pr.headRefOid} does not match expected commit ${expectedCommit}`);
  }
  return { ok: issues.length === 0, issues, url: pr.url };
}

function validateArguments([repository, prNumber, expectedCommit, ...extra]) {
  if (repository === undefined || prNumber === undefined || expectedCommit === undefined || extra.length > 0) {
    return { error: USAGE };
  }
  if (!REPOSITORY_PATTERN.test(repository)) {
    return { error: 'Repository must look like OWNER/REPO using letters, digits, dot, underscore or hyphen.' };
  }
  if (!PR_NUMBER_PATTERN.test(prNumber)) {
    return { error: 'PR number must be a positive decimal integer.' };
  }
  if (!COMMIT_PATTERN.test(expectedCommit)) {
    return { error: 'Expected commit must be exactly 40 lowercase hexadecimal characters.' };
  }
  return { repository, prNumber, expectedCommit };
}

function viewPullRequest(repository, prNumber) {
  return new Promise((resolve) => {
    execFile(
      'gh',
      ['pr', 'view', prNumber, '--repo', repository, '--json', GH_FIELDS],
      { shell: false, windowsHide: true, timeout: GH_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER },
      (error, stdout) => {
        if (error) {
          resolve({
            error: error.killed
              ? 'gh pr view timed out.'
              : 'gh pr view failed. Check gh authentication and repository access.',
          });
          return;
        }
        resolve({ stdout });
      },
    );
  });
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = validateArguments(argv);
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
  }
  const viewed = await viewPullRequest(parsed.repository, parsed.prNumber);
  if (viewed.error) {
    process.stderr.write(`${viewed.error}\n`);
    return 1;
  }
  let pr;
  try {
    pr = JSON.parse(viewed.stdout);
  } catch {
    process.stderr.write('gh pr view returned malformed JSON.\n');
    return 1;
  }
  let result;
  try {
    result = verifyDraftMetadata(pr, parsed.expectedCommit);
  } catch (error) {
    process.stderr.write(`${error instanceof TypeError ? error.message : 'gh pr view returned malformed metadata.'}\n`);
    return 1;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
