---
title: Bun host review repairs
status: done
area: sdk
owner: Codex
updated: 2026-11-13
links: [https://github.com/smithersai/smithers/issues/4787]
---

Library catalog entries: “Spawn a process or touch the filesystem” and “Run flows in a Node or Bun program”, using the existing `@smthrs/platform-bun` services.

Window titles and frames belong to the caller, with only those presentation fields forwarded. Raw file replacements flush data and the parent directory, preserve read-only modes, and retry durability barriers on replay. Confined views retain their native helper's syncing operations. Bun-only storage and collection tests use the real runtime. The listener test closes its scope and rebinds its actual port. Host docs and the redirect-review rubric describe the current implementations.

Validation:

- Node suite: 156 passed, five skipped; 100% statements, branches, functions and lines, including real native Electrobun tests. Bun-only callbacks have documented V8 exclusions.
- Bun suite: 149 passed, four skipped. The focused runtime, collector, listener and replacement group also passed all 14 applicable cases.
- Package typecheck and lint passed. All seven replacement cases passed as an unprivileged user.
- Both sync-refusal regressions failed on the original replacement implementation. The native options test also fails when arbitrary option forwarding is restored.
- Generated API pages, LLM bundles and the documentation redirect map pass their direct drift checks.
- At `077472fb`, desktop typecheck produced the same 28 diagnostics with and without this change. Its three compilation failures also reproduce on the base. A baseline run without the native helper additionally fails the folder service cases.
- `pnpm docs:sync`, `pnpm docs:check`, target-index regeneration and its drift check passed after installing the complete workspace. The initial partial install could not load the migration CLI dependency.
- A Bun shutdown-signal assertion failed once during parallel validation; focused base and patched retries and the final complete single-worker Bun suite passed.

Review corrections cover read-only permissions, native option filtering, pure configuration assertions and both replay sync failures.
