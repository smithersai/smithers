# Permanent product interaction rules

## Instant chat; slow work runs in the background (Will, 2026-09-15)

Chat responses acknowledge an action immediately. Repository setup, research,
planning, implementation, tests, and other slow work run in the background.
This applies equally to normal use and every tutorial/onboarding lesson.

- Persist the request and return an honest acknowledgment without awaiting the
  network request or the job. “Requested” is not “started” or “completed.”
- Use the app's shared toast stack for background progress. Follow its existing
  300 ms debounce; keep the toast running through launch AND execution, then
  resolve it from the real completion or failure. A launch acknowledgment is
  not job completion. Keep detailed output in the durable embedded run card.
- Keep Chat, navigation, and unrelated actions usable throughout. Tutorial
  actions must not strand the user behind a disabled “Researching…” button;
  offer Chat while a prerequisite runs. Advance dependent lessons only after
  their real completion receipts exist.
- Deduplicate repeated launches, reconnect persisted requests after reload,
  and ignore stale responses from an earlier tutorial playthrough. Failures
  must remain visible and retryable without claiming successful completion.
- Test with a deliberately unresolved launch and a running remote job: the
  command must return before either finishes, chat must remain usable, and
  the toast must settle only with the job. Cover failure and duplicate input.

Reference implementation: `apps/app/src/mainview/state/controller/liveTutorial.ts`.
Shared notifications: `apps/app/src/mainview/state/controller/failures.ts`.
App-specific rules: `apps/app/AGENTS.md`.

## Flow layering

`@smthrs/flow` is the fundamental library; every other flow API is a thin wrapper over it. Never add a second node or graph model.

One shape, everywhere: a file flow lives at `flows/<name>/flow.ts` and its `export default` is `Flow.make("<tag>", { description, capabilities, effects, modelInvocable?, payload, success, error?, body })` from `@smthrs/flow`. The tag is the first argument and is required, so a flow is never anonymous; a file flow declares the name its path derives.

## ⚖️ MINIMAL TEXT (Will, 2026-09-15, permanent)

Cards, panes, toasts, and lessons carry the fewest words needed to act. No explanatory prose about how the product works, no provenance footers, no rows whose value is "not measured yet", no summary sentence beside a button. Show a button, a count, or a picture instead of a sentence. Unrequested buttons and unrequested copy are defects (NO INVENTION); delete them on sight.
