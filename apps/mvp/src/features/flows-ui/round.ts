// A draft's rounds (decision 0014 §2): each round of `flow/new` runs as the execution `<draftId>:<round>`, so the tab
// that starts round 0, `flow/answer` that starts the next, and the engine that resumes one all name it the same way;
// and what a draft's card shows when its round's run ended without writing it. Nothing here imports a library, so every
// side can.

/** `<draftId>:<round>`: the execution id a draft's round runs under. */
/** @throws {never} */
export const roundExecutionId = (draftId: string, round: number): string => `${draftId}:${round}`

const ROUND = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(0|[1-9][0-9]{0,5})$/i

/** The draft and round an execution id names, or none: an agent's call or a slash command starts a new draft. */
export const roundOf = (executionId: string): { readonly draftId: string; readonly round: number } | undefined => {
  const match = ROUND.exec(executionId)
  return match === null ? undefined : { draftId: match[1]!.toLowerCase(), round: Number(match[2]) }
}

/** A run's status on this device's engine, or `absent` when the engine doesn't hold it. */
export type RunStatus = "pending" | "running" | "suspended" | "completed" | "failed" | "cancelled" | "absent"

/** What a draft's card shows: its status, why it failed, and whether it offers Draft again. */
export interface ShownRound<Status extends string> {
  readonly status: Status | "failed"
  readonly failure: string | null
  readonly retry: boolean
}

/**
 * What the card shows for `draft`, given its round's run on this device (`run`, read for `runId`). A round whose run
 * ended before it wrote the draft reads Failed: `stopped` when it was cancelled, `ended` when it failed. A run that
 * completed wrote the draft first, so the row is about to arrive; one this device doesn't hold, or not read yet,
 * leaves the row as it is. A failed round offers Draft again.
 */
export const shownRound = <Status extends string>(
  draft: { readonly id: string; readonly round: number; readonly status: Status; readonly failure: string | null },
  run: { readonly runId: string | null; readonly status: RunStatus } | undefined,
): ShownRound<Status> => {
  const settled = (failure: string): ShownRound<Status> => ({ status: "failed", failure, retry: true })
  if (draft.status !== "drafting") {
    return { status: draft.status, failure: draft.failure, retry: draft.status === "failed" }
  }
  if (run !== undefined && run.runId === roundExecutionId(draft.id, draft.round)) {
    if (run.status === "cancelled") return settled("stopped")
    if (run.status === "failed") return settled("ended")
  }
  return { status: draft.status, failure: null, retry: false }
}
