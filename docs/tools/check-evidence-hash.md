# check-evidence-hash

`scripts/check-evidence-hash.mjs` verifies that a file's raw bytes match an expected
SHA-256 digest. It is a read-only developer utility built only on Node built-ins: it
writes nothing, makes no network requests and starts no child processes.

## CLI

```text
node scripts/check-evidence-hash.mjs FILE EXPECTED_SHA256
```

Example:

```text
$ node scripts/check-evidence-hash.mjs AGENTS.md 3243389765a4c024e435cddcfa282fb92ef9b28138603866b81cf4f09b93d229
{"ok":true,"expected":"3243389765a4c024e435cddcfa282fb92ef9b28138603866b81cf4f09b93d229","actual":"3243389765a4c024e435cddcfa282fb92ef9b28138603866b81cf4f09b93d229","bytes":717}
```

On a match or a mismatch the CLI prints exactly one JSON object followed by a newline:
`{"ok":true|false,"expected":"...","actual":"...","bytes":N}`. `ok` is exact hash
equality, `expected` echoes the argument, `actual` is the computed digest and `bytes` is
the byte count of the file.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Digest matches. |
| 1 | Digest does not match, or the file could not be read. |
| 2 | Missing, extra or invalid arguments. Usage text goes to stderr before any file is read. |

Read failures write a single concise stderr line with the error code (for example
`ENOENT`). File contents and stack traces are never printed. Usage errors write only
stderr; successful runs write only stdout.

## API

```js
import {checkEvidenceHash} from './scripts/check-evidence-hash.mjs';

const result = await checkEvidenceHash('evidence.json', expectedHash);
// {ok: true, expected: '...', actual: '...', bytes: 1192}
```

- `file` must be a nonempty string and `expectedHash` must be exactly 64 lowercase
  hexadecimal characters. Invalid arguments reject with `TypeError` before any
  filesystem access.
- The resolved value is exactly `{ok, expected, actual, bytes}`: `ok` is exact hash
  equality, `expected` is the argument as given, `actual` is the computed digest and
  `bytes` is the number of bytes read.
- Missing or unreadable files reject with the underlying filesystem error, such as
  `ENOENT`, `EACCES` or `EISDIR`.
- Importing the module has no side effects; only direct CLI execution runs the command.

## Exact-byte semantics

The file is hashed as stored on disk. Its bytes are not parsed, decoded, newline
translated or Unicode normalized, so a JSON file's formatting, a CRLF versus LF line
ending and arbitrary binary content all change the digest. The digest is SHA-256 from
`node:crypto`, rendered as 64 lowercase hexadecimal characters, and equality with
`expectedHash` is an exact string comparison.

The empty file always hashes to
`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

## Memory limitation

The entire file is read into memory in one `readFile` call before hashing. There is no
arbitrary size limit, but a file larger than available memory cannot be checked; for
very large evidence files, compare a streamed digest or a smaller manifest instead.

## Tests

```text
node --test tests/check-evidence-hash-cli.test.mjs
```

The native `node:test` file covers known raw bytes, empty, binary and CRLF content,
mismatches, invalid exported arguments, validation before filesystem access,
missing and unreadable paths, exact return shape, real CLI match, mismatch, read and
usage behavior with paths containing spaces, and side-effect-free import.
