import type { Host } from "@smthrs/plugin"
import { Schema } from "effect"
import { projectId } from "./contract.ts"

export const ProjectId = Schema.String.check(
  Schema.makeFilter((value) => projectId(value) === value, { identifier: "CanonicalProjectId" }),
)
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const ProjectSummary = Schema.Struct({
  project: ProjectId,
  access: Schema.Literals(["member", "restricted", "unavailable"]),
  openTodos: Schema.NullOr(Count),
  needsAttention: Schema.NullOr(Count),
  openPlanNodes: Schema.NullOr(Count),
})
export type ProjectSummary = typeof ProjectSummary.Type

export const Roster = Schema.Struct({ projects: Schema.Array(ProjectId) })
export const Summaries = Schema.Struct({
  projects: Schema.Array(ProjectSummary),
  nextAfter: Schema.optionalKey(ProjectId),
})

export const ProjectsSnapshot = Schema.Struct({
  id: Schema.Literal("projects"),
  personId: Schema.optional(Schema.String),
  status: Schema.Literals(["loading", "ready", "unavailable"]),
  projects: Schema.Array(ProjectId),
  summaries: Schema.Array(ProjectSummary),
  summariesPending: Schema.Boolean,
})
export type ProjectsSnapshot = typeof ProjectsSnapshot.Type

/** A refresh requested after a write settled for the account the form was opened under. */
export interface ProjectsLive extends Host.Live<ProjectsSnapshot> {
  readonly refresh: (personId: string) => void
}
