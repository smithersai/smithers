// @ts-nocheck
/**
 * <BisectGuide> — Orchestrate git bisect with an agent interpreting ambiguous outcomes at each step.
 * Shape: VCS controller ↔ test runner ↔ adjudicator agent.
 */
import { createSmithers, Sequence, Loop } from "smithers-orchestrator";
import { ToolLoopAgent as Agent, Output } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { bash, read, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import BisectStepPrompt from "./prompts/bisect-guide/bisect-step.mdx";
import AdjudicatePrompt from "./prompts/bisect-guide/adjudicate.mdx";
import SummaryPrompt from "./prompts/bisect-guide/summary.mdx";

// --- Zod schemas ---

const bisectStepSchema = z.object({
  sha: z.string().describe("Current commit SHA being tested"),
  low: z.number().describe("Lower bound index"),
  high: z.number().describe("Upper bound index"),
  mid: z.number().describe("Current midpoint index"),
  testOutput: z.string().describe("Raw test runner output"),
  exitCode: z.number().describe("Test process exit code"),
});

const adjudicationSchema = z.object({
  verdict: z.enum(["good", "bad", "skip"]).describe("Agent interpretation of the test result"),
  confidence: z.number().min(0).max(1).describe("How confident the agent is in this verdict"),
  reasoning: z.string().describe("Why the agent reached this verdict"),
  nextLow: z.number().describe("Updated lower bound"),
  nextHigh: z.number().describe("Updated upper bound"),
  culpritFound: z.boolean().describe("Whether the bisect has converged"),
  culpritSha: z.string().nullable().describe("The identified culprit commit, if found"),
});

const outputSchema = z.object({
  culpritSha: z.string().nullable().describe("The commit that introduced the regression"),
  totalSteps: z.number().describe("Number of bisect steps performed"),
  summary: z.string().describe("Human-readable summary of the bisect result"),
});

// --- Smithers setup ---

const { Workflow, Task, smithers, outputs } = createSmithers({
  bisectStep: bisectStepSchema,
  adjudication: adjudicationSchema,
  output: outputSchema,
});

// --- Agents ---

const testRunnerAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, read, grep },
  output: Output.object({ schema: bisectStepSchema }),
  instructions: `You are a test runner for git bisect. Given a commit SHA, check it out and run the specified test command. Report the raw output and exit code. Do NOT interpret pass/fail — just report what happened.`,
});

const adjudicatorAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep },
  output: Output.object({ schema: adjudicationSchema }),
  instructions: `You are a bisect adjudicator. Given a test result (output + exit code), determine whether this commit is "good", "bad", or "skip" (ambiguous/flaky). Consider timeouts, partial failures, and infrastructure noise. Update the search bounds accordingly. Mark culpritFound when low >= high.`,
});

// --- Workflow ---

export default smithers((ctx) => {
  const steps = ctx.outputs.adjudication ?? [];
  const latestAdj = steps[steps.length - 1];
  const culpritFound = latestAdj?.culpritFound ?? false;

  const low = latestAdj?.nextLow ?? 0;
  const high = latestAdj?.nextHigh ?? Math.max(0, (ctx.input.commitCount as number) - 1);
  const mid = Math.floor((low + high) / 2);

  return (
    <Workflow name="bisect-guide">
      <Sequence>
        <Loop until={culpritFound} maxIterations={20} onMaxReached="return-last">
          <Sequence>
            <Task id="bisectStep" output={outputs.bisectStep} agent={testRunnerAgent}>
              <BisectStepPrompt
                repoPath={ctx.input.repoPath}
                testCommand={ctx.input.testCommand}
                low={low}
                high={high}
                mid={mid}
                previousSteps={steps}
              />
            </Task>

            <Task id="adjudication" output={outputs.adjudication} agent={adjudicatorAgent}>
              <AdjudicatePrompt
                sha={ctx.outputMaybe("bisectStep", { nodeId: "bisectStep" })?.sha ?? "unknown"}
                testOutput={ctx.outputMaybe("bisectStep", { nodeId: "bisectStep" })?.testOutput ?? ""}
                exitCode={ctx.outputMaybe("bisectStep", { nodeId: "bisectStep" })?.exitCode ?? 1}
                low={low}
                high={high}
                mid={mid}
                previousVerdicts={steps}
              />
            </Task>
          </Sequence>
        </Loop>

        <Task id="summary" output={outputs.output}>
          <SummaryPrompt
            culpritSha={latestAdj?.culpritSha ?? null}
            totalSteps={steps.length}
            verdicts={steps}
          />
        </Task>
      </Sequence>
    </Workflow>
  );
});
