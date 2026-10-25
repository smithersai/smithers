import type { JsonValueData, RunDetailsJob, StepState } from "@smthrs/ui"
import { runPath } from "./contract"
import { graphOf, runTitle } from "./graph"
import type { Inspection, RunPage } from "./schema"
import { headerStatusOf } from "./todoRun"

// A run opened in place on the Runs page (ruling FLOW-13: runs read like GitHub Actions): its jobs, the run itself and
// the runs it started, each with its steps in the order they began, each step with its last failure's code and its log
// lines. Pure: the same graph the run page draws (./graph.ts), regrouped by the run each step belongs to.

/** A run's state as a job's line reads it. A stopped run reads as skipped work, never as a failure. */
export const jobStateOf = (status: Inspection["run"]["status"]): StepState =>
  status === "completed"
    ? "completed"
    : status === "failed"
    ? "failed"
    : status === "cancelled"
    ? "skipped"
    : status === "suspended"
    ? "waiting"
    : status === "pending"
    ? "pending"
    : "running"

/** The run's jobs with their steps, and each step's log lines by its id. */
export interface RunDetails {
  readonly jobs: ReadonlyArray<RunDetailsJob>
  readonly logs: ReadonlyMap<string, ReadonlyArray<JsonValueData>>
}

/** `page`'s jobs and steps at `now`, each job linking to its own page through `pathOf` (none for the run itself). */
export const detailsOf = (page: RunPage, now: number, pathOf: (runId: string) => string = runPath): RunDetails => {
  if (page.inspection === null) return { jobs: [], logs: new Map() }
  const root = page.inspection as Inspection
  const owners = [root, ...((page.descendants ?? []) as ReadonlyArray<Inspection>)]
  const graph = graphOf(page, null, now, pathOf)
  const logs = new Map<string, ReadonlyArray<JsonValueData>>()
  const jobs = owners.map((owner) => {
    const isRoot = owner.run.runId === root.run.runId
    const href = isRoot ? null : pathOf(owner.run.runId)
    const steps = graph.steps
      // Action steps and child boundaries; an agent's cells and waits are the run page's detail.
      .filter((step) => (step.row.kind === "Step" || step.row.kind === "Flow") && step.href === href)
      .sort((left, right) => left.row.startedAtMs - right.row.startedAtMs)
      .map((step) => {
        logs.set(step.row.id, step.logs)
        return {
          id: step.row.id,
          label: step.row.label,
          state: step.row.state,
          startedAtMs: step.row.startedAtMs,
          endedAtMs: step.row.endedAtMs,
          error: step.attempts.filter((attempt) => attempt.state === "failed").at(-1)?.error ?? null,
          logs: step.logs.length,
        }
      })
    return {
      id: owner.run.runId,
      label: runTitle(owner.run),
      state: jobStateOf(isRoot ? headerStatusOf(owner.run) : owner.run.status),
      href,
      steps,
    } satisfies RunDetailsJob
  })
  return { jobs, logs }
}
