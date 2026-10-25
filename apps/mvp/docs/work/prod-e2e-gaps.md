---
title: Deployment proofs for notifications, memory, TODO status and file tabs
status: done
area: app
owner: Codex prod-e2e-gaps
updated: 2026-10-25
links: [../decisions/0009-notifications-and-live-work.md, ../decisions/0093-agent-reads-shared-todo-status.md]
---

Add real-model browser proofs using the existing deployment identity, private branch and writable scratch stack. Library catalog: `@smthrs/flow`, `@smthrs/agent` and `@smthrs/memory`, exercised through the shipped UI; no new runtime or dependencies.

Production execution belongs to the lander under the shared account lock.

## Coverage

- `notifications.spec.ts`, `live notification`: the live agent waits for a choice on the account's branch; two independent contexts see its toast; open, expand, answer and dismiss; dismissal survives reload.
- `agent-deployment.spec.ts`, `memory`: remember British English through the public tool, reload, answer an American-spelled prompt in British English, and inspect `chat/Opening` with an inserted-memory receipt.
- `agent-deployment.spec.ts`, `todo status`: commit on `stackRepository()`, drop to a stable shared state, then require the answer and successful `todo/inspect` receipt to agree. Deployment needs `E2E_STACK_REPOSITORY` pointing to a writable scratch stack.
- `files.spec.ts`, `live agent shows code`: open README.md on the account's branch, keep that branch, select Code and verify the requested lines and their unselected neighbour.

All four declare `liveModel`, `member` and `ownConversation`; file tabs additionally need `codeStorage`, and TODO status needs `writableStack`. No scripted model or second development identity is required.

Latitude: `target.test.ts` passed 43/43; app, Worker, infrastructure and eval typechecks passed. Local mini attempts stopped before Playwright while preparing isolated services; the farm has no live model. No production execution or GIF receipt is claimed.

Playwright discovery passed: 340 tests in 67 files. Behavioral production validation remains with the lander; this note records delivery of the deployment-capable specs, not a production feature pass.
