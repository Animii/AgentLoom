# Verify a draft pull request

`scripts/verify-draft.mjs` is a read-only preflight for the publication transport. Given a repository, a pull request number and the approved commit, it asks the GitHub CLI for the PR metadata and reports whether that PR is an open draft whose head commit is exactly the expected commit.

It uses only Node built-ins, performs no Git or GitHub mutation, and prints no credentials or raw `gh` output.

## Commands

```sh
node scripts/verify-draft.mjs OWNER/REPO PR_NUMBER EXPECTED_COMMIT
```

Example:

```sh
node scripts/verify-draft.mjs acme/loom 42 0123456789abcdef0123456789abcdef01234567
```

The CLI runs exactly:

```sh
gh pr view PR_NUMBER --repo OWNER/REPO --json state,isDraft,headRefOid,url
```

with `shell:false`, `windowsHide:true`, a 15-second timeout and a 1 MiB output cap.

Programmatic use:

```js
import { verifyDraftMetadata } from './scripts/verify-draft.mjs';

const result = verifyDraftMetadata(prMetadata, expectedCommit);
// { ok: boolean, issues: string[], url: string }
```

`verifyDraftMetadata` throws a `TypeError` when the expected commit or the PR metadata is malformed. Importing the module has no side effects.

## Input rules

- Repository: `OWNER/REPO`, where both parts use letters, digits, `.`, `_` or `-`.
- PR number: positive decimal integer without leading zeros.
- Expected commit: exactly 40 lowercase hexadecimal characters.

## Exit codes

| Code | Meaning | Output |
| --- | --- | --- |
| 0 | Verified: `state` is `OPEN`, `isDraft` is `true`, `headRefOid` equals the expected commit. | One JSON object on stdout: `{"ok":true,"issues":[],"url":...}` |
| 1 | Mismatch: valid metadata that fails one or more checks. | One JSON object on stdout with `ok:false` and an `issues` entry per mismatch. |
| 1 | Operational failure: `gh` unavailable, non-zero exit, timeout, malformed JSON or unexpected metadata shape. | Concise stderr only; stdout stays empty and raw `gh` output is never echoed. |
| 2 | Invalid, missing or extra arguments. | Concise stderr only; `gh` is not launched. |

## Limitation

A match verifies commit identity only. It does not prove that tests passed, that review completed, or that the commit is approved; those remain separate gates. This tool never merges, approves, closes or otherwise mutates a pull request.
