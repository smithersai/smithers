import { Action, Flow, RetryPolicy } from "@smthrs/flow"
import { Node, Placement } from "@smthrs/plan"
import { Schema } from "effect"
import { ProjectId } from "./schema.ts"

const payload = { project: ProjectId, personId: Schema.NonEmptyString }
export const ProjectAdded = Schema.Struct({ project: ProjectId })

export class ProjectAddFailed extends Schema.TaggedError<ProjectAddFailed>()("@smthrs/mvp/projects/AddFailed", {
  code: Schema.Literals(["sign_in", "refused"]),
}) {}

export class ProjectAddUnavailable extends Schema.TaggedError<ProjectAddUnavailable>()("@smthrs/mvp/projects/AddUnavailable", {}) {}

const failure = Schema.Union([ProjectAddFailed, ProjectAddUnavailable])

/** Writing the same canonical repository again is safe under the roster's per-person uniqueness constraint. */
export const SaveProject = Action.make("app/project/add/save", {
  payload,
  success: ProjectAdded,
  error: failure,
  retryPolicy: RetryPolicy.make({
    initialMs: 250,
    factor: 2,
    maxMs: 250,
    maxAttempts: 2,
    nonRetryable: ["@smthrs/mvp/projects/AddFailed"],
  }),
})

export const AddProject = Flow.make("app/project/add", {
  description: "Save a repository to the signed-in person's private Projects list.",
  payload,
  success: ProjectAdded,
  error: failure,
  body: Node.capture({ save: SaveProject.name }, (input) => SaveProject.call(input)),
}).annotate(Flow.Placement, Placement.client())
