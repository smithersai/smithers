/**
 * Implement milestones in order, advancing only when each one's validation passes.
 *
 * Port of the 0.x `milestone.jsx`. For each milestone (by default M0
 * Foundation, M1 Core and M2 Polish) an implementer agent works the
 * requirements, told the milestones earlier implementers reported complete,
 * and a validator agent runs the milestone's check. A failed validation ends
 * the chain, so the later milestones never start. A progress report counts the
 * milestones whose validation passed.
 *
 * 0.x re-rendered and skipped every milestone whose predecessor had not passed; here the plan unrolls the milestone list and each validation branches to the next milestone or to the report.
 * 0.x counted a milestone complete when a passing validation named its id; here a milestone is complete when its own validation passes.
 * `CheckSuite` does not fit: each 0.x milestone has one validator agent, and its answer already carries the checks it ran.
 * 0.x gave the implementer `read`, `write`, `edit`, `bash` and `grep` tools and the validator `bash` and `read`; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { type Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

/** One milestone: what to build and the command that proves it. */
export const MilestoneSpec = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  requirements: Schema.String,
  validation: Schema.String
})

/** What the implementer reports for one milestone. */
export const MilestoneResult = Schema.Struct({
  milestone: Schema.String,
  status: Schema.Literals(["complete", "failed", "blocked"]),
  filesChanged: Schema.Array(Schema.String),
  summary: Schema.String
})

/** The validator's verdict on one milestone. */
export const Validation = Schema.Struct({
  milestone: Schema.String,
  passed: Schema.Boolean,
  checks: Schema.Array(Schema.Struct({
    name: Schema.String,
    passed: Schema.Boolean,
    error: Schema.optional(Schema.String)
  }))
})

/** The progress report the flow settles with. */
export const Progress = Schema.Struct({
  currentMilestone: Schema.String,
  completedMilestones: Schema.Array(Schema.String),
  remainingMilestones: Schema.Array(Schema.String),
  overallProgress: Schema.Number,
  summary: Schema.String
})

type MilestoneSpec = typeof MilestoneSpec.Type
type MilestoneResult = typeof MilestoneResult.Type
type Progress = typeof Progress.Type

/** The milestones a run works when the payload names none. */
export const defaultMilestones: ReadonlyArray<MilestoneSpec> = [
  { id: "m0", title: "Foundation", requirements: "Set up project structure", validation: "npx tsc --noEmit" },
  { id: "m1", title: "Core", requirements: "Implement core logic", validation: "npm test" },
  { id: "m2", title: "Polish", requirements: "Add docs and error handling", validation: "npm run build" }
]

/** Works one milestone's requirements. */
export const Implement = AgentAction.make("examples/Milestone/Implement", {
  payload: {
    id: Schema.String,
    title: Schema.String,
    requirements: Schema.String,
    directory: Schema.String,
    completedMilestones: Schema.Array(Schema.Struct({ milestone: Schema.String, summary: Schema.String }))
  },
  output: MilestoneResult,
  seat,
  system: [
    `You are a milestone implementer. Complete the specified milestone
requirements. Make clean, focused changes. Commit after each logical unit.`
  ],
  prompt: ({ completedMilestones, directory, id, requirements, title }) =>
    `Implement milestone "${title}" (${id}):\n\nRequirements: ${requirements}\nDirectory: ${directory}\n\n${
      completedMilestones.length > 0
        ? `Previous milestones completed:\n${
          completedMilestones.map((item) => `- ${item.milestone}: ${item.summary}`).join("\n")
        }`
        : "This is the first milestone."
    }`
})

/** Runs one milestone's checks. */
export const Validate = AgentAction.make("examples/Milestone/Validate", {
  payload: { id: Schema.String, title: Schema.String, validationCommand: Schema.String, directory: Schema.String },
  output: Validation,
  seat,
  system: [
    `You are a milestone validator. Run all checks for the current milestone.
Be strict — only pass if all criteria are met.`
  ],
  prompt: ({ directory, id, title, validationCommand }) =>
    `Validate milestone "${title}" (${id}):\nValidation command: ${validationCommand}\nDirectory: ${directory}\nRun the checks and report pass/fail.`
})

/** The earlier milestones the implementers reported complete. Pure, so it is a `Node.map`, not a step. */
const completedOf = (results: ReadonlyArray<MilestoneResult>) =>
  results.filter((result) => result.status === "complete").map(({ milestone, summary }) => ({ milestone, summary }))

/** The report once the first `passed` milestones passed validation and the rest did not run or failed. */
const progress = (milestones: ReadonlyArray<MilestoneSpec>, passed: number): Progress => {
  const remaining = milestones.slice(passed).map((milestone) => milestone.id)
  const overallProgress = Math.round((passed / milestones.length) * 100)
  return {
    currentMilestone: remaining[0] ?? "complete",
    completedMilestones: milestones.slice(0, passed).map((milestone) => milestone.id),
    remainingMilestones: remaining,
    overallProgress,
    summary: `${passed}/${milestones.length} milestones complete (${overallProgress}%)`
  }
}

type Requirements = Action.Requirement<"examples/Milestone/Implement" | "examples/Milestone/Validate">

/**
 * Milestone `index`: implement it, then validate it, then go on to the next
 * one only when the validation passed. `results` holds the earlier
 * implementers' planned reports.
 *
 * The validator waits for the implementer with `Node.andThen`, because it
 * reads nothing the implementer returned. `Node.bindPlanned` alone would let
 * it start while the implementer is still working.
 */
const phase = (
  directory: string,
  milestones: ReadonlyArray<MilestoneSpec>,
  index: number,
  results: ReadonlyArray<Planned.Planned<MilestoneResult>>
): Node.Node<Progress, AgentAction.AgentFailure, Requirements> => {
  const milestone = milestones[index]
  if (milestone === undefined) return Node.succeed(progress(milestones, index))
  const { id, requirements, title } = milestone
  return Node.bindPlanned(
    Node.map(Node.succeed(results), completedOf),
    (completedMilestones) =>
      Node.bindPlanned(
        Implement.call({ id, title, requirements, directory, completedMilestones }),
        (result: Planned.Planned<MilestoneResult>) =>
          Node.branch(
            Node.andThen(
              Node.succeed(result),
              Validate.call({ id, title, validationCommand: milestone.validation, directory })
            ),
            {
              if: (validation) => validation.passed,
              then: () => phase(directory, milestones, index + 1, [...results, result]),
              else: () => Node.succeed(progress(milestones, index))
            }
          )
      )
  )
}

/** The flow. `milestones` is real at plan time, so it sets the phases the plan holds. */
export const Milestone = Flow.make("examples/Milestone", {
  payload: { directory: Schema.String, milestones: Schema.optional(Schema.NonEmptyArray(MilestoneSpec)) },
  success: Progress,
  error: AgentAction.AgentFailure,
  body: ({ directory, milestones = defaultMilestones }) => phase(directory, milestones, 0, [])
})

/** Every step the flow calls. */
export const layer = Layer.mergeAll(Implement.layer, Validate.layer)
