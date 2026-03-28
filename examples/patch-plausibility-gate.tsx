// @ts-nocheck
/**
 * <PatchPlausibilityGate> — Verify a candidate patch before promotion.
 *
 * Pattern: Code agent proposes patch → parallel lint/test/build → gate aggregates → comment/merge/update.
 * Use cases: PR quality gates, pre-merge verification, continuous integration plausibility checks.
 */
import { createSmithers, Sequence, Parallel } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { bash, read, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import PatchPrompt from "./prompts/patch-plausibility-gate/patch.mdx";
import LintPrompt from "./prompts/patch-plausibility-gate/lint.mdx";
import TestPrompt from "./prompts/patch-plausibility-gate/test.mdx";
import BuildPrompt from "./prompts/patch-plausibility-gate/build.mdx";
import GatePrompt from "./prompts/patch-plausibility-gate/gate.mdx";
import FinalizePrompt from "./prompts/patch-plausibility-gate/finalize.mdx";

const patchSchema = z.object({
  patchDescription: z.string(),
  filesChanged: z.array(z.string()),
  diffSummary: z.string(),
});

const verifyResultSchema = z.object({
  check: z.enum(["lint", "test", "build"]),
  passed: z.boolean(),
  output: z.string(),
  errorCount: z.number(),
  details: z.string(),
});

const gateSchema = z.object({
  promoted: z.boolean(),
  passedChecks: z.array(z.string()),
  failedChecks: z.array(z.string()),
  plausibilityScore: z.number().min(0).max(1),
  reasoning: z.string(),
});

const finalizeSchema = z.object({
  action: z.enum(["merge", "comment", "update"]),
  message: z.string(),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  patch: patchSchema,
  verify: verifyResultSchema,
  gate: gateSchema,
  finalize: finalizeSchema,
});

const codeAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, read, grep },
  instructions: `You are a code agent. Analyze the proposed patch, identify changed files,
and summarize the diff so downstream verification steps know what to check.`,
});

const verifier = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash },
  instructions: `You are a verification agent. Run the specified check command and report
whether it passed or failed. Include raw output and error counts.`,
});

const gatekeeper = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  instructions: `You are a plausibility gatekeeper. Aggregate verification results and decide
whether the patch meets the plausibility bar for promotion. A patch is promoted only if all
critical checks pass and the overall plausibility score exceeds the configured threshold.`,
});

const finalizer = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash },
  instructions: `You are a finalization agent. Based on the gate decision, either merge the patch,
leave a blocking comment, or request updates from the author.`,
});

export default smithers((ctx) => {
  const patch = ctx.outputMaybe("patch", { nodeId: "patch" });
  const verifyResults = ctx.outputs.verify ?? [];
  const gateResult = ctx.outputMaybe("gate", { nodeId: "gate" });

  return (
    <Workflow name="patch-plausibility-gate">
      <Sequence>
        {/* Step 1: Analyze the proposed patch */}
        <Task id="patch" output={outputs.patch} agent={codeAgent}>
          <PatchPrompt
            pr={ctx.input.pr}
            branch={ctx.input.branch}
            repo={ctx.input.repo}
          />
        </Task>

        {/* Step 2: Run lint, test, build in parallel */}
        {patch && (
          <Parallel>
            <Task
              id="lint"
              output={outputs.verify}
              agent={verifier}
              continueOnFail
              timeoutMs={60_000}
            >
              <LintPrompt
                filesChanged={patch.filesChanged}
                lintCmd={ctx.input.lintCmd ?? "bun run lint"}
              />
            </Task>

            <Task
              id="test"
              output={outputs.verify}
              agent={verifier}
              continueOnFail
              timeoutMs={120_000}
            >
              <TestPrompt
                filesChanged={patch.filesChanged}
                testCmd={ctx.input.testCmd ?? "bun test"}
              />
            </Task>

            <Task
              id="build"
              output={outputs.verify}
              agent={verifier}
              continueOnFail
              timeoutMs={120_000}
            >
              <BuildPrompt
                filesChanged={patch.filesChanged}
                buildCmd={ctx.input.buildCmd ?? "bun run build"}
              />
            </Task>
          </Parallel>
        )}

        {/* Step 3: Gate — aggregate results and decide promote vs block */}
        <Task id="gate" output={outputs.gate} agent={gatekeeper}>
          <GatePrompt
            patchDescription={patch?.patchDescription ?? "unknown patch"}
            results={verifyResults}
            threshold={ctx.input.plausibilityThreshold ?? 1.0}
          />
        </Task>

        {/* Step 4: Finalize — comment, merge, or request update */}
        <Task id="finalize" output={outputs.finalize} agent={finalizer}>
          <FinalizePrompt
            promoted={gateResult?.promoted ?? false}
            reasoning={gateResult?.reasoning ?? ""}
            failedChecks={gateResult?.failedChecks ?? []}
            pr={ctx.input.pr}
            repo={ctx.input.repo}
          />
        </Task>
      </Sequence>
    </Workflow>
  );
});
