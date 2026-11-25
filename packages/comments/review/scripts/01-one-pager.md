# Smithers Comments — 1-Pager Review

## card: _Smithers Comments_|Agentic comment workflows powered by Smithers

Smithers Comments is a simple, focused workflow that keeps codebase comments accurate in _two_ modes: inline, or completely external in a dot comments folder.

## compare: _Two modes, one workflow_

```ts inline mode · comments live in code
/** Verifies a signed session token. */
export function verifyToken(token: string) {
  // Reject empty input before hashing.
  return token.length > 0
}
```

```md external mode · .comments/src/token.ts.md
---

## source: src/token.tsversion: 1

## @verify-token-doc

anchor: symbol verifyToken
line: 1
placement: before
style: doc
code-hash: 9f81c2a0

Verifies a signed session token.
```

In _inline_ mode, comments stay in your code and Smithers continuously lints and validates them with content-addressed caching. In _external_ mode, prose comments move to dot comments so source files stay clean for humans and agents.

## code: Zero-config CLI · inline or external

```sh
# Validate comments incrementally (cached per code region)
bunx smithers-comments check

# Move prose comments into .comments/ (pragmas stay in code)
bunx smithers-comments init --mode external --dir .comments
bunx smithers-comments extract

# Project commented virtual files without touching source
bunx smithers-comments render --out .smithers/comments-view
```

```text 6 clean verbs
init      Configure inline or external mode
check     Structural + cached agent lint (alias: lint)
fix       Agentic repair & re-anchoring workflow
extract   Move prose comments to .comments/
render    Generate virtual commented files
status    Counts, anchor health, cache stats
```

The one-pager follows Smithers' intentionally simple landing page style: one copyable command above the fold, links to docs and source, four clear workflow steps, the two modes side by side, and the six CLI verbs.

## code: PACKAGE.ts · Smithers virtual files

```ts
import { Smithers } from "@smthrs/targets"
import { targets } from "smithers-comments"

const comments = targets({
  mode: "external",
  commentsDir: ".comments",
  include: ["src/**/*.ts"],
  virtualOutDir: ".smithers/comments-view"
})

export const Package = Smithers.Package({
  targets: { ...comments }
})
```

Under the hood, everything runs on _Smithers_ — durable flows, content-addressed caching, and virtual file targets built on Filegroup, Generate, and Materialize.
