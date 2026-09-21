# summarize-changes

`scripts/summarize-changes.mjs` is a dependency-free developer utility that reads a
recorded AgentLoom run as local JSON and prints a normalized summary of the change
manifest produced by the run's council.

It uses only Node built-ins, reads exactly one local file, and never resolves paths,
touches the filesystem beyond that read, opens a network connection, spawns a child
process, or writes to the run data.

## Usage

```sh
node scripts/summarize-changes.mjs RUN_JSON_FILE
```

`RUN_JSON_FILE` is the path to a local JSON file containing a run object. Exactly one
argument is required.

## Manifest selection

The run must contain a `steps` array. Steps are inspected from last to first, and the
last step whose `council.changes` value is present is selected:

- a missing `council`, a missing `changes`, or `changes: undefined` means the step has
  no manifest and is skipped;
- `changes: null` is treated as malformed and is rejected rather than skipped;
- if no step carries a manifest, the utility prints literal `null` and exits `0`;
- validation applies only to the selected manifest, and unused fields are ignored.

## Validation

The selected manifest must satisfy all of the following, otherwise a `TypeError` is
thrown by the exported function (and reported as a concise CLI error):

- `baseline` is exactly 64 lowercase hexadecimal characters (`0-9a-f`);
- `added`, `modified` and `deleted` are arrays of nonempty strings;
- no path appears twice within a list or across lists.

Paths are opaque text. The utility does not normalize, resolve or interpret them, and
duplicate detection is exact string comparison.

## Output

On success the CLI prints formatted JSON followed by a newline. The result has exactly
five keys: the `baseline`, the three path lists sorted with JavaScript's default
lexicographic sort, and `total`, the combined length of the lists. Input is never
mutated.

Given this input:

```json
{
  "steps": [
    {"council": {"changes": {"baseline": "0000000000000000000000000000000000000000000000000000000000000000", "added": ["b.txt"], "modified": [], "deleted": []}}},
    {"council": {"changes": {"baseline": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "added": ["zeta.txt", "Alpha.txt"], "modified": [], "deleted": []}}}
  ]
}
```

the output is:

```json
{
  "baseline": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "added": [
    "Alpha.txt",
    "zeta.txt"
  ],
  "modified": [],
  "deleted": [],
  "total": 2
}
```

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Summary printed, including literal `null` when the run has no manifest. |
| `1` | The file could not be read, did not contain valid JSON, or did not match the validation rules. A concise message is written to stderr with no raw file content and no stack trace. |
| `2` | The argument list was missing the input file or contained extra arguments. |

## Programmatic use

The module exports `summarizeChanges(run)` and has no import side effects:

```js
import {summarizeChanges} from './scripts/summarize-changes.mjs';

const summary = summarizeChanges(JSON.parse(runJson));
```

Shape errors are thrown as `TypeError` by the export; the CLI translates them into the
exit code `1` behavior described above.
