---
title: Conditional prefix update callback identity
status: done
area: crypto
owner: codex
updated: 2026-11-13
links:
  - https://github.com/smithersai/smithers/issues/4666
---

Preserve statement-head parentheses when deciding whether a line break before
`++` or `--` ends an operand. Keep conditional updates distinct from empty
statement bodies while retaining ASI after genuine operands and do-while tails.
Recognize nested do bodies with iterative continuations, including ASI
expression bodies, without changing existing scope estimation.

The original implementation fails 13 new regressions while all 9 original
operand-boundary controls pass. The completed suite passes all 354 tests with
100% statements, branches, functions and lines. Both new properties ran 1,000
cases each, covering binding renames and nested statements; fixed controls
include every line terminator, multiline comments, and depths through 1,024.
Package typecheck, lint, formatting and the four API-reference checks pass.
