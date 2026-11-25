---
title: "Caching and Workflows"
description: "How Smithers Flows and content-addressed comment keys make agentic comment validation fast, deterministic, and incremental."
---

# Caching and Workflows

Validating every comment in a codebase with an LLM on every commit is slow and expensive. Smithers Comments solves this by running every validation and repair pass as a durable, cached **Smithers Flow** (`@smthrs/flows`).

## Two-stage validation pipeline

Every `smithers-comments check` run executes two stages per file:

1. **Stage 1 — Deterministic structural checks (no model calls)**
   - Syntax and lexer verification
   - Empty or placeholder comment checks (`// TODO` with no body when `disallowEmptyTodo: true`)
   - Broken `@ref` symbol references (`@ref SymbolName` where `SymbolName` is not declared in the file or referenced path does not exist)
   - External mode checks: `stray-inline-comment`, `orphan-sidecar` (sidecar whose `source` file does not exist), `dangling-anchor`, `ambiguous-anchor`, `stale-code-hash`, `malformed-sidecar`
2. **Stage 2 — Cached agentic semantic validation (Smithers Flow)**
   - Runs only for comments that pass Stage 1 (or when semantic validation is enabled)
   - Evaluates each comment against its anchored code region and the configured `rubric` using the configured `AgentValidator` service:
     - **Accuracy**: Does the comment contradict what the code does?
     - **Non-redundancy**: Does the comment explain intent, invariants, or edge cases rather than merely restating syntax?
     - **Freshness**: Are parameter names, return values, and behavior still current?

## Content-addressed cache key

Every comment validation result is keyed by a deterministic SHA-256 digest:

```text
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

Implications:

- **Unchanged code + unchanged comment** -> exact cache hit (`0` agent calls, sub-millisecond lookup).
- **Edit line 5 of `foo.ts`** -> only comments whose anchored code region includes line 5 are invalidated; every other comment in `foo.ts` and in the rest of the repository remains a cache hit.
- **Change `rubric` or `modelId`** -> cleanly invalidates stale verdicts without manual cache clearing.
- **Deterministic key order**: `canonicalJson` sorts object keys lexicographically so identical inputs always produce the exact same hash across Node versions and operating systems.

## Smithers Flow architecture

Under the hood, Smithers Comments declares typed Smithers actions and flows using `@smthrs/flows` (`Action.make`, `Flow.make`, `Interpreter.layer`):

- `comments/CheckComment` (`Action`) — validates one comment against its anchored code region via `AgentValidator`.
- `comments/FixComment` (`Action`) — generates a repaired comment text (or recommends removal) for one failing comment via `AgentValidator`.
- `comments/CheckFileFlow` (`Flow`) — runs structural checks, looks up cache entries in `CommentCacheStore`, invokes `comments/CheckComment` only on cache misses, persists new verdicts, and returns a structured `FileCheckResult`.
- `comments/FixFileFlow` (`Flow`) — checks a file, invokes `comments/FixComment` on failing comments, and emits updated file or sidecar edits.
- `comments/RenderVirtualFlow` (`Flow`) — resolves anchors and projects a `VirtualFileTree` with content digests.

Because actions are Effect layers (`Layer.Layer`), callers can swap `AgentValidator` cleanly:

- **Live agentic layer** — calls the configured model (`claude`, `codex`, or custom provider via `@smthrs/model` / CLI runner).
- **Local heuristic layer (`--offline` or `"agent": "heuristic"`)** — runs fast, zero-network semantic heuristics (detecting obvious tautological comments like `// increment counter` above `counter++`, parameter-name mismatches in JSDoc `@param`, stale `code-hash` drift, and empty TODOs) with zero API keys required.
- **Test double layer** — deterministic in-memory `AgentValidator` for unit, property, fuzz, and e2e tests.

## Cache storage

By default, the persistent cache is stored at:

```text
.smithers/comments-cache.json
```

(configurable via `cacheFile` in `.smithers/comments.json` or `--cache <path>` on the CLI). Pass `--no-cache` to bypass reading from the cache on a run, or delete the file to force a cold re-evaluation.
