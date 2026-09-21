# summarize-run-cost

Developer utility that reads one local AgentLoom run JSON file and prints a compact cost summary as formatted JSON. It uses only Node built-ins.

## Usage

```sh
node scripts/summarize-run-cost.mjs path/to/run.json
```

The command reads only the given local file. It performs no network access, writes no files and starts no child processes. Importing the module has no side effects.

## Output

```json
{
  "runId": "run-123",
  "knownUsd": 1.5,
  "unreportedAttempts": 1,
  "attempts": [
    { "stepId": "build", "attempt": 1, "costUsd": 0.5 },
    { "stepId": "review", "attempt": 1, "costUsd": null },
    { "stepId": "build", "attempt": 2, "costUsd": 1 }
  ]
}
```

- `runId` is the string `run.id`.
- `attempts` lists every execution with `attempt > 0`, ordered as each step's stored `history` first and then that step's current attempt. Steps are processed in array order.
- `knownUsd` is the exact sum of all numeric `costUsd` values in `attempts`.
- `unreportedAttempts` counts entries whose `costUsd` is `null` (partial costs that were never reported).

No rounding or currency formatting is applied. Costs that are not reported stay `null` and are counted, not estimated.

## Cost model

Council costs are already aggregated at step level. The utility reads only `costUsd` from the flattened entries; nested council subreports or other embedded cost fields are ignored on purpose, so they are not counted twice.

Equal `attempt` values are never deduplicated. Stored history can represent separate executions that happen to share an attempt number, and each one is reported.

## Input validation

`summarizeRunCost(run)` requires:

- `run.id`: string
- `run.steps`: array
- for each step: `definition.id` string, `attempt` a nonnegative safe integer, `costUsd` a finite nonnegative number or `null`
- optional `history`: array whose entries have `attempt` a nonnegative safe integer and `costUsd` a finite nonnegative number or `null`

Unused fields are ignored. The input is never mutated. Invalid projected shapes and a `knownUsd` sum that overflows to `Infinity` throw `TypeError`.

## Number precision

Costs are ordinary JavaScript numbers (IEEE 754 binary64), so `knownUsd` is the exact binary64 result of sequential addition. Values such as `0.1 + 0.2` produce `0.30000000000000004`, and the CLI prints that value without rounding. Cost reports that need exact decimal arithmetic should carry their own decimal representation.

## Exit codes

- `0`: summary printed to stdout as formatted JSON plus a trailing newline.
- `1`: the file could not be read, is not valid JSON, or does not match the projected shape. A single concise message is written to stderr; file content and stack traces are never echoed.
- `2`: missing or extra command-line arguments. Usage is written to stderr.

## Programmatic use

```js
import {summarizeRunCost} from '../scripts/summarize-run-cost.mjs';

const summary = summarizeRunCost(run);
```

The exported function is pure apart from throwing `TypeError` on invalid input; it returns exactly `{runId, knownUsd, unreportedAttempts, attempts}`.
