---
title: W12 chat bug bash
status: in-review
area: chat
owner: bb2-chat
updated: 2026-10-27
links: []
---

Reproduce round-two chat, slash command and conversation findings. Preserve input while the composer mounts; refuse invalid commands without orphan views. Library catalog: @smthrs/ui (chat surfaces), @smthrs/effect-tanstack-db (device state), @smthrs/flow (commands).


Six fixes: pending composer keystrokes, first-Enter repository hints, refused navigation, visible and enforced message length, empty search copy, repository-qualified archive controls. Regression tests cover the real device state, memory router, injected faulty services and rendered conversation list; deployment specs cover the browser interactions.

Production checks: `/new` with an explicit test repository succeeded; bare `/new` stayed in chat. W11 slash copy/order remains. On slow3g, tapping Chat opens the phone composer after session loading.

Deferred: `/issues` admits a view before repository access resolves, leaving a persisted refused card. The fix belongs at shared template admission so agent and slash calls agree; existing records must remain readable. A broken deployment spec retains the required behavior. Transcript scrolling remains unconfirmed on the shared production conversation; do not infer a fix from unrelated layout changes.

Lander: run `slash-commands.spec.ts` and `conversations.spec.ts` after deployment. Check immediate shortcut typing without an input wait, navigation staying in chat, first-Enter hints, oversize drafts retained, No matches, and repository-qualified archive controls. Mini and deployment runs were unavailable to this builder.

Continuation proof: Latitude typecheck, importRules and lint pass. The combined focused run passes 114 tests; shortcuts, conversation helpers and router each reach 100% coverage. The final command run passes 33 tests with 100% statements, branches, functions and lines for actions and contract, including late refusals after typing and a conversation switch. Deployment remains the lander's check.
