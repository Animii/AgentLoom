# run-status

`scripts/run-status.mjs` is a read-only developer tool that looks up a single AgentLoom
run through the local HTTP API and prints a compact summary. It uses only Node built-ins
and performs a single `GET` request; it never writes to the API.

## Usage

```
node scripts/run-status.mjs RUN_ID [--url URL] [--json]
```

- `RUN_ID` (required) matches `/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/`, so ids are 1-80
  characters of letters, digits, `_` or `-` and must not start with `_` or `-`.
- `--url URL` overrides the API origin. Defaults to `http://127.0.0.1:4317`.
  The value must be an `http` or `https` origin with no credentials, query, fragment
  or non-root path. A single trailing slash is accepted. The raw value is validated
  before URL normalization, so empty `?`/`#` markers, dot segments, percent-encoded
  dots, backslashes and whitespace are rejected rather than silently normalized away.
- `--json` prints one JSON object instead of the labelled text output.

Importing the module has no side effects. `summarizeRun(run)` is exported for
programmatic use.

## Examples

```bash
# Text summary from the default local API
node scripts/run-status.mjs 8f3c2a1b

# Summary from a different origin
node scripts/run-status.mjs 8f3c2a1b --url http://127.0.0.1:4319

# Machine-readable output for scripts
node scripts/run-status.mjs 8f3c2a1b --json
```

Example text output:

```
ID: 8f3c2a1b
Title: Add run status CLI
Status: running
Step: Implement
Automation: active
PR: -
```

Values that are absent (no automation, no pull request, or a `currentStep` beyond the
last step) are printed as `-`. The JSON form returns exactly
`{id, title, status, step, automation, prUrl}` with `null` for absent optional values.

## Semantics

- `step` is the name from `steps[currentStep].definition.name`, or `null` when
  `currentStep` is out of range.
- `automation` is `automation.status`, or `null` when the run has no automation state.
- `prUrl` is `git.prUrl`, or `null` when no pull request has been published.
- A successful lookup exits `0` even when the run itself is `failed`, `blocked` or
  `cancelled`: the command reports the status, it does not judge it.
- Requested data must have the documented shape. A response whose required fields
  (`id`, `title`, `status`, `steps`, `currentStep`) or used optional nested fields
  (`automation.status`, `git.prUrl`) have the wrong type is rejected as an error.

## Exit codes

| Code | Meaning |
| ---- | ------- |
| `0`  | Summary printed, regardless of the run status |
| `1`  | HTTP error, network failure, timeout, invalid JSON or invalid response shape |
| `2`  | Usage error: missing, duplicate, invalid or unknown arguments |

Errors are written to stderr only and never include the response body or echoed argument
values, so credentials cannot leak through error output. The request uses redirects
disabled (`redirect: "error"`), a fixed 3000 ms abort timeout and a fixed
`GET /api/runs/:id` argument array with `shell: false`.
