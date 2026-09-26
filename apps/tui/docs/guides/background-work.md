---
title: Keep working
description: Delegate a bounded task and continue the conversation.
order: 4
---

Ask Smithers to fix a bug or run a check. It records a worker request and returns control to chat while the worker runs.

```text
Fix the failing search tests. Keep the change inside src/search.ts and its tests.
```

## Follow a worker

Use **Ctrl+]** to open the next tab. Worker tabs show the current state and the steps already recorded. **Ctrl+\\** returns to chat.

| State     | Meaning                                                     |
| --------- | ----------------------------------------------------------- |
| Requested | The request is saved. Execution has not yet been confirmed. |
| Queued    | Waiting for a worker slot.                                  |
| Running   | Executing the task.                                         |
| Waiting   | Waiting for child workers.                                  |
| Parked    | Waiting for provider capacity.                              |
| Done      | Execution completed. Review the result and checks.          |
| Failed    | Open the failure and resume when ready.                     |

## Change direction

In a worker tab, press **s** to steer or **x** to stop. Press **r** to resume with its prior steps. In a failed worker tab, **m** selects another model.

Workers share your working directory. Give parallel tasks different files so their changes remain easy to review.

## Close and return

Continue with `bun run tui -c`. Persisted worker requests and steps reconstruct the session. Running, waiting, and parked workers relaunch from recorded work. A saved request is not evidence that its task completed.
