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

/** The bridge every repository setup operation runs under (apps/server/src/repositorySetupExecution.ts). */
const SETUP_FLOW = "repository/setup"

/**
 * The setup bridge's own refusals, verbatim from the host that writes them.
 *
 * The bridge is not the registrar: its `invalid_receipt` covers the candidate
 * the person declared AND the receipt plumbing behind it — ancestry, response
 * contracts, control ownership — so the flow and the code together still say
 * nothing about blame, and the host's own sentence is what does. Each one here
 * names an act the person performs: a draft edit, a run of the evals or the
 * trial, resolving source conflicts, connecting the repository host. Nothing
 * is inferred from the prose and no fragment is matched; a sentence the host
 * rewords falls back to the infra lead, and RunFailure.test.ts fails when one
 * of these leaves the file that emits it.
 */
export const SETUP_REFUSALS: ReadonlySet<string> = new Set([
  // flows/repository/receipts.ts:109 — the evidence the next operation needs
  "Run evals for this exact candidate before continuing",
  "Run the live trial for this exact candidate before continuing",
  // flows/repository/setup.ts
  "Required evaluation cases have not passed with evidence",
  "A retained candidate was edited; create a new revision",
  "The reviewed flow declaration was edited; create a new candidate",
  "Connect the repository host before testing or activating automation",
  "Repository source changed after the live trial; test the candidate again",
  // flows/repository/activation.ts
  "Connect the repository host before activation",
  "Setup reached its configured time limit",
  "Automatic replies are currently available for native issue handling only; choose draft replies",
  "Resolve native source conflicts before registration"
])

/** `<code>: <sentence>`, the pair agent/internal/FailureSummary.ts writes on a journalled failure's first line. */
const JOURNALLED = /^([a-z][a-z0-9_]*): (\S.*)$/

/** The same pair behind the run's status, which is how a settled receipt's error reads. */
const SETTLED = /^[a-z]+ — ([a-z][a-z0-9_]*): (\S.*)$/

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
 * refusal the request has to answer. The setup bridge mixes both, so there the
 * host's own sentence decides. Every other pair is Smithers' until the host
 * journals the fault beside the cause.
 */
const journalledFault = (workflow: string, code: string, sentence: string): PlueFault | undefined =>
  code !== "invalid_receipt" ? undefined
    : workflow === REGISTRAR_FLOW || (workflow === SETUP_FLOW && SETUP_REFUSALS.has(sentence)) ? "user" : undefined

/**
 * The setup bridge's own refusal, read from the settled receipt the setup card
 * and its toast render instead of a run's journal.
 *
 * A receipt carries one string: the status and the pair behind it, exactly as
 * the host wrote them. So the decision is the same one the run card makes, on
 * the same typed pair; an error line the bridge did not refuse answers nothing
 * and its copy stays what it was.
 */
export const setupRefusal = (error: string | undefined): string | undefined => {
  const settled = SETTLED.exec(error?.split(/[\r\n]/, 1)[0] ?? "")
  if (settled === null) return undefined
  return journalledFault(SETUP_FLOW, settled[1] ?? "", settled[2] ?? "") === "user" ? settled[2] : undefined
}

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
  const fault = journalledFault(payload.workflow, journalled[1] ?? "", journalled[2] ?? "")
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
