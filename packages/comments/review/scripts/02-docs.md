# Smithers Comments — Docs-Driven Specification Review

## card: _Docs-Driven Development_|Nine end-user docs written before code

Every behavior of Smithers Comments was written as end-user documentation first — nine pages covering quickstart, modes, sidecar grammar, virtual files, caching, CLI flags, config schema, and the Effect TypeScript API.

## code: Pragma preservation · built into the contract

```ts src/retry.ts · after extract
#!/usr/bin/env node
// SPDX-License-Identifier: MIT
export function retry(attempts: number) {
  // @ts-expect-error intentional demo pragma
  /* eslint-disable-next-line no-console */
  return attempts * 100
}
```

```text Built-in pragmas never stripped
Shebangs       #! on line 1
Licenses       SPDX-License-Identifier, Copyright
TypeScript     @ts-expect-error, @ts-ignore, @ts-nocheck
Linters        eslint-disable, biome-ignore, dprint-ignore
Go / Rust      go:generate, go:embed, clippy::, nolint
Python         noqa, type: ignore, pyright:, mypy:
```

Compiler, linter, coverage, and license _pragmas_ always stay in source code. Only prose comments move into external sidecars, and custom regexes extend the list through config.

## compare: _Anchor resilience & virtual projection_

```md .comments/src/retry.ts.md · symbol anchor
---

## source: src/retry.tsversion: 1

## @retry-doc

anchor: symbol retry
line: 3
placement: before
style: doc
code-hash: 9f81c2a0

Computes linear retry backoff in milliseconds.
```

```ts VirtualFile.projectFile · woven on demand
#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Computes linear retry backoff in milliseconds.
 */
export function retry(attempts: number) {
  return attempts * 100
}
```

Sidecars anchor by _symbol_, _pattern_, _line_, or _file_, plus an eight-hex SHA-256 code hash. Even if lines shift above a function, symbol anchors resolve cleanly and virtual projection weaves comments back with exact indentation and language delimiters.

## code: Content-addressed Smithers cache key

```ts Cache.computeCacheKey
cacheKey = sha256(canonicalJson({
  schemaVersion: 1,
  path,
  language,
  mode,
  commentId,
  commentStyle,
  commentBody,
  anchoredCodeRegion,
  rubric,
  modelId
}))
```

```text Exact CLI exit codes
0   Clean pass or completed cleanly
1   Validation error or virtual drift (--check)
2   Invalid CLI flags or .smithers/comments.json
3   Missing file, malformed sidecar, anchor error
4   Workflow or agent execution failure
```

Unchanged comments hit the Smithers cache in milliseconds with _zero_ model calls. Editing one function invalidates only the comments anchored to that function — and every CLI exit code from zero to four is pinned by the docs and verified by tests.
