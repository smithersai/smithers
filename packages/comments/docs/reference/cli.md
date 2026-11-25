---
title: "CLI Reference"
description: "Complete command, flag, JSON output, and exit code reference for smithers-comments."
---

# CLI Reference

```sh
smithers-comments <command> [paths...] [options]
```

Running `smithers-comments` with `--help` or `-h` prints usage and exits `0`. Running with `--version` or `-v` prints the package version and exits `0`.

## Global options

| Flag                        | Type    | Description                                                                   |
| --------------------------- | ------- | ----------------------------------------------------------------------------- |
| `--cwd <dir>`               | string  | Repository root directory (defaults to `process.cwd()`).                      |
| `--config <path>`           | string  | Path to configuration JSON file (defaults to `.smithers/comments.json`).      |
| `--mode <inline\|external>` | string  | Override configured mode for this invocation.                                 |
| `--dir <path>`              | string  | Override `commentsDir` for this invocation (default `.comments`).             |
| `--cache <path>`            | string  | Override cache file path (default `.smithers/comments-cache.json`).           |
| `--no-cache`                | boolean | Ignore cached validation verdicts for this run.                               |
| `--offline`                 | boolean | Use the local deterministic heuristic validator instead of an external model. |
| `--json`                    | boolean | Print structured JSON output to stdout instead of human-readable text.        |

## Commands

### `init`

Initialize `.smithers/comments.json` in the repository.

```sh
smithers-comments init [--mode inline|external] [--dir .comments] [--force]
```

| Flag                        | Default     | Description                                          |
| --------------------------- | ----------- | ---------------------------------------------------- |
| `--mode <inline\|external>` | `inline`    | Initial workflow mode.                               |
| `--dir <path>`              | `.comments` | External comments directory (relative to repo root). |
| `--force`                   | `false`     | Overwrite an existing `.smithers/comments.json`.     |

Behavior:

- Creates `.smithers/comments.json` with validated default fields.
- If `--mode external`, ensures `<dir>` exists (creates an empty directory if missing).
- Without `--force`, fails with exit code `3` if `.smithers/comments.json` already exists.

### `check` (alias: `lint`)

Validate comments in the configured mode using structural rules and cached Smithers flows.

```sh
smithers-comments check [paths...] [--strict] [--offline] [--no-cache] [--json]
```

| Flag         | Default | Description                                                                |
| ------------ | ------- | -------------------------------------------------------------------------- |
| `--strict`   | `false` | Treat warnings as errors (exit `1`).                                       |
| `--no-cache` | `false` | Bypass reading from cache (still writes updated results unless read-only). |
| `--offline`  | `false` | Use deterministic local heuristic validator.                               |
| `--json`     | `false` | Emit `CheckReport` JSON.                                                   |

JSON output shape (`--json`):

```json
{
  "mode": "inline",
  "filesScanned": 12,
  "commentsChecked": 34,
  "cacheHits": 33,
  "cacheMisses": 1,
  "agentCalls": 1,
  "diagnostics": [
    {
      "file": "src/auth/token.ts",
      "line": 14,
      "column": 1,
      "severity": "error",
      "code": "stale-comment",
      "commentId": "c_14_1",
      "message": "Comment contradicts implementation."
    }
  ],
  "ok": false
}
```

Exit codes: `0` if `ok` is `true`, `1` if any error diagnostic (or warning under `--strict`) is reported.

### `fix`

Run the Smithers agentic fix workflow to update stale comments, refresh `code-hash` values, re-anchor moved symbols, or remove pure noise comments.

```sh
smithers-comments fix [paths...] [--dry-run] [--offline] [--json]
```

| Flag        | Default | Description                                                                                                                      |
| ----------- | ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `--dry-run` | `false` | Compute and report proposed edits without writing files.                                                                         |
| `--offline` | `false` | Run deterministic local repairs (refresh `code-hash`, re-anchor moved symbols, remove empty comments, fix stale `@param` names). |
| `--json`    | `false` | Emit `FixReport` JSON (`{ mode, dryRun, filesChanged, editsApplied, edits, ok }`).                                               |

### `extract`

Move prose comments from source files into `<commentsDir>/<relpath>.md` sidecars while keeping compiler, linter, shebang, and license pragmas inside source files.

```sh
smithers-comments extract [paths...] [--dir .comments] [--dry-run] [--json]
```

| Flag           | Default              | Description                                                                                                                  |
| -------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `--dir <path>` | config `commentsDir` | Destination folder for sidecar files.                                                                                        |
| `--dry-run`    | `false`              | Show what would be extracted without modifying files.                                                                        |
| `--json`       | `false`              | Emit `ExtractReport` JSON (`{ commentsDir, dryRun, filesProcessed, commentsExtracted, pragmasPreserved, sidecarsWritten }`). |

Behavior:

- Extracts all non-pragma comments from each matched source file.
- Computes stable IDs, symbol/line anchors, placements, styles, and `code-hash` values.
- Writes canonical sidecars to `<dir>/<relpath>.md` and updates the source files with prose comments removed (collapsing blank comment-only lines cleanly without altering code indentation or pragmas).
- Leaves source files with zero prose comments completely untouched.

### `render`

Project source files plus external sidecar comments into commented virtual files.

```sh
smithers-comments render [paths...] [--file <path>] [--out <dir>] [--in-place] [--remove-sidecars] [--check] [--json]
```

| Flag                | Default | Description                                                                                                                            |
| ------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `--file <path>`     | none    | Print the single projected virtual file to stdout (writes nothing to disk).                                                            |
| `--out <dir>`       | none    | Materialize all projected virtual files into `<dir>`, preserving relative paths.                                                       |
| `--in-place`        | `false` | Write projected commented files back onto the original source files.                                                                   |
| `--remove-sidecars` | `false` | Valid only with `--in-place`; deletes consumed sidecar files after writing source files.                                               |
| `--check`           | `false` | Valid with `--out <dir>`; exits `1` if any file on disk in `<dir>` is missing or differs from the virtual projection, without writing. |
| `--json`            | `false` | Emit `RenderReport` JSON (`{ filesRendered, commentsInjected, treeDigest, outDir, driftedFiles }`).                                    |

Validation rules:

- `--file`, `--out`, and `--in-place` are mutually exclusive; combining more than one exits with code `2`.
- `--remove-sidecars` without `--in-place` exits with code `2`.
- `--check` without `--out` exits with code `2`.
- If none of `--file`, `--out`, or `--in-place` is given, `render` projects the virtual tree in memory and prints the summary (or JSON with `--json`).

### `status`

Print repository comment health, active mode, sidecar coverage, and Smithers cache statistics.

```sh
smithers-comments status [--json]
```

JSON output shape (`--json`):

```json
{
  "mode": "external",
  "commentsDir": ".comments",
  "configPath": ".smithers/comments.json",
  "configExists": true,
  "sourceFiles": 12,
  "sidecarFiles": 9,
  "inlineComments": 0,
  "externalComments": 34,
  "pragmasPreserved": 6,
  "cacheEntries": 34,
  "cachePath": ".smithers/comments-cache.json"
}
```

## Exit codes

| Code | Meaning                                                                                                                                         |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Command succeeded with no blocking diagnostics.                                                                                                 |
| `1`  | Validation failed (`check` found error diagnostics, or `render --check` found drift).                                                           |
| `2`  | Invalid command line flags, unknown command, or invalid `.smithers/comments.json` configuration.                                                |
| `3`  | Repository or file error (missing target file, `init` without `--force` over existing config, malformed sidecar, unresolvable anchor conflict). |
| `4`  | Runtime, workflow, or agent execution failure.                                                                                                  |
