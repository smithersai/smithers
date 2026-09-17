import { refusalOf } from "@smthrs/rpc/Refusal"
import type { PlueFault } from "@smthrs/rpc/Refusal"
import { refusalLead } from "@smthrs/rpc/RefusalCopy"

/** Uncoded run failures belong to Smithers. Never infer blame from an error string. */
export function runFailure(detail = "") {
  let body: unknown
  try { body = JSON.parse(detail) } catch { body = undefined }
  const refusal = refusalOf({ body, status: null, message: detail })
  return { fault: refusal.fault, message: refusalLead(refusal), detail }
}

/** The workspace built-in that registers a repository flow on a schedule. */
const REGISTRAR_FLOW = "repository/trigger"

/** `<code>: <sentence>`, the pair agent/internal/FailureSummary.ts writes on a journalled failure's first line. */
const JOURNALLED = /^([a-z][a-z0-9_]*): (\S.*)$/

/** The first line of the cause the run itself journalled, which is where the code sits. */
const journalledCause = (events: ReadonlyArray<Record<string, unknown>> = []): string | undefined => {
  const failed = events.filter(event => event.kind === "control.run.failed").at(-1)
  const payload = failed?.payload as { cause?: unknown } | undefined
  return typeof payload?.cause === "string" ? payload.cause.split(/[\r\n]/, 1)[0] : undefined
}

/**
 * Whose problem a journalled code is, for the flow that journalled it.
 *
 * `invalid_receipt` is the engine's catch-all evidence code — an exporter exit,
 * a decode failure, a deadline — so the code alone says nothing about blame.
 * The registrar is the one flow that builds it from the maintainer's own
 * declared input (flows/repository/triggers.ts), so the pair identifies a
 * refusal the request has to answer. Every other pair is Smithers' until the
 * host journals the fault beside the cause.
 */
const journalledFault = (workflow: string, code: string): PlueFault | undefined =>
  workflow === REGISTRAR_FLOW && code === "invalid_receipt" ? "user" : undefined

/**
 * A failed run's copy, framed at render time from what the card already
 * carries: the flow it ran and the code its journal recorded, never the prose.
 * Nothing projected or persisted changes — `payload.error` stays the gateway's
 * verdict, so a maximized frame hashed by an older build still replays.
 */
export const runFailureOf = (payload: {
  readonly workflow: string
  readonly error?: string | undefined
  readonly events?: ReadonlyArray<Record<string, unknown>> | undefined
}) => {
  const failure = runFailure(payload.error)
  const line = journalledCause(payload.events)
  const journalled = line === undefined ? null : JOURNALLED.exec(line)
  if (line === undefined || journalled === null) return failure
  const fault = journalledFault(payload.workflow, journalled[1] ?? "")
  if (fault === undefined) return failure
  switch (fault) {
    case "user": return { fault, message: journalled[2] ?? "", detail: line }
    case "wait":
    case "infra":
    case "dependency":
    case "bug": return failure
    default: { const unhandled: never = fault; return unhandled }
  }
}
