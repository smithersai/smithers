---
title: Production chat bug bash
status: in-progress
area: chat
owner: bb-chat
updated: 2026-10-26
links: [../features/chat.md, ../features/conversations.md]
---

Reproduce the reported conversation list, draft, answer conflict, command, status, duplicate view, model toast and implicit repository findings. Use the existing @smthrs/ui, @smthrs/flow and Effect TanStack DB catalog entries.

`/new` reproduced on production: an unnamed repository was inherited and a test branch was created. The slash command now requires `repo`, with an optional branch name; the implicit repository helper was removed. The shared UI form hints supply requiredness, so typing and menu acceptance share the same guard. The red-first command regression failed on the old code. Latitude typecheck, import rules, lint and focused command/conversation suites pass; changed actions, pin and registry files have 100% coverage. Deployment verification remains with the lander.


Remaining results:

- Answer heartbeat: reproduced a PATCH 409 after a fast model refusal. A settled answer now answers 204 without renewing its lease; the browser keeps terminal settlement handling. Real answer-route regressions cover done and failed answers, and the quota e2e exercises a late heartbeat.
- Slash menu: reproduced clipped descriptions and `/navigate` before `/new`. Slash doors now declare short menu copy; full flow instructions stay available to the agent. The catalog and menu regressions cover short copy and prefix order.
- Model failure: reproduced the persistent global toast on chat and repository pages. Removed that duplicate surface and its hide actions/queries/store; chat's inline failure and Settings' provider detail remain. The old hide-row schema remains for decoding existing devices. The real Postgres/Electric UI regression fails on the old toast and verifies the detail once in Settings.
- Open conversations: not reproduced on repeated production visits; both the list and its authenticated shape returned conversations. Deferred pending a fresh reproduction.
- Draft: not reproduced; text survives Meta+K hide/show, confirmed in the screenshot and the textarea value. Deferred pending a fresh reproduction.
- Status labels: separate question, answer and flow entries, not inconsistent states on one person's message.
- Repository cards: distinct stored view IDs. One repository command adds one ID; Full screen and Back to chat preserve the same IDs once each. No duplicate introduced by navigation.

Validation: Latitude typecheck, import rules and lint pass. Focused command/conversation, answer-route/client and personal-model suites reach 100% coverage on changed production files. The new UI test is checked separately with coverage on the toast component. Production was probed again after the edits and still runs the old behavior; no deployment or local mini run was attempted.

Lander: run the slash-command specs (including the missing-repository prompt and `/n` ordering), conversation creation with an explicit repository, and model-quota late-heartbeat/no-toast steps after deployment. Confirm a failed answer remains retryable, Settings shows its provider failure once, and repository pages have no model-error toast. Recheck the Open list and draft toggle; keep every undeclared network/console/page error fatal.
