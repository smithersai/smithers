import { Context, Effect, Layer } from "effect"
import type { Door } from "./dispatch"

// What this tab ran lately (docs/features/bugs.md#what-a-report-carries): every dispatch's run id, the trace id
// its `flow.dispatch` span carries, the flow, how it ended and the failure's stable code. A bug report carries the
// latest of them, so a person's words join our records by id. It holds ids and codes only, never a payload, an answer
// or a message, and it lives in the tab's memory: a reload forgets it.

/** How many of its latest dispatches a tab keeps. */
export const KEPT = 50

/** One dispatch as the tab keeps it. */
export interface Ran {
  readonly flow: string
  readonly executionId: string
  readonly door: Door
  /** The trace its `flow.dispatch` span is in; absent when no tracer gave it one. */
  readonly traceId?: string
  readonly outcome: "done" | "failed" | "error"
  /** A failure's stable code (`DispatchFailed`'s refusal or reason, a declared failure's tag); absent when it ran. */
  readonly code?: string
}

/** This tab's latest dispatches. */
export class TabHistory extends Context.Service<
  TabHistory,
  {
    /** Keeps one dispatch; past {@link KEPT}, the oldest goes. */
    readonly record: (ran: Ran) => Effect.Effect<void>
    /** The kept dispatches, newest first. */
    readonly recent: Effect.Effect<ReadonlyArray<Ran>>
  }
>()("@smthrs/mvp/flows/TabHistory") {
  /** One tab's: its latest `kept` dispatches, in memory. */
  static readonly layer = (kept: number = KEPT) =>
    Layer.sync(TabHistory, () => {
      const ran: Array<Ran> = []
      return TabHistory.of({
        record: (entry) =>
          Effect.sync(() => {
            ran.unshift(entry)
            if (ran.length > kept) ran.length = kept
          }),
        recent: Effect.sync(() => [...ran]),
      })
    })
}

/** A declared failure's stable code: its `_tag`'s last segment (`@smthrs/mvp/spend/ChannelRefused` is `ChannelRefused`). */
export const codeOfFailure = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("_tag" in error) || typeof error._tag !== "string") return undefined
  return error._tag.split("/").pop()
}
