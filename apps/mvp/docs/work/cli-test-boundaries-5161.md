---
title: CLI test boundaries and fault harness ownership
status: done
area: cli
owner: codex
updated: 2026-11-12
links:
  - https://github.com/smithersai/smithers/issues/5161
---

Replace unified CLI module mocks with real commands over isolated stores and
local transports. Inject failures through Effect services. Own and reap crash
test hosts before deleting their fixtures, and verify every injected signal
before subscriber memory sampling.

Validation covers command payload persistence, approval decisions, cancellation,
history addresses, early assertion cleanup, child deadlines, and truncated or
duplicated subscriber histories.

The focused unified CLI and fault suites pass (91 tests), together with the
package typecheck, lint, import rules and target index checks. Mutation checks
prove that ignored command input, unowned children and truncated signal delivery
are detected. Both required source reviews pass.

The package-wide run also exposed credential, SSH and unrelated fixture failures
that reproduce on an unmodified base, plus a terminal-journey timeout that did
not recur in the baseline subset. Package-wide validation is not green.
