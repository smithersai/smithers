// @ts-nocheck
/**
 * <StandardsReviewer> — Review changes against repo-local standards files
 * (CLAUDE.md, style guides, architectural rules) and comment only on violations.
 *
 * Shape: PR diff → standards loader → reviewer agent → review output.
 */
import { createSmithers, Sequence } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import LoadStandardsPrompt from "./prompts/standards-reviewer/load-standards.mdx";
import ReviewDiffPrompt from "./prompts/standards-reviewer/review-diff.mdx";

// --- Zod schemas ---

const standardsSchema = z.object({
  files: z.array(
    z.object({
      path: z.string().describe("Path to the standards file"),
      content: z.string().describe("Full text of the standards file"),
    })
  ),
  ruleCount: z.number().describe("Total number of rules extracted"),
  rules: z.array(
    z.object({
      source: z.string().describe("Which file the rule came from"),
      rule: z.string().describe("The rule text"),
    })
  ),
});

const reviewSchema = z.object({
  violations: z.array(
    z.object({
      rule: z.string().describe("The standard that was violated"),
      source: z.string().describe("Standards file the rule came from"),
      file: z.string().describe("File in the diff that violates the rule"),
      line: z.number().nullable().describe("Approximate line number, if known"),
      explanation: z.string().describe("Why this constitutes a violation"),
      severity: z.enum(["error", "warning"]).describe("Whether this blocks merge"),
    })
  ),
  clean: z.boolean().describe("True when no violations were found"),
  summary: z.string().describe("Human-readable review summary"),
});

// --- Smithers setup ---

const { Workflow, Task, smithers, outputs } = createSmithers({
  standards: standardsSchema,
  review: reviewSchema,
});

// --- Agents ---

const standardsLoader = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a standards loader. Search the repository for standards files
such as CLAUDE.md, .cursorrules, CONTRIBUTING.md, STYLE_GUIDE.md, ARCHITECTURE.md,
and any other files that define coding standards, style rules, or architectural
constraints. Read each file and extract individual rules. Be thorough — check the
repo root, docs/ directory, and .github/ directory.`,
});

const reviewerAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a standards reviewer. Given a PR diff and a set of repo-local
rules, check every changed file against every rule. Report ONLY actual violations —
do not comment on things that are fine. Be precise: cite the specific rule, the
specific file and line, and explain clearly why it is a violation. If no violations
exist, say so and move on.`,
});

// --- Workflow ---

export default smithers((ctx) => {
  const loadedStandards = ctx.outputMaybe("standards", { nodeId: "load-standards" });

  return (
    <Workflow name="standards-reviewer">
      <Sequence>
        {/* Stage 1: Discover and load repo-local standards files */}
        <Task id="load-standards" output={outputs.standards} agent={standardsLoader}>
          <LoadStandardsPrompt
            repoPath={ctx.input.repoPath ?? "."}
            extraPaths={ctx.input.extraStandardsPaths ?? []}
          />
        </Task>

        {/* Stage 2: Review the diff against loaded standards */}
        <Task id="review-diff" output={outputs.review} agent={reviewerAgent}>
          <ReviewDiffPrompt
            diff={ctx.input.diff ?? ""}
            rules={loadedStandards?.rules ?? []}
            ruleCount={loadedStandards?.ruleCount ?? 0}
            standardsFiles={loadedStandards?.files.map((f) => f.path) ?? []}
          />
        </Task>
      </Sequence>
    </Workflow>
  );
});
