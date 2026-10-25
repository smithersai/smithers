---
title: Production conversations list failures after f8a2
status: blocked
area: conversations
owner: Codex prod-conversations-list
updated: 2026-10-24
links: [../features/conversations.md, ../decisions/0095-new-conversation-ephemeral-refs.md]
---

Investigating history, archive, new conversation visibility and the mobile case.
No product fix or incorrect-test verdict is established. No failing product
regression was reproduced; production behavior has not been changed.

Library catalog: existing `@smthrs/effect-electric` shape proxy and collections,
`@smthrs/effect-tanstack-db` persisted state and live queries. No new library.

The list shape reads the person's `conversation_people` rows directly, without
a branch namespace join. Its device schema remains version 1. Migration 0055
adds columns to `branches`, not `conversation_people`.

Retained diagnostic coverage:

- `conversations.test.ts`: start the list queries after opening an ordinary
  branch and creating an ephemeral branch; archive across devices; reload the
  persisted device, show archived conversations, then reopen the ephemeral branch.
- `tests/ConversationList.test.ts`: render the real screen over Postgres,
  Electric and device services, verify labels and links, and press Archive.
  This uses a DOM host, a memory router and the existing client auth fixture;
  it does not prove production sessions, OPFS startup or browser worker leadership.
- `db/Database.test.ts`: seed open and archived personal history before applying
  migrations 0053–0055 and compare the exact personal rows afterward.

Evidence limitation: the supplied `evidence/prod-f8a2/results/` contains only
`.last-run.json` and a later `ci.spec.ts` results JSON, not the original failed
cases' snapshots, screenshots or browser logs. Restoration requested. The run
log places archive's failure on the phone after optimistic removal on the laptop.
Its mobile failure is a recording-teardown timeout with an emitted layout audit;
this alone establishes neither a layout defect nor a healthy mobile page.

Next: recover the original cases and correlate each conversation's branch/create
receipt, archive response/run outcome, `my-conversations` shape row and rendered
list. Do not change the product or weaken an assertion without a reproduced red.

Review: Codex Astra found no blocking defects in these diagnostic changes.
Fable is unavailable through this session's model/tool list and local command.
No production e2e, full suite, push or deploy was run.

Validation receipts (Node 26.5.0, frozen install):

- `pnpm --dir apps/mvp exec vitest run src/features/conversations/conversations.test.ts src/features/conversations/list.test.ts worker/branch/ConversationPeople.test.ts tests/ConversationList.test.ts tests/MobileLayout.browser.test.ts --maxWorkers=1 --coverage.include=src/features/conversations/list.ts --coverage.include=src/features/conversations/store.ts --coverage.include=src/features/conversations/view.ts`: 46 passed; measured statements, branches, functions and lines all 100%.
- `pnpm --dir apps/mvp exec vitest run db/Database.test.ts -t 0055_branch_ref_namespace --maxWorkers=1 --coverage.include=db/migrations/0055_branch_ref_namespace.ts`: 1 passed, migration coverage 100%.
- `pnpm --dir apps/mvp typecheck`: passed.
- `pnpm exec smithers-build test //apps/mvp:importRules`: passed.
- Earlier isolated device probes passed behaviorally but failed the unchanged
  aggregate coverage gate when run without the complementary list unit cases;
  the complete focused selection above passes the gate. These are not red
  product reproductions.
