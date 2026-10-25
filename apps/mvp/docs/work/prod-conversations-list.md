---
title: Production conversations list loading after f8a2
status: blocked
area: conversations
owner: Codex prod-conversations-list
updated: 2026-10-24
links: [../features/conversations.md, ../decisions/0095-new-conversation-ephemeral-refs.md]
---

Fresh evidence: the Mac mini's evidence folder `prod-f8a2-b`, production
`f8a2b946`, spec tree `8c20ef36`. History and `/new` passed. Archive failed on
**Phone at conversations.spec.ts:87**, before clicking Archive. `devices.json`
ends at Phone's Open Conversations step; none of the archive/reopen steps ran.
This supersedes the first-round run-log interpretation recorded in
`72e0bb13`; that change's regressions are retained and rebased.

Both screenshots show the Open side, blank search, no list and no empty-state
message. The phone's error-context snapshot agrees. This is consistent with
`search.loaded` still false and zero projected rows. The Laptop log records
`branch.open` at 38.67 s, `branch.track` with `outcome: tracked` at 43.54 s,
and settlement at 43.61 s. Phone's last `my-conversations` writer-role log is
44.90 s. A writer-role receipt proves neither a shape response nor installed rows.

No archive request/response exists in this case: the button was never clicked.
The supplied browser logs record question requests, failed requests and console
output, but not successful conversation shape responses. The device JSON holds
chat messages and questions, not `conversation_people` rows. Neither a successful
conversation shape receipt nor its actual rows can be recovered from this bundle.
The selector is consistent with the rendered UI; no incorrect-test assertion was
identified. The production list-loading failure's cause is **unresolved**.

Following OBS-4, add content-free diagnostics before another diagnosis:
`conversations.shape.sync` for first request, answer, changed failure and recovery;
`conversations.list` for changed synced/pending/projected row counts, archived
side and loaded flag. Each records logs, spans and counters through the existing
browser telemetry contract. Successful network receipts are explicitly distinct
from installed/projected rows and the rendered page. No list behavior or E2E
assertion changed. No new library; catalog entries used are the existing
`@smthrs/effect-electric`, `@smthrs/effect-tanstack-db` and
`@smthrs/observability` integration.

Retained real-service coverage from `72e0bb13`:

- Late query activation after ordinary and ephemeral branch opens; cross-device
  archive, persisted reload, archived view and branch reopening.
- Real React screen over Postgres, Electric and device collections: labels,
  links and the Archive button. The DOM host does not prove production sessions,
  OPFS startup or browser worker leadership.
- Exact open/archived personal rows survive migrations 0053–0055.

New coverage asserts actual OTLP exports from the two-device
archive/restore/reopen path, including initial request and unloaded projection,
open/archived counts, logs, spans and counters. It failed red because the shape
record was absent after all behavioral assertions passed. A further real-service
probe leaves a pending branch page before its forge answers and verifies both
lists once the durable track settles. These are real ChatApi/Postgres/Electric
checks using the existing scripted GitHost/Code Storage seam, not live-forge or
browser navigation evidence. Neither is a reproduced production defect.

Next evidence needed: the failing device's conversation shape request, response
and installed rows, correlated with the new counts and its page snapshot. Requested
existing network or Worker records for the fresh failure; no production E2E run.
A product fix cannot be justified from the present receipts alone.

Review: Codex Astra found no blocking defects; its startup-diagnostic assertion
suggestions were added. Fable is unavailable in this session's model list.
No full suite, production E2E, push or deploy was run.

Validation (Node 26.5.0, frozen install, final source):

- `pnpm --dir apps/mvp exec vitest run src/features/conversations/conversations.test.ts src/features/conversations/list.test.ts worker/branch/ConversationPeople.test.ts tests/ConversationList.test.ts --maxWorkers=1 --coverage.include=src/features/conversations/list.ts --coverage.include=src/features/conversations/store.ts --coverage.include=src/features/conversations/view.ts --coverage.include=src/features/conversations/metrics.ts`: 33/34 passed; the unchanged server fixture's TRUNCATE hook timed out. All 28 device/list/screen cases passed, including the new assertions and navigation probe. Selected statements, branches, functions and lines were 100%.
- Under the Mac mini's full-suite lock, `pnpm --dir apps/mvp exec vitest run worker/branch/ConversationPeople.test.ts db/Database.test.ts --maxWorkers=1 --coverage.include=db/migrations/0055_branch_ref_namespace.ts`: 30/30 passed, including all six server cases and all 24 database tests; migration coverage 100%. The lock was removed on exit. Across these final runs, all 58 unique cases passed.
- `pnpm --dir apps/mvp typecheck`: passed.
- `pnpm exec smithers-build test //apps/mvp:importRules`: passed.
- Earlier complementary 33-case selection passed with 100% selected coverage. The red-first telemetry assertion failed on the missing `conversations.shape.sync` record after its behavior checks passed; it was not a red reproduction of production's stall.
