import type { RunStatus } from "./schema"

/** Inspection values are bounded JSON; a clipped or withheld value cannot identify a retry. */
const decoded = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || !("text" in value) ||
    typeof value.text !== "string" || !("clipped" in value) || value.clipped !== false) return undefined
  // expected: a value that isn't JSON identifies no retry
  try { return JSON.parse(value.text) } catch { return undefined }
}

/** A system TODO must start a fresh attempt through the stack, never replay its attempt payload. */
export const todoRetryPayload = (input: unknown): { readonly repo: string; readonly number: number } | undefined => {
  input = decoded(input)
  if (typeof input !== "object" || input === null) return undefined
  const value = input as Record<string, unknown>
  if (typeof value.repoId !== "string" || !/^github\/[^/]+\/[^/]+$/.test(value.repoId) ||
    typeof value.number !== "number" || !Number.isSafeInteger(value.number) || value.number < 1) return undefined
  return { repo: value.repoId.slice("github/".length), number: value.number }
}

export const failedTodoRun = (run: { readonly flowName: string; readonly status: string; readonly result: unknown }): boolean => {
  const result = decoded(run.result)
  return run.flowName === "todo" && (run.status === "failed" || run.status === "cancelled" ||
    (typeof result === "object" && result !== null && "state" in result && result.state === "failed"))
}

/** Only the draft round's finite result is needed in the Runs list; no draft content is kept there. */
export const draftOutcomeOf = (result: unknown): "succeeded" | "failed" | "unknown" => {
  const decodedResult = decoded(result)
  if (typeof decodedResult !== "object" || decodedResult === null || !("status" in decodedResult)) return "unknown"
  if (decodedResult.status === "failed") return "failed"
  return decodedResult.status === "ready" || decodedResult.status === "needs_you" ? "succeeded" : "unknown"
}

/** An answer can settle failed inside an engine run that completed. */
export const answerOutcomeOf = (result: unknown): "succeeded" | "failed" | "unknown" => {
  const decodedResult = decoded(result)
  if (typeof decodedResult !== "object" || decodedResult === null || !("status" in decodedResult)) return "unknown"
  return decodedResult.status === "failed" ? "failed" : decodedResult.status === "done" ? "succeeded" : "unknown"
}

/** These client flows' domain result can differ from the engine settlement. */
export const hasDomainOutcome = (flowName: string): flowName is "flow/new" | "chat/Answer" =>
  flowName === "flow/new" || flowName === "chat/Answer"

/** The finite domain result kept after a detail read, without answer or draft content. */
export const domainOutcomeOf = (flowName: "flow/new" | "chat/Answer", result: unknown): "succeeded" | "failed" | "unknown" =>
  flowName === "chat/Answer" ? answerOutcomeOf(result) : draftOutcomeOf(result)

/** A completed engine run can settle the requested TODO, draft or answer as failed. */
export const headerStatusOf = (run: {
  readonly flowName: string
  readonly status: RunStatus
  readonly result: unknown
}): RunStatus => run.status === "completed" && (failedTodoRun(run) ||
  (hasDomainOutcome(run.flowName) && domainOutcomeOf(run.flowName, run.result) === "failed")) ? "failed" : run.status
