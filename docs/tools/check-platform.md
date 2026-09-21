# check-platform

`scripts/check-platform.mjs` is a dependency-free health probe for a running AgentLoom platform. It calls `GET /api/health` and reports whether the platform answers with HTTP 200 and a JSON body containing `ok: true` (extra fields such as `version` are allowed).

## Commands

```bash
node scripts/check-platform.mjs
node scripts/check-platform.mjs --url http://127.0.0.1:4317
node scripts/check-platform.mjs --url http://127.0.0.1:4317 --timeout-ms 5000
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--url URL` | `http://127.0.0.1:4317` | Platform origin to probe. |
| `--timeout-ms MS` | `3000` | Whole-request timeout in milliseconds. |

The CLI prints exactly one JSON object on stdout: `{"ok":true}` when healthy, otherwise `{"ok":false,"error":"..."}`. Error messages never include the response body or credentials.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Healthy: HTTP 200 and JSON `{ok:true}`. |
| `1` | Unhealthy: network failure, timeout, redirect, non-200 status, malformed JSON or a body without `ok:true`. |
| `2` | Usage error: invalid, missing, unknown or repeated flags. The message is written to stderr only; stdout stays empty. Usage messages echo only flag-shaped argument names (for example `--bogus`); every other argument text, including credentials, is reported as a generic `Unknown argument` and never echoed. |

## Limits

- `--url` must be an HTTP(S) origin URL: no credentials, query, fragment or path other than `/`. A trailing slash is accepted (`http://127.0.0.1:4317/`). Query and fragment components are rejected even when empty (`http://127.0.0.1:4317?`, `http://127.0.0.1:4317/#`).
- `--timeout-ms` must be a decimal integer from `1` through `60000`.
- Redirects are never followed (`redirect: 'manual'`), so a 3xx response is reported as a failure. The redirect target is not contacted.
- The probe uses `AbortSignal.timeout` for the request. Redirect and non-200 responses are reported without reading the response body, while an HTTP 200 body is read to validate that it is JSON containing `ok: true`. Response body content is never included in returned errors.

## Programmatic API

```js
import { checkPlatform } from '../scripts/check-platform.mjs';

const result = await checkPlatform('http://127.0.0.1:4317', { timeoutMs: 3000 });
// { ok: true } or { ok: false, error: '...' }
```

`checkPlatform(baseUrl, { timeoutMs = 3000 } = {})` validates `baseUrl` and `timeoutMs` before any network activity and throws `TypeError` for invalid input. Importing the module has no side effects; the CLI runs only when the file is executed directly.

## Tests

```bash
node --test tests/check-platform-cli.test.mjs
```

The suite starts local HTTP servers to cover success, wrong status, wrong shape, malformed JSON, connection failure, timeout and redirect rejection, and runs the real CLI for success, failure and usage-error exit codes.
