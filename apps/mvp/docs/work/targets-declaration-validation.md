---
title: Enforce target declaration contracts
status: done
area: targets
owner: Codex
updated: 2026-11-13
links: [https://github.com/smithersai/smithers/issues/5039]
---

Foundry declarations require their native executor. Literal GitHub policies
and factory projections enforce the constructor's existing value and writer
rules. CI labels reject declared expressions; `matrixNameSuffix: "os"`
preserves generated platform check names without accepting an expression.

Regression coverage exercises each declaration boundary, invalid policy
values, expression rejection and literal and suffixed matrix names.

Validation: all `259` focused regression tests, the package typecheck and
lint, and the build-command reference contract pass. The full package suite
has `3390` passes, `7` unrelated failures and `7` skips; its statement
coverage is `98.98%` against the unchanged `99%` floor. Standard docs
sync/check hit an existing `typescript/unstable/ast` loader failure, also
reproduced on the original source. Generated root CI is byte-identical,
and the affected support and reference projections pass their checks.
