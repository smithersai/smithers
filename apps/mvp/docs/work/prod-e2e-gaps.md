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

## Production bounce

The deployment failures were classified against the lander log and source contracts:

- Memory: JSON previews are deliberately clipped. Read the compact `memory.opening` step log and still require `inserted > 0`, alongside the remembered-tool receipt and British spelling. Live graph inspection retains complete journal node results and falls back to schema-redacted sealed outcomes only for missing or clipped previews; replay retains historical previews.
- Notifications: opening a waiting question omitted its answer anchor, including on the same branch. Navigate to the answer and focus the question; regressions cover home and branch navigation.
- Files: the scratch README has two text lines plus a trailing newline. The deployed run reached the requested highlight and failed only at nonexistent line 4. Request lines 1–2 and require line 3 to remain unselected, preserving the exact-range check.

Catalog entries used: `@smthrs/ui` for the existing inspector, `@smthrs/gateway` for journal graph projection, and `@smthrs/flow` for the existing attention actions. No dependencies or SDK APIs changed.

Red-first Latitude run: both product regressions failed against the original implementation (25 other tests passed). Mini: 3 passed, 7 declared skips, including the four live-model cases because no model is available. Production revalidation belongs to the lander.

Bounce validation: app/Worker/infra/eval typechecks and importRules passed on Latitude; 74 focused tests passed with 100% statements, branches, functions and lines on attention/actions.ts and runs/graph.ts. Playwright discovery passed (447 tests, 72 files). Mini browser run passed (3 passed, 7 declared skips); production execution remains with the lander.


## Jev bounce

Rebased onto current main before fixing the regression. Audited graph output readers: RunPageView passes output to StepInspector; Jev debug assertions read verdicts; memory browser proofs read the compact opening log. detailsOf consumes rows, attempts and logs rather than output. Keep complete journal node results because sealed attempt outcomes can have a different shape. Missing or clipped live previews still use inspection output; replay stays historical. The new complete-result regression fails against the bounced graph implementation on Latitude.

Jev bounce validation: Latitude app/Worker/infra/eval typechecks and importRules passed; all 280 focused tests across 18 files passed, including Jev debug info, every runs logic suite, flow tabs, attention and deployment-target declarations. Both changed logic files reached 100% statements, branches, functions and lines. Existing toast navigation, compact memory JSON and exact line highlight fixes are retained. Production revalidation remains with the lander.

Additional Latitude UI validation: RunPage.loading.test.ts and graph.test.ts passed 14/14 with graph.ts independently at 100% statements, branches, functions and lines; typechecks and importRules passed again after the final regression assertion.
