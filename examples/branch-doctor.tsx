// @ts-nocheck
/**
 * <BranchDoctor> — Diagnose a broken branch state—bad rebases, partial cherry-picks,
 * divergent generated files—and propose the minimal recovery sequence.
 *
 * Shape: git inspector → diagnosis agent → command plan → optional execution.
 */
import { createSmithers, Sequence } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { bash, read, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import InspectPrompt from "./prompts/branch-doctor/inspect.mdx";
import DiagnosePrompt from "./prompts/branch-doctor/diagnose.mdx";
import PlanPrompt from "./prompts/branch-doctor/plan.mdx";
import ExecutePrompt from "./prompts/branch-doctor/execute.mdx";

// --- Zod schemas ---

const inspectionSchema = z.object({
  branch: z.string().describe("Current branch name"),
  conflictedFiles: z.array(z.string()).describe("Files in a conflicted state"),
  divergedCommits: z.number().describe("Number of commits ahead/behind the base branch"),
  unresolvedCherryPicks: z.array(z.string()).describe("SHAs of partially applied cherry-picks"),
  staleGeneratedFiles: z.array(z.string()).describe("Generated files that differ from what the source would produce"),
  statusSummary: z.string().describe("Raw git status / rebase state summary"),
});

const diagnosisSchema = z.object({
  rootCause: z.enum([
    "bad-rebase",
    "partial-cherry-pick",
    "divergent-generated-files",
    "mixed",
    "unknown",
  ]).describe("Primary root cause category"),
  details: z.string().describe("Detailed explanation of what went wrong"),
  severity: z.enum(["low", "medium", "high"]).describe("How damaged the branch is"),
  affectedPaths: z.array(z.string()).describe("Files or directories most impacted"),
});

const planSchema = z.object({
  commands: z.array(
    z.object({
      command: z.string().describe("The git or shell command to run"),
      purpose: z.string().describe("Why this step is needed"),
      safe: z.boolean().describe("Whether this command is non-destructive"),
    }),
  ).describe("Ordered list of recovery commands"),
  estimatedRisk: z.enum(["low", "medium", "high"]).describe("Overall risk of the recovery plan"),
  manualStepsRequired: z.array(z.string()).describe("Steps that need human judgement"),
});

const executionSchema = z.object({
  executedCommands: z.array(
    z.object({
      command: z.string(),
      exitCode: z.number(),
      output: z.string(),
    }),
  ).describe("Commands that were actually run"),
  skippedUnsafe: z.array(z.string()).describe("Commands skipped because they were not safe"),
  success: z.boolean().describe("Whether all executed commands succeeded"),
});

const outputSchema = z.object({
  rootCause: z.string().describe("The diagnosed root cause of the branch damage"),
  recoveryCommands: z.array(z.string()).describe("The full ordered list of recovery commands"),
  executed: z.boolean().describe("Whether safe recovery steps were run"),
  summary: z.string().describe("Human-readable summary of diagnosis and recovery"),
});

// --- Smithers setup ---

const { Workflow, Task, Branch, smithers, outputs } = createSmithers({
  inspection: inspectionSchema,
  diagnosis: diagnosisSchema,
  plan: planSchema,
  execution: executionSchema,
  output: outputSchema,
});

// --- Agents ---

const inspectorAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, read, grep },
  instructions: `You are a git inspector. Examine the repository state: check for conflicts, ongoing rebases, cherry-pick state, and generated files that have diverged. Report raw findings without interpretation.`,
});

const diagnosisAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep },
  instructions: `You are a git diagnosis expert. Given raw inspection data about a broken branch, determine the root cause—bad rebase, partial cherry-pick, divergent generated files, or a mix. Explain what happened and rate the severity.`,
});

const planAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, read },
  instructions: `You are a git recovery planner. Given a diagnosis, produce the minimal sequence of commands to restore the branch to a healthy state. Mark each command as safe (non-destructive) or unsafe. Prefer the smallest possible recovery—abort and redo only when strictly necessary.`,
});

const executionAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, read },
  instructions: `You are a careful command executor. Run ONLY commands marked as safe. Skip anything destructive. Report the output and exit code of each command you run.`,
});

// --- Workflow ---

export default smithers((ctx) => {
  const autoExecute = ctx.input.autoExecute ?? false;
  const inspection = ctx.outputMaybe("inspection", { nodeId: "inspect" });
  const diagnosis = ctx.outputMaybe("diagnosis", { nodeId: "diagnose" });
  const plan = ctx.outputMaybe("plan", { nodeId: "plan" });
  const execution = ctx.outputMaybe("execution", { nodeId: "execute" });

  return (
    <Workflow name="branch-doctor">
      <Sequence>
        {/* 1. Inspect the git state */}
        <Task id="inspect" output={outputs.inspection} agent={inspectorAgent}>
          <InspectPrompt
            repoPath={ctx.input.repoPath}
            baseBranch={ctx.input.baseBranch ?? "main"}
            symptoms={ctx.input.symptoms ?? []}
          />
        </Task>

        {/* 2. Diagnose the root cause */}
        <Task id="diagnose" output={outputs.diagnosis} agent={diagnosisAgent}>
          <DiagnosePrompt
            inspection={inspection}
            symptoms={ctx.input.symptoms ?? []}
          />
        </Task>

        {/* 3. Build the recovery command plan */}
        <Task id="plan" output={outputs.plan} agent={planAgent}>
          <PlanPrompt
            diagnosis={diagnosis}
            inspection={inspection}
            repoPath={ctx.input.repoPath}
            baseBranch={ctx.input.baseBranch ?? "main"}
          />
        </Task>

        {/* 4. Optionally execute safe recovery steps */}
        <Branch
          if={autoExecute}
          then={
            <Task id="execute" output={outputs.execution} agent={executionAgent}>
              <ExecutePrompt
                commands={plan?.commands ?? []}
                repoPath={ctx.input.repoPath}
              />
            </Task>
          }
        />

        {/* 5. Final summary */}
        <Task id="summary" output={outputs.output}>
          {{
            rootCause: diagnosis?.rootCause ?? "unknown",
            recoveryCommands: (plan?.commands ?? []).map((c) => c.command),
            executed: execution?.success ?? false,
            summary: [
              `BranchDoctor diagnosed "${diagnosis?.rootCause ?? "unknown"}" (severity: ${diagnosis?.severity ?? "unknown"}).`,
              `Recovery plan: ${plan?.commands?.length ?? 0} commands (risk: ${plan?.estimatedRisk ?? "unknown"}).`,
              autoExecute
                ? `Executed ${execution?.executedCommands?.length ?? 0} safe commands, skipped ${execution?.skippedUnsafe?.length ?? 0} unsafe.`
                : "Dry-run only — no commands were executed.",
              ...(plan?.manualStepsRequired?.length
                ? [`Manual steps still needed: ${plan.manualStepsRequired.join("; ")}`]
                : []),
            ].join(" "),
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});
