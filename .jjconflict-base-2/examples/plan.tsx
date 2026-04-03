/**
 * <Plan> — Agent analyzes context and produces a structured, prioritized action plan.
 *
 * Pattern: Analyze requirements → decompose into tasks → prioritize → output plan.
 * Use cases: feature planning, sprint planning, migration planning, refactor strategy.
 */
import { Sequence } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, grep, bash } from "smithers-orchestrator/tools";
import { z } from "zod";
import PlanPrompt from "./prompts/plan/plan.mdx";

const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  priority: z.enum(["p0", "p1", "p2"]),
  estimatedComplexity: z.enum(["trivial", "small", "medium", "large"]),
  dependencies: z.array(z.string()),
  files: z.array(z.string()),
});

const planSchema = z.object({
  goal: z.string(),
  tasks: z.array(taskSchema),
  criticalPath: z.array(z.string()),
  risks: z.array(z.string()),
});

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
  plan: planSchema,
});

const planner = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep, bash },
  instructions: `You are a technical architect. Analyze the codebase and requirements,
then produce a detailed implementation plan. Break work into small, independent tasks.
Identify the critical path and risks. Each task should be completable by a single agent.`,
});

export default smithers((ctx) => (
  <Workflow name="plan">
    <Task id="plan" output={outputs.plan} agent={planner}>
      <PlanPrompt
        directory={ctx.input.directory}
        goal={ctx.input.goal}
        requirements={ctx.input.requirements}
        constraints={ctx.input.constraints}
      />
    </Task>
  </Workflow>
));
