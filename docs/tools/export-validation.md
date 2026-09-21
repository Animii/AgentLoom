# Export validation evidence

`scripts/export-validation.mjs` projects the recorded validation evidence from a local AgentLoom run export into a small JSON document. It reads one local JSON file, makes no network requests and never executes the recorded commands.

## Obtain a run export

Download the run JSON from the local AgentLoom API with `GET /api/runs/:id`:

```
curl -fsS http://127.0.0.1:4317/api/runs/RUN_ID -o run.json
```

Use the host port that reaches your local platform. Any local copy of the run export works.

## Run the exporter

```
node scripts/export-validation.mjs run.json
```

The CLI prints formatted JSON to stdout:

```
{
  "runId": "22aaf2c4-0e7a-40ba-b926-4d365e2fd824",
  "runStatus": "completed",
  "steps": [
    {
      "stepId": "validate",
      "attempt": 1,
      "status": "passed",
      "before": "…sha256…",
      "after": "…sha256…",
      "commands": [
        {
          "executable": "npm",
          "args": ["run", "typecheck"],
          "status": "passed",
          "exitCode": 0,
          "startedAt": "2026-01-01T00:00:00.000Z",
          "finishedAt": "2026-01-01T00:01:00.000Z",
          "truncated": false
        }
      ]
    }
  ]
}
```

- Only steps that recorded validation are included, in run order. A run without validation yields `"steps": []`.
- `args` keep their recorded order. `exitCode` is `null` when the command did not produce one.
- `finishedAt` and `after` are `null` when they were not recorded, for example while validation is still running.
- The projection drops everything else: task text, prompts, model output, command output, signals and credentials. It is read-only and does not run any recorded command.
- Exit codes: `0` success, `1` read, JSON parse or projection error (one concise line on stderr, nothing on stdout), `2` missing or extra arguments.

`summarizeValidation(run)` is also exported for programmatic use. It performs the same projection and throws `TypeError` for malformed input. Importing the module has no side effects.

## Secret warning

The projected `args` are the recorded command arguments, which can themselves contain secrets, for example tokens passed directly on a command line. This exporter removes unrelated run fields, but it is not a general secret scrubber. Review the output before sharing it.
