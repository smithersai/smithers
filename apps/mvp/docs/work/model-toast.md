---
title: Add your model toast
status: done
area: notifications
owner: Codex GPT-6.1 Sol
updated: 2026-10-31
links:
  - ../decisions/0121-first-run.md
---

Will's 2026-10-31 20:25 PDT ruling: move the model prerequisite out of the conversation into the shared overlay toast stack. Preserve signed-out empty-page onboarding. Use the library catalog's notification entry (`@smthrs/notifications`, `@smthrs/ui` ToastStack/Toast); this changes the core composer prerequisite, not a plugin feature.

Validation runs on the Mac mini through mini-run. See ~/smithers-builders/model-toast-STATUS.md for receipts.

## Validation

- Red first: `tests/ModelNotice.test.ts` found the old centered `ComposerGate` model block inside Conversation.
- Green: 49 focused unit/integration tests; `pnpm exec vibelang -p tsconfig.json --noEmit`; eslint on changed source files, all on the Mac mini.
- V8: `modelNotice.ts` and `first-run/view.ts` have 100% statements, branches, functions and lines under the unchanged 100% gate (26 tests).
- Real browser: `e2e/model-toast.spec.ts`, Chromium, hosted inference off, passed. Real API receipts establish history; real model/Put metadata resolves the toast. No route interception or provider call. Hide preserves the conversation's box, reload restores the missing-model notice, Open settings navigates, Save resolves it without reload, and Remove returns one notice.
- Extended `byok-first.spec.ts` and updated `who-may-ask.spec.ts`; their provider/GitHub journeys were not executed by this change. No deployment.

Ruling FE-23 and decision 0121 record the change. Library catalog entries: notifications and UI (`@smthrs/ui` Toast/ToastStack through the existing Notices owner). This replaces the core composer's prerequisite UI; no plugin capability or persisted schema changes.
