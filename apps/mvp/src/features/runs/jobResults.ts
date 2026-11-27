import { CiJob } from "@smthrs/sandbox"
import { Schema } from "effect"
import type { Inspection } from "./schema"
import { inspectionValue } from "./inspectionValue"

const JobName = Schema.Struct({ job: Schema.Struct({ name: Schema.String }) })
const Report = Schema.Struct({ jobs: Schema.Array(Schema.Struct({ name: Schema.String, outcome: CiJob.Outcome })) })
const isRepoState = Schema.is(Schema.Struct({ state: Schema.Literals(["success", "failure"]) }))
const isJobName = Schema.is(JobName)
const isReport = Schema.is(Report)
const isResult = Schema.is(CiJob.Result)
const isGraphResult = Schema.is(Schema.Record(Schema.String, CiJob.Result))

/** Checkout and Step return the outcomes so far. Only the last entry describes this command. */
export const ciStageOf = (action: string | null | undefined, value: unknown) => {
  if (action === "repo/Run" || action === "repo/Jobs") {
    const report = inspectionValue(value)
    if (!isRepoState(report)) return undefined
    return { name: undefined, outcome: report.state === "failure" ? "failed" as const : "passed" as const }
  }
  if (action === "ci/graph") {
    const results = inspectionValue(value)
    if (!isGraphResult(results)) return undefined
    return { name: undefined, outcome: Object.values(results).every((job) => job.outcome === "passed") ? "passed" as const : "failed" as const }
  }
  if (action !== "ci/job" && action !== "ci/job/Checkout" && action !== "ci/job/Step") return undefined
  const result = inspectionValue(value)
  if (!isResult(result)) return undefined
  return action === "ci/job" ? { name: undefined, outcome: result.outcome } : result.steps.at(-1)
}

/** The CI action can finish successfully with a failed or skipped job. Read its bounded domain receipt. */
export const ciJobOf = (run: Inspection["run"]) => {
  if (run.flowName !== "ci/job") return undefined
  const input = inspectionValue(run.input)
  const result = inspectionValue(run.result)
  return isJobName(input) && isResult(result)
    ? { name: input.job.name, outcome: result.outcome, steps: result.steps }
    : undefined
}

/** The reported jobs stay visible while their individual inspections arrive. */
export const reportedJobs = (root: Inspection, descendants: ReadonlyArray<Inspection>) => {
  const job = ciJobOf(root.run)
  if (job !== undefined) return [job]
  if (root.run.flowName !== "repo/Run" && root.run.flowName !== "repo/Jobs") return []
  const report = inspectionValue(root.run.result)
  if (!isReport(report)) return []
  const children = new Map(descendants.flatMap(({ run }) => {
    const job = ciJobOf(run)
    return job === undefined ? [] : [[job.name, job] as const]
  }))
  return report.jobs.map(({ name, outcome }) => {
    const child = children.get(name)
    return { name, outcome, steps: child?.steps ?? [] }
  })
}
