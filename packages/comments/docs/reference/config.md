---
title: "Configuration Reference"
description: "Schema, defaults, precedence, and supported languages for .smithers/comments.json."
---

# Configuration Reference

Smithers Comments reads configuration from `.smithers/comments.json` at the repository root (or the path passed to `--config`).

Configuration is optional. When no config file is present, all fields take their documented defaults.

## Full schema

```json
{
  "version": 1,
  "mode": "inline",
  "commentsDir": ".comments",
  "include": [
    "src/**/*",
    "lib/**/*",
    "packages/*/src/**/*"
  ],
  "exclude": [
    "**/node_modules/**",
    "**/.git/**",
    "**/dist/**",
    "**/build/**",
    "**/coverage/**",
    "**/.smithers/**"
  ],
  "preservePragmas": true,
  "extraPragmaPatterns": [],
  "strictExternal": true,
  "disallowEmptyComments": true,
  "disallowEmptyTodo": true,
  "checkRefs": true,
  "checkJSDocParams": true,
  "agent": "heuristic",
  "model": "default",
  "rubric": "Verify that the comment accurately describes the anchored code, adds non-obvious context (why, invariants, edge cases), and does not contradict behavior or signatures.",
  "cacheFile": ".smithers/comments-cache.json",
  "virtualOutDir": ".smithers/comments-view"
}
```

## Fields

| Field                   | Type                                  | Default                                           | Description                                                                                                                                        |
| ----------------------- | ------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`               | `1`                                   | `1`                                               | Config schema version. Must be `1`.                                                                                                                |
| `mode`                  | `"inline" \| "external"`              | `"inline"`                                        | Active workflow mode.                                                                                                                              |
| `commentsDir`           | `string`                              | `".comments"`                                     | Relative directory inside repo root storing external sidecars. Must not be absolute or contain `..`.                                               |
| `include`               | `string[]`                            | `["src/**/*", "lib/**/*", "packages/*/src/**/*"]` | Repo-relative glob patterns for managed source files.                                                                                              |
| `exclude`               | `string[]`                            | see above                                         | Repo-relative glob patterns excluded from scanning. `<commentsDir>/**` is always excluded automatically.                                           |
| `preservePragmas`       | `boolean`                             | `true`                                            | Keep compiler, linter, license, and shebang pragmas in source files.                                                                               |
| `extraPragmaPatterns`   | `string[]`                            | `[]`                                              | Additional regex strings treated as pragmas. Invalid regexes fail config validation with exit code `2`.                                            |
| `strictExternal`        | `boolean`                             | `true`                                            | In `external` mode, report `stray-inline-comment` when a managed source file contains a non-pragma comment.                                        |
| `disallowEmptyComments` | `boolean`                             | `true`                                            | Report `empty-comment` for comments with empty/whitespace-only bodies.                                                                             |
| `disallowEmptyTodo`     | `boolean`                             | `true`                                            | Report `empty-todo` for `TODO` / `FIXME` comments with no explanation text.                                                                        |
| `checkRefs`             | `boolean`                             | `true`                                            | Validate `@ref <symbol>` annotations against declared symbols in the file.                                                                         |
| `checkJSDocParams`      | `boolean`                             | `true`                                            | Validate `@param <name>` tags in doc comments against the anchored function's parameter list.                                                      |
| `agent`                 | `"heuristic" \| "smithers" \| "none"` | `"heuristic"`                                     | Semantic validator engine: `"heuristic"` (deterministic local checks), `"smithers"` (live LLM via Smithers), or `"none"` (structural checks only). |
| `model`                 | `string`                              | `"default"`                                       | Model identifier included in the content-addressed cache key.                                                                                      |
| `rubric`                | `string`                              | see above                                         | Validation rubric passed to the agent and included in the cache key.                                                                               |
| `cacheFile`             | `string`                              | `".smithers/comments-cache.json"`                 | Relative path to the persistent validation cache file.                                                                                             |
| `virtualOutDir`         | `string`                              | `".smithers/comments-view"`                       | Default output directory used by Smithers virtual file targets.                                                                                    |

## Precedence

1. Explicit CLI flags (`--mode`, `--dir`, `--cache`, `--offline`, `--no-cache`)
2. `.smithers/comments.json` (or `--config <path>`)
3. Built-in defaults

Invalid JSON, unknown schema version, invalid `mode`, path traversal in `commentsDir` (`..` or absolute path), or invalid regex in `extraPragmaPatterns` fails immediately with exit code `2`.

## Supported languages

| Family    | Extensions                                                                                                                                                                               | Line delimiter | Block delimiter | Doc delimiter  |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | --------------- | -------------- |
| `c-style` | `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.vibe`, `.go`, `.rs`, `.c`, `.h`, `.cpp`, `.cc`, `.hpp`, `.java`, `.kt`, `.swift`, `.cs`, `.zig`, `.sol`, `.css`, `.scss` | `//`           | `/* ... */`     | `/** ... */`   |
| `hash`    | `.py`, `.sh`, `.bash`, `.zsh`, `.rb`, `.yaml`, `.yml`, `.toml`, `.r`                                                                                                                     | `#`            | `#`             | `#`            |
| `dash`    | `.sql`, `.lua`, `.hs`                                                                                                                                                                    | `--`           | `--`            | `--`           |
| `markup`  | `.html`, `.xml`, `.svg`                                                                                                                                                                  | `<!-- ... -->` | `<!-- ... -->`  | `<!-- ... -->` |

Files with unsupported extensions (or binary files containing NUL bytes) are skipped gracefully during directory discovery.
