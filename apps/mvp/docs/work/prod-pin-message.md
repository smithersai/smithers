---
title: Production message pin proof
status: done
area: chat
owner: codex-prod-pin-message
updated: 2026-10-24
links: [../decisions/0090-pin-message.md, ../features/chat.md]
---

Add a live-model pin, scroll, unpin and reload journey on the signed-in account's own branch. Preserve all three scripted multi-person cases. Use the existing device action recording and step chapters. Catalog: existing `@smthrs/ui` message controls and pinned conversation region; no new library or product API.

Production execution and `gifs/pin-message.gif` belong to the deployer. This change runs discovery and static checks only.

Completed: the new describe scope declares `member`, `ownConversation` and `liveModel`. Its question begins with `Pin check ${devices.word}` and includes deterministic scroll context, so even an empty branch with a short or failed answer scrolls. It waits for the recorded answer id to settle, requires a visible failure when failed, and never asserts model wording. Pin and Unpin use the existing named buttons; the existing named pinned region identifies the reply and stays at its column's top through real wheel scrolling. Unpin waits for a successful server write with `messageId: null` before reloading and checking both the absent strip and the original message's unpressed Pin control. Existing accessible controls suffice; no product behavior or public API changed.

Validation: Node 26.5.0 frozen install passed. Playwright discovery lists all four cases; a byte comparison confirms the original three case bodies, including `requires("devPeople", "scriptedAgent")`, are unchanged. Deployment-mode discovery also lists all four cases plus three auth setup cases (7 total), without running them. All four app typecheck projects and `//apps/mvp:importRules` pass. ESLint's TypeScript recommended rules report zero errors and warnings for the spec (the app has no lint script). Cached discovery retries encountered a Playwright transform-cache JSON parse error; final local and deployment discovery pass with fresh task-local `PWTEST_CACHE_DIR` directories in `/tmp`. No browser execution or executed coverage claim.

Astra found and then approved fixes for the branch card border, accumulated scroll height, and local branch reload readiness. Fable could not start: `claude-rr` reported every account failed or cooling, tried none. No reset, push, deployment or production e2e run.
