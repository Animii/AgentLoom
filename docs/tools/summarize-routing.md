# summarize-routing

`scripts/summarize-routing.mjs` projects a local run JSON file into a small summary of automation routing usage. It uses only Node built-ins, reads only the supplied file, and opens no network connections or child processes.

## Command

```sh
node scripts/summarize-routing.mjs RUN_JSON_FILE
```

The file must contain a single run object with string `id` and `status` fields. Success writes formatted JSON plus a trailing newline to stdout:

```json
{
  "runId": "run-1",
  "status": "completed",
  "repairsUsed": 1,
  "escalationUsed": false,
  "decisions": [
    {
      "choice": "complete",
      "action": "complete",
      "confidence": 0.8,
      "offeredActions": null
    }
  ]
}
```

The same projection is available by importing the module:

```js
import { summarizeRouting } from '../scripts/summarize-routing.mjs';
```

Importing has no side effects; the CLI runs only when the module is the entry point.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Summary written to stdout. |
| `1` | File read, JSON parse, or projected-shape failure. stderr holds a concise message, never file contents or a stack. |
| `2` | Missing or extra arguments. stderr holds the usage line only. |

## Projection

The result contains exactly `runId`, `status`, `repairsUsed`, `escalationUsed`, and `decisions`. Each decision projects exactly `choice`, `action`, `confidence`, and `offeredActions`.

- Absent (missing or `undefined`) `automation` yields `repairsUsed: 0`, `escalationUsed: false`, and an empty `decisions` array. An explicit `null` is present and fails validation.
- A present `automation` must be an object with a nonnegative safe-integer `repairsUsed` and an array `decisions`; otherwise `summarizeRouting` throws `TypeError`.
- Optional `automation.escalation` must be an object with a boolean `used`; when missing or `undefined` it means `false`. An explicit `null` fails validation.
- Each decision needs string `choice` and `action`, and a finite `confidence` within `[0, 1]` inclusive. Optional `offeredActions` must be an array of strings; when missing or `undefined` it is projected as `null`. An explicit `null` fails validation.
- `decisions` and `offeredActions` must be dense arrays. Sparse arrays with holes are rejected with `TypeError` rather than projecting a missing decision as `null`. JSON input cannot contain holes, but the exported function can receive them.
- Unknown fields, including `task`, prompts, reasons, logs, credentials, model data, and timestamps, are ignored and never copied to the output.
- The input run is not mutated, and returned decisions and action arrays are fresh copies.

## Limits

- The utility validates shape only. It does not verify that `choice` or `action` values are meaningful route names, and it does not compare decisions with a workflow contract or reviewer verdicts.
- Only a missing or `undefined` optional field is treated as absent. Explicit `null` values (`automation`, `automation.escalation`, `offeredActions`) are rejected.
- The summary is derived solely from the given file; no run store, server, or network source is consulted.
- Read, parse, and shape failures are reported on stderr only; stdout stays empty on failure.
