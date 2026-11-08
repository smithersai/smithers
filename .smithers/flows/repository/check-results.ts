/**
 * The recorded results of repository checks and the scope of each check: plain
 * TypeScript that refuses malformed evidence by throwing `CodingError`, so
 * `checks.vibe` runs it through `Effect.try` and tests call it directly.
 */
import * as Digest from "@smthrs/core/Digest"
import { Option, Schema } from "effect"
import { matchesGlob } from "node:path"
import { normalizePath, Source } from "../coding/planning-sources.vibe"
import { CodingError } from "../coding/schema.ts"
import { CheckContext, privatePath } from "./check-context.vibe"
import { Work } from "./jobs.vibe"
import { Check, type Draft, type JobResult, Proposal, type Step, StepResult } from "./schema.vibe"

const invalid = (message: string) => new CodingError({ code: "invalid_receipt", message })
const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
const Commit = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/))
export const Comparison = Schema.Struct({
  base: Commit,
  candidate: Schema.NonEmptyString,
  diff: Schema.String,
  paths: Schema.Array(Schema.String),
  files: Schema.Array(Source),
  changes: Schema.Array(
    Schema.Struct({ path: Schema.String, before: Schema.NullOr(Schema.String), after: Schema.NullOr(Schema.String) })
  )
})
export const CheckSource = Schema.Struct({ path: Schema.NonEmptyString, present: Schema.Boolean })
export const CheckPlan = Schema.Struct({
  work: Work,
  comparison: Comparison,
  contexts: Schema.Array(CheckContext),
  baseContexts: Schema.optionalKey(Schema.Array(CheckContext)),
  searched: Schema.optionalKey(Schema.Array(CheckSource))
})
export const CheckResult = Schema.Struct({
  checkId: Schema.String,
  policy: Check.fields.policy,
  status: Schema.Literals(["passed", "failed", "error", "skipped"]),
  summary: Schema.String,
  evidence: Schema.Array(Schema.String),
  executionId: Schema.String,
  detail: Schema.Json
})
/** Code findings can block policy even though the check executed correctly. */
export const CheckOutput = Schema.Struct({
  base: Commit,
  candidate: Schema.NonEmptyString,
  gate: Schema.Literals(["blocked", "passed"]),
  results: Schema.Array(CheckResult).check(Schema.isMinLength(1))
})
const Finding = Schema.Struct({
  path: Schema.NonEmptyString,
  line: Schema.Int.check(Schema.isGreaterThan(0)),
  message: Schema.NonEmptyString
})
/** Which model reached the verdict a row retained. Jev is the only one that
 * can now, but `seat` stays in the literals so rows stored while a frontier
 * checker existed keep decoding, and the key stays optional because rows
 * older than the field carry neither. `RetainSemantic` is its only writer, so
 * a checker that names itself in its own output cannot forge the record. */
export const DecidedBy = Schema.Literals(["jev", "seat"])
export const SemanticVerdict = Schema.Struct({
  verdict: Schema.Literals(["pass", "fail", "uncertain"]),
  summary: Schema.NonEmptyString,
  examinedPaths: Schema.Array(Schema.String),
  findings: Schema.Array(Finding).check(Schema.isMaxLength(40)),
  decidedBy: Schema.optionalKey(DecidedBy)
})
/** Shared by review execution, its trial verifier and the evaluator.
 * @throws {never} */
export const reviewCheckId = (stepId: string): string => `review-${stepId}`
/** A review's product is what it found on the exact source, so its own finding
 * cannot be the reason its step failed: a required synthesized rule made every
 * finding-bearing review an errored step with a blocked gate, which no eval
 * case and no live trial could ever complete. Promoting an AI rule to a
 * required gate stays the maintainer's separate decision (`suggestedChecks`).
 * @throws {never} */
export const reviewCheck = (step: typeof Step.Type): typeof Check.Type => ({
  id: reviewCheckId(step.id),
  name: step.name,
  kind: "ai",
  rule: step.prompt,
  paths: [],
  policy: "report"
})
export interface RecordedCheck {
  readonly step: typeof StepResult.Type
  readonly output: typeof CheckOutput.Type
  readonly phase: "baseline" | "candidate"
}
/** Read only the host's direct check or proposal.checks shape, never arbitrary
 * nested model JSON. Baselines remain measured evidence, not final coverage. */
export const recordedChecks = (
  step: typeof StepResult.Type,
  sourceRevision: string
): ReadonlyArray<RecordedCheck> | undefined => {
  const raw = object(step.output), direct = Schema.decodeUnknownOption(CheckOutput)(step.output)
  if (Option.isSome(direct)) {
    if (direct.value.candidate !== sourceRevision) throw invalid("The recorded check names another source")
    return [{ step, output: direct.value, phase: "candidate" }]
  }
  if (!("checks" in raw)) {
    if ("gate" in raw || "results" in raw) throw invalid("The recorded check output is malformed")
    return undefined
  }
  const nested = Schema.decodeUnknownOption(Schema.Array(StepResult))(raw.checks)
  const proposal = Schema.decodeUnknownOption(Proposal)(raw.proposal)
  if (Option.isNone(nested) || Option.isNone(proposal)) throw invalid("The proposed check results are malformed")
  if (!nested.value.length) {
    if (raw.status === "checked-proposal") throw invalid("The completed proposal has no recorded checks")
    return undefined
  }
  const finalCandidate = `${sourceRevision}+${Digest.digest(Digest.canonical(proposal.value))}`
  return nested.value.map((check) => {
    const output = Schema.decodeUnknownOption(CheckOutput)(check.output)
    if (Option.isNone(output)) throw invalid("A proposed check result is malformed")
    const value = output.value
    if (
      value.base !== sourceRevision || !value.candidate.startsWith(sourceRevision + "+") ||
      !/^[0-9a-f]{64}$/.test(value.candidate.slice(sourceRevision.length + 1))
    ) throw invalid("A proposed check names another source")
    return {
      step: check,
      output: value,
      phase: value.candidate === finalCandidate ? "candidate" as const : "baseline" as const
    }
  })
}
/** The checker's own recorded admission that it could not conclude on the
 * supplied scope. `assessSemantic` is the only writer of this summary. */
export const inconclusiveCheck = "The AI check did not establish complete scope coverage"
/** A valid failed required check is a policy finding. It is not an unavailable
 * execution. Report-only model/tool errors still invalidate eval/trial proof.
 * The single recorded error a reviewed step may be judged on is its own check
 * reporting, against this exact source, that it could not conclude: a
 * contradicted verdict, a citation outside the captured evidence, a missing
 * context, an expired deadline and a lost execution all stay unavailable.
 * @throws {never} */
export const unavailableCheck = ({ output }: RecordedCheck, reviewedId?: string): typeof CheckResult.Type | undefined =>
  output.results.find((check) =>
    check.status === "error" && !(check.checkId === reviewedId && check.summary === inconclusiveCheck &&
      check.evidence.includes(`execution:${check.executionId}`) &&
      check.evidence.includes(`source:${output.candidate}`))
  )
/** The refusal carries the check and its measured reason: a report-only rule
 * the gate deliberately ignored still stops the trial, and the bare fact that
 * something was unavailable sent the last operator to a retained workspace
 * file the product's file door cannot serve. Evaluation reads only the boolean.
 * @throws {never} */
export const checkExecutionFailure = (recorded: RecordedCheck, reviewedId?: string): string | undefined => {
  const unavailable = unavailableCheck(recorded, reviewedId)
  const measured = unavailable?.summary.slice(0, 200).trim()
  if (unavailable) {
    return `The trial recorded an unavailable check: ${unavailable.checkId}${measured ? ` — ${measured}` : ""}`
  }
  const blocked = recorded.output.results.some((check) =>
    check.policy === "required" && check.status !== "passed" && check.status !== "skipped"
  )
  return recorded.output.gate !== (blocked ? "blocked" : "passed") ||
      recorded.step.status !== (blocked ? "error" : "completed")
    ? `The trial recorded an inconsistent ${recorded.step.stepId} check step: gate ${recorded.output.gate} with status ${recorded.step.status}` :
    undefined
}
/** @throws {never} */
export const checkExecutionFailed = (recorded: RecordedCheck, reviewedId?: string): boolean =>
  checkExecutionFailure(recorded, reviewedId) !== undefined
/** Only the owned trial receipt uses this gate. Unrelated live events may skip. */
export const verifyTrialChecks = (configuration: Pick<Draft, "checks" | "steps">, result: JobResult): void => {
  // A review trial selects its core review step. Other event/manual steps and
  // disabled steps do not become extra requirements for this particular trial.
  const reviewed = result.job === "review" ?
    configuration.steps.filter((step) =>
      step.mode !== "off" &&
      step.id !== "checks" && result.results.some((value) => value.stepId === step.id)
    ).map(reviewCheck) :
    []
  const checks = [...configuration.checks, ...reviewed]
  const subjects = new Set(reviewed.map((check) => check.id))
  const ai = checks.filter((check) => check.kind === "ai")
  if (!ai.length) return
  if (checks.some((check) => !check.id) || new Set(checks.map((check) => check.id)).size !== checks.length) {
    throw invalid("AI trial checks need unique configured IDs")
  }
  const outputs = result.results.flatMap((step) => {
    const recorded = recordedChecks(step, result.sourceRevision)
    const unavailable = (recorded ?? []).map((check) => checkExecutionFailure(check)).find((reason) =>
      reason !== undefined
    )
    if (unavailable) throw invalid(unavailable)
    const final = recorded?.at(-1)
    return final?.phase === "candidate" && final.step.status === "completed" && final.output.gate === "passed"
      ? [final.output]
      : []
  })
  for (const check of ai) {
    const ran = outputs.some((output) => {
      const matches = output.results.filter((value) => value.checkId === check.id)
      if (matches.length !== 1) return false
      const value = matches[0]!, verdict = Schema.decodeUnknownOption(SemanticVerdict)(value.detail)
      if (
        value.policy !== check.policy ||
        (value.status !== "passed" && (check.policy !== "report" || value.status !== "failed")) ||
        !value.executionId || !value.evidence.includes(`execution:${value.executionId}`) ||
        !value.evidence.includes(`source:${output.candidate}`) || !value.evidence.includes(`base:${output.base}`) ||
        Option.isNone(verdict)
      ) return false
      const observed = verdict.value
      return observed.examinedPaths.length > 0 && observed.examinedPaths.every((path) =>
        !check.paths.length || check.paths.some((pattern) =>
          matchesGlob(path, pattern)
        )
      ) &&
        (value.status === "passed"
          ? observed.verdict === "pass" && !observed.findings.length
          : observed.verdict === "fail" && observed.findings.length > 0)
    })
    // Only a required rule holds a trial and its activation. A report-only rule
    // informs, so a trial whose change touches nothing in its scope leaves it
    // unexercised and finishes; a review a review trial exists to prove is that
    // trial's own subject, and a report-only rule that did record a result
    // still has to have recorded a real one.
    if (
      !ran && (check.policy === "required" || subjects.has(check.id) ||
        outputs.some((output) =>
          output.results.some((value) => value.checkId === check.id && value.status !== "skipped")
        ))
    ) {
      throw invalid(
        `AI check ${check.name || check.id} has no completed in-scope trial result; test a change that exercises it`
      )
    }
  }
}
/** A nonempty diff with unsupported path encoding cannot become an empty scope. */
export const diffPaths = (diff: string): Array<string> => {
  const paths = new Set<string>()
  for (const line of diff.split("\n")) {
    if (!line.startsWith("diff --git ")) continue
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
    if (!match) throw invalid("This diff uses a path encoding that requires maintainer review")
    for (const path of [match[1]!, match[2]!]) {
      if (normalizePath(path) !== path) throw invalid("The comparison contains an unsafe source path")
      paths.add(path)
    }
  }
  if (diff.trim() && !paths.size) throw invalid("The native comparison did not identify the files it changed")
  return [...paths].sort()
}
/** Whether `path` is in the check's configured scope: every path when it names none.
 * @throws {never} */
export const matched = (check: typeof Check.Type, path: string) =>
  !check.paths.length || check.paths.some((pattern) => matchesGlob(path, pattern))
/** A job's own retained configuration is written into the repository by
 * `writeCandidate` and refused by the context reader, so a change that touches
 * it is recorded evidence and never reviewable scope a semantic check is asked
 * to cover: supplying it would hand the checker the job's own configuration,
 * and requiring it makes every such review error before the checker runs. */
const reviewable = (check: typeof Check.Type, path: string) => check.kind !== "ai" || !privatePath(path)
export const selectedComparison = (
  comparison: typeof Comparison.Type,
  check: typeof Check.Type
): typeof Comparison.Type => {
  if (check.paths.some((pattern) => pattern.startsWith("/") || pattern.split("/").includes(".."))) {
    throw invalid("Check paths must stay inside the repository")
  }
  const paths = comparison.paths.filter((path) => matched(check, path) && reviewable(check, path))
  return {
    ...comparison,
    paths,
    files: comparison.files.filter((file) => paths.includes(file.path)),
    changes: comparison.changes.filter((file) => paths.includes(file.path))
  }
}
/** @throws {never} */
export const refusedComparison = (comparison: typeof Comparison.Type, check: typeof Check.Type): Array<string> =>
  comparison.paths.filter((path) => matched(check, path) && !reviewable(check, path))

