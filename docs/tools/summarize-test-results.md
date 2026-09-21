# summarize-test-results

Projects the recorded validation steps of an AgentLoom run into a small, stable list of
check summaries. It is a developer utility built only from Node built-ins. It is a
projection, not an overall pass/fail verdict and not a publication gate.

## Usage

```sh
node scripts/summarize-test-results.mjs RUN_JSON_FILE
```

`RUN_JSON_FILE` is a local JSON file containing one run object (for example a run
export whose `steps` carry recorded `validation` evidence). The CLI reads the file,
prints the projection as formatted JSON followed by a newline, and exits `0` even when
recorded checks failed. Exit codes:

| Exit | Meaning |
| --- | --- |
| `0` | Projection printed to stdout, including runs with failing checks. |
| `1` | The file could not be read, is not valid JSON, or does not match the expected shape. One concise stderr line; no raw file content and no stack trace. |
| `2` | Missing or extra command-line arguments. The usage line is written to stderr. |

The utility performs no network access, no file writes and no child-process execution.
Importing `scripts/summarize-test-results.mjs` has no side effects; only direct
execution runs the CLI.

## API

```js
import {summarizeTestResults} from './scripts/summarize-test-results.mjs';

const {runId, checks} = summarizeTestResults(run);
```

`summarizeTestResults(run)` requires a string `run.id` and an array `run.steps`, and
returns exactly `{runId, checks}`. Shape violations throw `TypeError`. The input is
never mutated.

Steps with `validation` set to `undefined` are omitted. A `null` validation is
malformed. Each included step must provide a string `definition.id`, a string
`validation.status`, a string `before`, a string-or-`undefined` `after`, and an array
`validation.commands`. Each command entry must provide a string `command.executable`,
an array of strings `command.args`, a string `status`, an integer-or-`null`
`exitCode`, and a boolean `truncated`. Status strings are preserved as supplied; no
enum is imposed on them.

## Projected shape

Checks flatten in step/command order. Each check contains exactly:

```json
{
  "stepId": "validate",
  "executable": "npm",
  "args": ["run", "test"],
  "status": "failed",
  "exitCode": 1,
  "truncated": false,
  "sourceUnchanged": true
}
```

`sourceUnchanged` is `true` only when the step's `after` fingerprint is a string equal
to its `before` fingerprint. An absent `after` (`undefined`) yields `false`.

## Excluded data

The projection deliberately omits command outputs, prompts, agent output, Jev signals,
timestamps, durations, attempts, timeouts and any other unused fields. Expect only the
keys listed above.

## Secrets warning

Command arguments included in a run's recorded validation are projected verbatim.
Those arguments may contain secrets (for example tokens or URLs with credentials).
This tool is not a general secret scrubber and does not redact, hash or drop `args`.
Treat its stdout as sensitive, avoid pasting it into shared channels, and do not
commit generated projections to the repository.
