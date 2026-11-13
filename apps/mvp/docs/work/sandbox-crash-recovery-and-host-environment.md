---
title: Sandbox crash recovery and host environment
status: done
area: sandbox
owner: Codex
updated: 2026-11-13
links: [https://github.com/smithersai/smithers/issues/4686]
---

Image-based AWS sessions reclaim stale task definitions even when the previous
task has stopped or disappeared. Every image acquisition requires
`ecs:ListTaskDefinitions`; a failed listing releases the new definition before
any task starts.

Directory and existing-container sessions accept `hostEnvironment`. Omitting it
preserves bootstrap inheritance through the kernel's browser-safe accessor;
an empty record inherits none. The remote adapter uses the same accessor.
Source lint rejects direct process environment reads.

Uses the [library catalog](../../../../docs/libraries.md)'s injected filesystem
and process services, with the kernel's existing environment filtering. No new
dependency is introduced.

The provider reattachment table includes `CommandSandbox`. Installation docs
list all five declared Smithers dependencies and retain the package's Node
minimum of `22.19.0`.

Validation: all nine regressions fail on the unmodified source. The full
sandbox suite passes `1,039` tests with `100%` statements, branches, functions
and lines; typecheck and lint pass. Permission fixtures run as an unprivileged
user with accessible executable-search directories. Astra and Fable reviews
pass.

The owning redirect, API and LLM projection checks pass. The broader
`pnpm docs:sync` and `pnpm docs:check` commands still fail at the existing
`typescript/unstable/ast` import in
`packages/smithers/migrate/src/Detect.ts`.

