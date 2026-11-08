---
title: Browser platform failure regressions
status: done
area: platform-browser
owner: codex
updated: 2026-10-21
links: []
---

Use the library catalog's `@smthrs/platform-browser` host entry and `@smthrs/flow` RetryPolicy failure classifier. Reproduce worker startup, language-server cancellation, URI decoding, runtime initialization, shared filesystem construction and SQL interruption findings on Latitude. Preserve real browser transport and SQLite fixtures.

Regressions reproduced before fixes on Latitude:
- Worker factory `TypeError` defected construction instead of returning an unavailable client.
- A timed-out workspace read left the next language-server sync timing out.
- Malformed file URIs threw `URIError`.
- A failed telemetry Effect Layer produced no `EngineStopped` message.
- Interrupting BEGIN discarded transaction state and caused COMMIT after handover to fail with `TransactionLost`.

Not reproduced:
- Unchanged replay rows: the real SQLite handover tests pass; Effect 4.0.5 structurally compares ordinary arrays and row objects.
- BrowserServices filesystem identity: no failing behavioral regression established. Both inputs are opaque caller-owned adapters, with no public interpreter filesystem identity to inspect. Left unchanged.

Validation: Latitude `pnpm exec vitest run --silent`: 25 files, 303 tests passed, 100% statements, branches, functions and lines. Existing real MessageChannel, Web Locks, BroadcastChannel and wa-sqlite tests retained. Runtime setup and engine client failure records contain only failure tags or names. Public failure semantics documented in platform-browser's durable engine guide.

Latitude ESLint, TypeScript test-project checking and dprint also passed.

Astra review identified interrupted dependency, widening and library loads retaining incomplete caches. Three additional real TypeScript regressions failed before the repair. Interrupted traversals now roll back only new cache entries and byte accounting; widening becomes complete after its reads. Existing overlays and completed caches remain intact.

Astra reviewed the recovery fix with no remaining concrete findings. Fable review was not available through the exposed model tools.
