/**
 * <Milestone> — State machine progression through milestones (M0 → M1 → ... → Complete).
 *
 * Pattern: Define milestones with validation gates, progress sequentially.
 * Use cases: multi-phase builds, project milestones, progressive delivery,
 * phased rollouts, tutorial progression.
 */
// @ts-nocheck
import { Sequence } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, write, edit, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import ImplementPrompt from "./prompts/milestone/implement.mdx";
import ValidatePrompt from "./prompts/milestone/validate.mdx";

const milestoneResultSchema = z.object({
  milestone: z.string(),
  status: z.enum(["complete", "failed", "blocked"]),
  filesChanged: z.array(z.string()),
  summary: z.string(),
});

const validationSchema = z.object({
  milestone: z.string(),
  passed: z.boolean(),
  checks: z.array(z.object({
    name: z.string(),
    passed: z.boolean(),
    error: z.string().optional(),
  })),
});

const progressSchema = z.object({
  currentMilestone: z.string(),
  completedMilestones: z.array(z.string()),
  remainingMilestones: z.array(z.string()),
  overallProgress: z.number(),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
  milestoneResult: milestoneResultSchema,
  validation: validationSchema,
  progress: progressSchema,
});

const implementer = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, write, edit, bash, grep },
  instructions: `You are a milestone implementer. Complete the specified milestone
requirements. Make clean, focused changes. Commit after each logical unit.`,
});

const validator = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, read },
  instructions: `You are a milestone validator. Run all checks for the current milestone.
Be strict — only pass if all criteria are met.`,
});

export default smithers((ctx) => {
  // Define milestones from input or defaults
  const milestones: Array<{ id: string; title: string; requirements: string; validation: string }> =
    ctx.input.milestones ?? [
      { id: "m0", title: "Foundation", requirements: "Set up project structure", validation: "npx tsc --noEmit" },
      { id: "m1", title: "Core", requirements: "Implement core logic", validation: "npm test" },
      { id: "m2", title: "Polish", requirements: "Add docs and error handling", validation: "npm run build" },
    ];

  const results = ctx.outputs.milestoneResult ?? [];
  const validations = ctx.outputs.validation ?? [];
  const completedIds = new Set(
    validations.filter((v) => v.passed).map((v) => v.milestone)
  );

  return (
    <Workflow name="milestone">
      <Sequence>
        {milestones.map((ms, i) => {
          const prevComplete = i === 0 || completedIds.has(milestones[i - 1].id);
          const thisComplete = completedIds.has(ms.id);

          return (
            <Sequence key={ms.id}>
              {/* Implement milestone */}
              <Task
                id={`implement-${ms.id}`}
                output={outputs.milestoneResult}
                agent={implementer}
                skipIf={thisComplete || !prevComplete}
              >
                <ImplementPrompt
                  id={ms.id}
                  title={ms.title}
                  requirements={ms.requirements}
                  directory={ctx.input.directory}
                  completedMilestones={results
                    .filter((r) => r.status === "complete")
                    .map((r) => ({ milestone: r.milestone, summary: r.summary }))}
                />
              </Task>

              {/* Validate milestone */}
              <Task
                id={`validate-${ms.id}`}
                output={outputs.validation}
                agent={validator}
                skipIf={thisComplete || !prevComplete}
              >
                <ValidatePrompt
                  id={ms.id}
                  title={ms.title}
                  validationCommand={ms.validation}
                  directory={ctx.input.directory}
                />
              </Task>
            </Sequence>
          );
        })}

        {/* Progress report */}
        <Task id="progress" output={outputs.progress}>
          {{
            currentMilestone: milestones.find((m) => !completedIds.has(m.id))?.id ?? "complete",
            completedMilestones: [...completedIds],
            remainingMilestones: milestones.filter((m) => !completedIds.has(m.id)).map((m) => m.id),
            overallProgress: Math.round((completedIds.size / milestones.length) * 100),
            summary: `${completedIds.size}/${milestones.length} milestones complete (${Math.round((completedIds.size / milestones.length) * 100)}%)`,
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});
