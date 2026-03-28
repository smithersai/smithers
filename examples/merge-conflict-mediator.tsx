// @ts-nocheck
/**
 * <MergeConflictMediator> — Read merge conflicts, explain the semantic disagreement,
 * propose a resolution, and optionally stage the fix for review.
 *
 * Pattern: git diff/conflict parser -> mediator agent -> optional apply step -> human reviewer.
 * Use cases: merge conflict triage, automated resolution proposals, team code integration.
 */
import { createSmithers, Sequence } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import ParsePrompt from "./prompts/merge-conflict-mediator/parse.mdx";
import MediatePrompt from "./prompts/merge-conflict-mediator/mediate.mdx";
import ApplyPrompt from "./prompts/merge-conflict-mediator/apply.mdx";

const conflictRegionSchema = z.object({
  file: z.string(),
  startLine: z.number(),
  endLine: z.number(),
  ours: z.string().describe("Content from the current branch (HEAD)"),
  theirs: z.string().describe("Content from the incoming branch"),
  baseContext: z.string().describe("Surrounding code for understanding intent"),
});

const parseResultSchema = z.object({
  conflictCount: z.number(),
  files: z.array(z.string()),
  regions: z.array(conflictRegionSchema),
  summary: z.string(),
});

const resolutionSchema = z.object({
  file: z.string(),
  semanticDisagreement: z.string().describe("Plain-language explanation of why ours and theirs conflict"),
  proposedCode: z.string().describe("The merged code that preserves intent from both sides"),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
});

const mediationResultSchema = z.object({
  resolutions: z.array(resolutionSchema),
  overallRisk: z.enum(["low", "medium", "high"]),
  summary: z.string(),
});

const applyResultSchema = z.object({
  applied: z.boolean(),
  filesStaged: z.array(z.string()),
  gitStatus: z.string(),
  summary: z.string(),
});

const reviewSchema = z.object({
  status: z.enum(["ready-for-review", "needs-manual-intervention", "skipped"]),
  appliedFiles: z.array(z.string()),
  manualFiles: z.array(z.string()),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  parseResult: parseResultSchema,
  mediationResult: mediationResultSchema,
  applyResult: applyResultSchema,
  review: reviewSchema,
});

const parser = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, read, grep },
  instructions: `You are a git conflict parser. Use git diff and file reads to identify all
conflict markers (<<<<<<< / ======= / >>>>>>>) in the working tree. Extract each conflict
region with its surrounding context. Do not resolve conflicts — only catalogue them.`,
});

const mediator = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep },
  instructions: `You are a merge conflict mediator. For each conflict region, explain the
semantic disagreement between the two sides — not just the textual diff, but the intent
behind each change. Propose a minimal, safe resolution that preserves both intents where
possible. Flag high-risk merges where manual review is essential.`,
});

const applier = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, read },
  instructions: `You are a careful code applier. Write the proposed resolution into the
conflicted files, removing all conflict markers. Stage the resolved files with git add.
Do NOT commit — leave changes staged for human review. Report git status after staging.`,
});

export default smithers((ctx) => {
  const autoApply = ctx.input.autoApply ?? false;
  const mediation = ctx.outputs.mediationResult?.[0];
  const applyResult = ctx.outputs.applyResult?.[0];
  const highConfidenceOnly = mediation?.resolutions.every((r) => r.confidence >= 0.8) ?? false;
  const shouldApply = autoApply && highConfidenceOnly && mediation?.overallRisk !== "high";

  return (
    <Workflow name="merge-conflict-mediator">
      <Sequence>
        {/* Phase 1: Parse — identify all conflict regions in the working tree */}
        <Task id="parseResult" output={outputs.parseResult} agent={parser}>
          <ParsePrompt
            targetBranch={ctx.input.targetBranch ?? "main"}
            sourceBranch={ctx.input.sourceBranch ?? "HEAD"}
            files={ctx.input.files}
          />
        </Task>

        {/* Phase 2: Mediate — explain each conflict and propose resolution */}
        <Task id="mediationResult" output={outputs.mediationResult} agent={mediator}>
          <MediatePrompt
            regions={ctx.outputs.parseResult?.[0]?.regions ?? []}
            conflictCount={ctx.outputs.parseResult?.[0]?.conflictCount ?? 0}
          />
        </Task>

        {/* Phase 3: Optional apply — stage fixes only when safe and requested */}
        <Task id="apply-result" output={outputs.applyResult} agent={applier} skipIf={!shouldApply}>
          <ApplyPrompt
            resolutions={mediation?.resolutions ?? []}
            overallRisk={mediation?.overallRisk ?? "high"}
          />
        </Task>

        {/* Fallback: skip apply — report as needing manual intervention */}
        <Task id="apply-result-skipped" output={outputs.applyResult} skipIf={shouldApply}>
          {{
            applied: false,
            filesStaged: [],
            gitStatus: "unchanged",
            summary: shouldApply
              ? "Apply was skipped unexpectedly"
              : `Auto-apply skipped: ${mediation?.overallRisk === "high" ? "high risk" : !highConfidenceOnly ? "low-confidence resolutions" : "autoApply not enabled"}`,
          }}
        </Task>

        {/* Phase 4: Human reviewer summary */}
        <Task id="review" output={outputs.review}>
          {{
            status: applyResult?.applied
              ? "ready-for-review"
              : mediation?.overallRisk === "high"
                ? "needs-manual-intervention"
                : "skipped",
            appliedFiles: applyResult?.filesStaged ?? [],
            manualFiles: (mediation?.resolutions ?? [])
              .filter((r) => r.confidence < 0.8)
              .map((r) => r.file),
            summary: applyResult?.applied
              ? `Staged ${applyResult.filesStaged.length} resolved files for review`
              : `${mediation?.resolutions.length ?? 0} resolutions proposed — manual review required`,
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});
