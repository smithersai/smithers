import { Cause, Effect } from "effect"
import { codeOf } from "../../errorCode"
import { IssuesStore } from "../issues/store"

/**
 * Opens each routed or drafted repository's issue choices through the issue store's scoped, cached subscriptions.
 * Startup failures are recorded without ending the follower or hiding another repository's choices. Shape failures
 * after startup remain observable through the issue store's sync state and telemetry.
 */
export const syncIssueChoices = (repoIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const issues = yield* IssuesStore
    yield* Effect.forEach([...new Set(repoIds.filter((id) => id !== ""))], (id) =>
      issues.forRepo(id).pipe(
        Effect.asVoid,
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
          return Effect.logWarning("todos.issue.load").pipe(
            Effect.annotateLogs({ feature: "todos", outcome: "failed", errorCode: codeOf(Cause.squash(cause)) }),
          )
        }),
      ), { concurrency: "unbounded", discard: true })
  })
