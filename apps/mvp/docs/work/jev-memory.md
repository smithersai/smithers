---
title: Jev opening memory and skill selection
status: done
area: agent
owner: Codex jev-memory
updated: 2026-10-21
links: [../features/memory.md, ../decisions/0027-opening-memory.md]
---

AGENT-5, with Will's wiki correction. Preserved the existing isolated workspace.
Previous behavior is recorded in the feature document from Memory.ts, internal/memory/wiki.ts and harness Relevance.ts.

Implemented SDK Opening source injection, balanced keyword shortlisting, UTF-8-bounded queries and full escaped-context budgeting.
The app seals retrieval before the Jev ModelStep, freezes selected rows before Respond, filters saved-flow descriptions, and offers the scoped public app/memory/remember flow.
Wiki, filesystem discovery and cross-device memory sync are deferred. Existing sign-out wipes the engine database.

Executed 2026-10-21 in this workspace:
- SDK: 48 tests, including 41 existing snapshot cases; Opening.ts 100% statements/branches/functions/lines. `/tmp/jev-sdk-final-2.log`.
- App: `pnpm --filter @smthrs/mvp eval:memory`: 7 tests (three real-model evals), new memory.ts and memoryFlows.ts 100% statements/branches/functions/lines. `/tmp/jev-memory-final-3.log`.
- Evals prove memory-only fact use, actual responder skill filtering, debug counts, transient source recovery, faulty judge failure, public remember-to-production recall, and crash/resume without another recall or judgment.
- Registry/instructions checks passed; telemetry's four real relay tests passed (`/tmp/jev-telemetry-final.log`).
- Browser build passed (`/tmp/jev-build-final-1.log`). App, eval and SDK type checks plus SDK lint passed with empty error logs (`/tmp/jev-*-types-final-2.log`, `/tmp/jev-lint-final-2.log`). Final agent regression: 18 passed and one ordering case timed out under concurrent load; that unchanged ordering case passed isolated (`/tmp/jev-ordering-final-1.log`). An earlier full agent run passed all 19.

Astra and Fable reviewed. Fixed separate retrieval sealing, follow-up context, production skill discovery/writer, source retry classification, shortlist starvation and wrapper-word bias. Catalog outages intentionally fail visibly after bounded durable retries, rather than silently omitting skills.
No push or main movement; the lead/lander owns landing.
