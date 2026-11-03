---
title: Keep cold tab drafts independent of data gate evaluation
status: in-progress
area: repository-access
owner: codex-revoke
updated: 2026-11-04
links: [../decisions/0110-shape-authority.md]
---

Continue movnqlvy: instrument cold startup, preserve fail-closed page queries, restore baseline startup and draft persistence, compare against current main, and obtain a passing review receipt. Do not land or push.

Library catalog: existing `@smthrs/effect-tanstack-db` collections/live queries and `@smthrs/effect-electric` shapes; this gate is core authorization infrastructure.


Cold startup was delayed by SQLite bootstrap work at the ChatStore pins yield, before outbox construction. ChatWrites now initializes local writes ahead of repository display stores. Paired initial verification: median open 231 → 181 ms, first save 327 → 384 ms; typecheck passed. The original change fails the new startup-order regression test. Validation continues after review corrections for failed refusal restoration, authentication over an existing denial, repeated cross-tab refusals, and authorized system-run pages. Review receipts and unprofiled timing evidence are kept outside the public repository; no land or push is authorized.


The rebased full comparison completed: parent 4,029 tests / 8 failures; change 4,112 / 6, no new failing names or suite errors. Subsequent review corrections protect pending refusal events through rollback, timeout and interruption, and isolate comparison keys and completions by repository and request. Targeted verification covers the affected authority, pull, branch and feed behavior. A second stressed repetition had a draft deadline miss despite the first 10/10 result; repeated-test results and review receipts are retained with the external verification artifacts.

Further review corrections register Branch Compare for refusal cleanup and export refusal persistence/cleanup failures. Tests exercise access restoration through PublishStore and inspect the real telemetry relay.

The access regression exposed TanStack’s settled-window publication barrier retaining removed rows in a downstream sorted display during refill. A pinned upstream patch and `@smthrs/effect-tanstack-db` publication service make incremental publication opt-in; the app provides it for all display queries. SDK tests preserve default settlement behavior and verify immediate gated removals and window receipts in both modes.

Review also reproduced a failed lazy demand freezing downstream rows before a later revocation. Incremental queries now withdraw public rows on error and reconcile queued gate changes before source recovery publishes again. Regression tests cover refusal, ownership removal, retained access, and reopening after a fatal demand failure.

The full comparison exposed five queued-branch regressions: the gate lacked the already verified branch route cache as a second attribution source. ConversationOwners now consumes that existing cache through BranchStore; no new storage or permission source is added. A repeated cold draft deadline miss is being diagnosed under the complete chat suite.

The remaining cold-save backlog was SQLite schema bootstrap: its batched CREATE statements each autocommitted. Using the existing driver transactionBatch for global and per-collection bootstrap cut paired median open 196→128 ms and first save 464→213 ms; idle stayed 7 ms. Native SQLite regressions verify transactional initialization and rollback/reopen after an injected schema failure. The existing driver fallback is preserved. Final comparison, repetitions, and review follow this correction.
