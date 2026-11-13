---
title: TODO issue picker state
status: done
area: todos
owner: codex
updated: 2026-11-12
links:
  - https://github.com/smithersai/smithers/issues/5290
---

Keep each orphan TODO's issue choice in a tab-local collection exposed through
TODO queries and actions. Route state and private drafts, including restored
drafts, open the issue store's scoped subscriptions. Components only render
queries and dispatch actions, following FE-3, FE-4 and FE-5 in the rulings.

This uses the local-state and sync entries in
[the library catalog](../../../../docs/libraries.md):
`@smthrs/effect-tanstack-db` collections/live queries and the existing
`@smthrs/effect-electric` issue subscriptions. Startup failures retain a
`todos.issue.load` record with a sanitized code; cancellation propagates.

Validation: all 388 TODO, package-rule and device-schema tests pass, including
four picker regressions. The three lifecycle and selection regressions fail
against the unmodified source. Scoped TODO lint passes; whole-app lint retains
16 unrelated errors, compared with 18 on the base.
