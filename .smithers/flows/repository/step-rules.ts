/**
 * The plain rules of repository step execution: which steps an event selects
 * and whether a model's observation or reproduction review is backed by the
 * evidence it cites. They refuse by throwing `CodingError`, so `execution.vibe`
 * runs them through `Effect.try` and tests call them directly.
 */
import * as Digest from "@smthrs/core/Digest"
import { CodingError } from "../coding/schema.ts"
import { sourceEvent } from "./events.ts"
import type { Observation, ReproductionReview, Work } from "./jobs.vibe"
import { json } from "./trusted.ts"
import type { Event, IntakeScreening, JobInput, StepResult } from "./schema.vibe"

const invalid = (message: string) => new CodingError({ code: "invalid_receipt", message })
const allowedReferences = (work: typeof Work.Type) =>
  new Set([
    ...work.evidence.files.map((file) => file.path),
    ...work.evidence.records.map((record) => record.url).filter(Boolean)
  ])
export const verifyObservation = (work: typeof Work.Type, observation: typeof Observation.Type) => {
  const refs = allowedReferences(work)
  if (observation.citations.some((reference) => !refs.has(reference))) {
    throw invalid("A model cited source that this execution did not read")
  }
  if (
    observation.duplicates.some((candidate) =>
      !work.evidence.records.some((record) =>
        record.source === candidate.source && record.number === candidate.number && record.kind === "issue"
      )
    )
  ) {
    throw invalid("A proposed duplicate was not present in the captured issue history")
  }
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
// Plue's push rule carries no ref filter, so a registered chore would otherwise
// start on every branch and tag. Only the repository's own default branch may.
const defaultBranchPush = (event: typeof Event.Type) => {
  const payload = object(event.payload), branch = object(payload.repository).default_branch
  return typeof branch === "string" && branch !== "" && payload.ref === `refs/heads/${branch}`
}
// Plue's rule filter is not the only authority. A chore starts on the event its
// own draft chose, on its schedule, or by a manual dispatch or a trial.
const choreEventStarts = (configuration: JobInput["configuration"], event: typeof Event.Type) =>
  event.type === "push" ?
    configuration.choreEvent === "push" && defaultBranchPush(event)
    : event.type === "issues" ?
    configuration.choreEvent === "labeled" && event.action === "labeled"
    : event.type === "schedule" || event.type === "manual"
export const selectedSteps = (
  input: Pick<JobInput, "job" | "configuration" | "event">,
  intake?: typeof IntakeScreening.Type | undefined
) => {
  // An event the intake screen dropped ends this job exactly where an
  // already-ignored one does: no step is selected, so no model is asked.
  if (intake?.action === "ignored" || sourceEvent(input.event).ignored) return []
  if (
    input.job === "chores" && input.event.trial !== true && input.event.manualStep === undefined &&
    !choreEventStarts(input.configuration, input.event)
  ) return []
  const manualStep = input.event.manualStep
  if (
    manualStep !== undefined && (input.event.type !== "manual" || input.event.action !== `manual:${manualStep}` ||
      !input.configuration.steps.some((step) => step.id === manualStep && step.mode !== "off"))
  ) throw invalid("The manual event does not select an enabled step")
  const core = { review: "review", ci: "checks", feature: "feature", chores: "chore" } as const
  return input.configuration.steps.filter((step) => {
    // Only the dispatcher may attach manualStep; neither an issue body nor an
    // action string can start a privileged manual action.
    if (manualStep !== undefined) return step.id === manualStep && step.mode !== "off"
    if (input.event.trial === true && input.job !== "issues") return step.id === core[input.job] && step.mode !== "off"
    // Ordinary feature work answers the issue lifecycle its step mode
    // registered, never a comment or a fabricated action string.
    if (input.job === "feature" && input.event.type !== "issues") return false
    // An issue setup trial exercises automatic handling. Deliberately manual
    // fixes, POCs and splitting remain available through their own run action.
    return step.mode === "automatic" || step.mode === "approved"
  })
}
export const assessReproduction = (
  work: typeof Work.Type,
  observation: typeof Observation.Type,
  measured: typeof StepResult.Type,
  review: typeof ReproductionReview.Type,
  executionId: string
): typeof StepResult.Type => {
  const output = object(measured.output), repro = observation.reproduction
  if (
    !repro || measured.stepId !== work.step.id || object(output.source).commitId !== work.evidence.source.commitId ||
    JSON.stringify(output.fixture) !== JSON.stringify(repro.files) ||
    JSON.stringify(output.argv) !== JSON.stringify(repro.argv)
  ) {
    throw invalid("The reproduction review does not match its measured execution")
  }
  const source = new Map(work.evidence.files.map((file) => [file.path, file]))
  const fixtures = new Map(repro.files.map((file) => [file.path, file]))
  if (review.citations.some((path) => !source.has(path) && !fixtures.has(path))) {
    throw invalid("The reproduction reviewer cited unread source")
  }
  const observedFailure = output.status === "failure-observed" && typeof output.exitCode === "number" &&
    output.exitCode !== 0 &&
    `${String(output.stdout)}\n${String(output.stderr)}`.includes(repro.failureContains)
  const demonstrated = observedFailure && output.truncated === false && review.verdict === "demonstrates" &&
    review.citations.some((path) => source.has(path) && !source.get(path)!.truncated)
  const negative = !observedFailure && review.verdict === "unrelated"
  return {
    ...measured,
    status: demonstrated || negative ? "completed" : "needs-maintainer",
    summary: demonstrated ? "Reproduced" : review.summary,
    executionId,
    evidence: [
      ...measured.evidence,
      `execution:${executionId}`,
      ...review.citations.map((path) =>
        source.has(path)
          ? `source:${path}@${source.get(path)!.digest}` :
          `fixture:${path}@${Digest.digest(fixtures.get(path)!.content)}`
      )
    ],
    output: json({
      ...output,
      status: demonstrated ? "reproduced" : negative ? "not-reproduced" : "needs-review",
      review
    })
  }
}
