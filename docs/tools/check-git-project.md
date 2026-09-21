# check-git-project

Read-only Git preflight for AgentLoom projects. It answers one question: is this
folder a safe, unambiguous Git checkout that a worktree-based run can start from?

## Usage

```sh
node scripts/check-git-project.mjs FOLDER
```

The script also exports an async function for programmatic use:

```js
import {checkGitProject} from './scripts/check-git-project.mjs';
const report=await checkGitProject('/path/to/project');
```

Importing the module has no side effects. Paths containing spaces are supported.

## Output

A single JSON object is written to stdout:

```json
{
  "ready": true,
  "branch": "main",
  "commit": "3f1c0f4e6a9d2b8c7e5a1f0d9c8b7a6e5d4c3b2a",
  "repository": "owner/repo",
  "issues": []
}
```

- `ready` is `true` only when every readiness condition below is satisfied.
- `branch`, `commit` and `repository` are `null` when they cannot be determined.
  `repository` is the normalized `owner/repo` form, never a raw remote URL.
- `issues` lists concise, human-readable reasons that block readiness. Raw Git
  stderr and credential-bearing remote URLs are never included.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The folder is ready. |
| `1` | The folder is not ready, was not found or is not a directory. JSON is still printed. |
| `2` | Missing or extra arguments. A usage message is written to stderr only. |

## Readiness conditions

1. The folder exists and is the root of a Git repository (a normal checkout or
   a linked worktree root). Subdirectories of a repository are rejected.
2. `HEAD` resolves to a commit; an initial repository without commits is rejected.
3. `HEAD` is attached to a branch; a detached HEAD is rejected.
4. The tracked and untracked working tree is clean (`git status --porcelain`
   is empty). Ignored files do not affect readiness. Untracked files are always
   enumerated, and changes inside submodules always count, even when repository
   configuration such as `status.showUntrackedFiles`, `diff.ignoreSubmodules`
   or `submodule.<name>.ignore` would otherwise hide them.
5. `origin` is present and recognized as a GitHub remote in either form:
   `https://github.com/owner/repo[.git]` or `git@github.com:owner/repo[.git]`.
   Missing, non-GitHub and credential-bearing URLs are reported as issues.
6. The repository is not a partial clone. `extensions.partialClone` and every
   `remote.<name>.promisor` setting are read from local configuration before the
   working tree is inspected. A partial clone (for example a `blob:none` clone)
   is reported as not ready because Git would otherwise lazily fetch missing
   objects, which performs network access and writes new pack files into the
   inspected repository.

## Read-only and offline behavior

The tool only runs local `git` inspection commands (`rev-parse`, `symbolic-ref`,
`config`, `ls-files`, `status`, `remote get-url`) through `execFile` with
`shell:false` and argument arrays. Git hooks and fsmonitor are disabled,
optional index locks are suppressed, and no network access, fetch, push or other
mutation is performed.
Repository-defined content filters (`clean`, `smudge` and `process` drivers) are
disabled for inspection, so no configured filter program is executed and the
working tree is compared without running repository code. Submodule drivers are
neutralized too: checked-out submodules, including nested ones, are discovered
from the repository root and their filters are disabled for the `status` call,
which otherwise also inspects them. A checkout whose files compare clean only
after such a filter runs is conservatively reported as not ready; built-in
conversions such as line-ending handling still apply.

Filter discovery fails closed. If a repository's or submodule's configuration
cannot be read completely — for example because the variable list exceeds the
discovery output limit or the configuration is malformed — the working-tree
`status` call is skipped and the folder is reported as not ready. Incomplete
filter discovery is never treated as a clean working tree.

Partial-clone handling also fails closed, and the check itself is offline.
Before the working-tree `status` call, `extensions.partialClone` and any
`remote.<name>.promisor` value are read with `git config`, which only reads local
configuration and never contacts a remote. If a promisor remote or the partial
clone extension is present — even under a renamed remote — the `status` call is
skipped and the folder is reported as not ready, so no missing object is fetched
and no pack file is written into the inspected repository. If the fetch
configuration cannot be read at all, the folder is likewise reported as not
ready rather than inspected. `GIT_NO_LAZY_FETCH=1` is exported as defense in
depth for Git versions that support it, and no fetch is ever requested.

Inspection is read-only. A folder that is not the repository root is rejected
before the working-tree `status` call runs, so a subdirectory check never causes
Git to enter sibling submodules or execute their code. Inspected folders are
never modified and no files are created in them.
