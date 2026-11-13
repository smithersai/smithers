---
title: File tree outage recovery and durable failure causes
status: in-progress
area: flows
owner: codex-ftretry-recovery
updated: 2026-11-04
links: []
---

Two in-place changes: bounded durable retries for issue filing, then persisted failure diagnostics and CLI display. Uses the catalogued @smthrs/flow round timers and @smthrs/engine-store state, journal and inspection APIs; no new library. No landing or push is authorized for this lane.

Permanent row failures retain their key, HTTP status and cause in the completed report, skip dependent descendants and leave unrelated rows running. Only 401/403 abort for token refusal. This covers shape lookup and create/link/work stages; Electric cursor resets retain their existing protocol behavior. All failed rows remain in the report, including those beyond the former 500-entry cap.

Verification outages and exhausted outage budgets classify as retryable infrastructure faults. The round owns the bounded retry budget; actions cannot silently add the engine's default retry window after exhaustion. Current terminal runs cannot resume. The CLI's retryable remedy is generic (a fresh run once the cause clears); the file-tree failure message itself names the plan-specific remedy, a fresh run of the same plan after the outage, with key-marker deduplication.

Terminal diagnostics retain the originating execution, node, action and actual attempts through schema validation, nested-action encoding, failed-attempt persistence and replay. A handled child cannot replace its root's later terminal failure. Only inert own-data, allowlisted, diagnostically redacted, byte-bounded coordinates enter durable cause metadata. The library catalog’s `@smthrs/canonical` entry supplies whole-state admission; optional metadata never displaces typed errors from either replay budget, and truncation preserves Unicode boundaries; signed URLs, non-Bearer authorization, oversized metadata, getters and proxies have regressions. Composite causes retain a separate origin per reason, including after replay and selective parent handling. Terminal resume streams its diagnostic without collecting the history, and optional diagnostic read failures preserve the terminal receipt. Real restart regressions retain the child's three attempts without executing its actions again.

Validation compares the stack with pinned main 5559bfb4fc99fbe766812ef227ba35c3784d3d3c: file-tree, CLI diagnostics, resume, engine-store, engine and flow suites, plus the CLI test typecheck. Both hosts build the native filesystem helper from the tracked source with the pinned Rust toolchain; its digest is recorded with the run. Failed test names must not exceed the baseline. Test outputs, source identities, staging cleanup records and reviewer receipts are retained in the lane operations record. Each change requires its own passing review; no landing or push is authorized.
