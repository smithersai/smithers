---
title: "External Sidecar Format"
description: "Canonical Markdown format for external comment files in .comments/, anchor syntax, and code-hash calculation."
---

# External Sidecar Format

In `external` mode, comments for a source file `<relpath>` are stored at:

```text
<commentsDir>/<relpath>.md
```

For example, with the default `commentsDir: ".comments"`:

- `src/auth/token.ts` maps to `.comments/src/auth/token.ts.md`
- `scripts/deploy.py` maps to `.comments/scripts/deploy.py.md`

Paths always use forward slashes (`/`) and never escape the repository root.

## File structure

A sidecar file consists of YAML frontmatter followed by one or more comment blocks headed by `## @<id>`:

```markdown
---
source: src/auth/token.ts
version: 1
---

## @token-module-overview

anchor: file
placement: before
style: doc
code-hash: 4a90d1e2

Token signing and verification utilities for session cookies.

## @verify-token-doc

anchor: symbol verifyToken
line: 14
placement: before
style: doc
code-hash: 9f81c2a0

Verifies a signed session token and rejects tokens issued before the
account's latest key rotation.

## @clock-skew-note

anchor: line 27
placement: inline
style: line
code-hash: 18bc44f1

Allow 30s skew across edge nodes.
```

## Frontmatter fields

| Field     | Required | Value                                                                         |
| --------- | -------- | ----------------------------------------------------------------------------- |
| `source`  | Yes      | Repository-relative POSIX path to the source file (e.g. `src/auth/token.ts`). |
| `version` | Yes      | Schema version integer. Currently `1`.                                        |

## Comment block header fields

Each block begins with `## @<id>`, where `<id>` matches `/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/` and is unique within the file.

Immediately following the heading are `key: value` metadata lines, terminated by one blank line before the comment body:

| Field       | Required | Allowed values                                                                                         |
| ----------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `anchor`    | Yes      | `file`, `symbol <name>`, `line <positive-int>`, or `pattern <literal-substring>`                       |
| `line`      | No       | 1-based hint/fallback line number (`>= 1`). Recommended on `symbol` and `pattern` anchors.             |
| `placement` | Yes      | `before`, `inline`, or `after`.                                                                        |
| `style`     | Yes      | `line`, `block`, or `doc`.                                                                             |
| `code-hash` | No       | 8 lowercase hex characters (`[0-9a-f]{8}`) — prefix of SHA-256 of the normalized anchored code region. |

Everything after the blank line up to the next `## @<id>` heading (or end of file) is the comment body, with trailing blank lines trimmed.

### Escaping headings inside a comment body

If a comment body itself contains a line beginning with `## @`, the canonical serializer escapes it as `\## @`, and the parser unescapes `\## @` back to `## @`. This guarantees lossless round-tripping for arbitrary comment text.

## Anchor resolution rules

When resolving a comment against a source file:

1. **`file`** — anchors to line `1` (or immediately after a leading shebang/SPDX header when `placement: "before"`), or end of file when `placement: "after"`.
2. **`symbol <name>`** — searches the source file for a declaration matching `<name>` (functions, classes, methods, interfaces, types, constants, Rust `fn`/`struct`/`enum`/`impl`, Go `func`/`type`, Python `def`/`class`).
   - If exactly one declaration matches, resolves to that declaration's line — even if earlier lines were added or removed.
   - If multiple declarations match and a `line` hint is present, selects the match closest to `line`; if no `line` hint is present, reports an `ambiguous-anchor` diagnostic.
   - If no declaration matches, reports a `dangling-anchor` diagnostic.
3. **`pattern <text>`** — searches for lines containing the literal substring `<text>`.
   - Single match resolves directly; multiple matches use `line` as tie-breaker (closest match) or report `ambiguous-anchor`; zero matches report `dangling-anchor`.
4. **`line <n>`** — resolves directly to 1-based line `n` if `1 <= n <= lineCount` (or `lineCount + 1` for trailing `after` comments); otherwise reports `dangling-anchor`.

## Computing `code-hash`

`code-hash` fingerprints the code region a comment describes:

1. Take the resolved anchor line plus up to 4 following non-empty lines (or the anchored single line for `placement: "inline"`).
2. Normalize line endings to `\n`, trim leading and trailing whitespace on each line, and join with `\n`.
3. Compute `SHA-256` over the UTF-8 bytes and take the first 8 lowercase hex characters.

When the anchored code changes, `code-hash` changes, causing `check` to mark the comment stale (`stale-code-hash`) and triggering agentic re-validation (or `fix` to update the comment and refresh `code-hash`).

## Canonical serialization invariant

For every valid `SidecarDocument`:

```ts
parseSidecar(formatSidecar(doc)) === doc
```

Entries are ordered deterministically by `(resolvedLine, placementOrder, id)` where `placementOrder` is `before (0) < inline (1) < after (2)`. Files end with a single `\n`.
