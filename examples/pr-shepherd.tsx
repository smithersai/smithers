// @ts-nocheck
/**
 * <PRShepherd> — Watch a PR move to ready-for-review, gather diffs/tests/context,
 * leave structured review comments, and optionally re-run after changes.
 */
import { createSmithers, Sequence, Parallel } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import GatherDiffPrompt from "./prompts/pr-shepherd/gather-diff.mdx";
import GatherTestsPrompt from "./prompts/pr-shepherd/gather-tests.mdx";
import GatherContextPrompt from "./prompts/pr-shepherd/gather-context.mdx";
import ReviewerPrompt from "./prompts/pr-shepherd/reviewer.mdx";
import ReportPrompt from "./prompts/pr-shepherd/report.mdx";

// ── Schemas ──────────────────────────────────────────────────────────────────

const diffSchema = z.object({
  changedFiles: z.array(z.string()),
  additions: z.number(),
  deletions: z.number(),
  riskAreas: z.array(z.string()),
  hunks: z.array(
    z.object({
      file: z.string(),
      patch: z.string(),
    }),
  ),
});

const testResultsSchema = z.object({
  passed: z.number(),
  failed: z.number(),
  skipped: z.number(),
  coverageDelta: z.number().optional(),
  failingSuites: z.array(z.string()),
});

const prContextSchema = z.object({
  title: z.string(),
  author: z.string(),
  labels: z.array(z.string()),
  baseBranch: z.string(),
  reviewers: z.array(z.string()),
  relatedFiles: z.array(z.string()),
  linkedIssues: z.array(z.string()),
});

const reviewCommentSchema = z.object({
  file: z.string(),
  line: z.number(),
  severity: z.enum(["critical", "warning", "suggestion", "nit"]),
  category: z.enum([
    "bug",
    "security",
    "performance",
    "style",
    "testing",
    "documentation",
  ]),
  body: z.string(),
});

const reviewOutputSchema = z.object({
  disposition: z.enum(["approve", "request-changes", "comment"]),
  comments: z.array(reviewCommentSchema),
  summary: z.string(),
});

const reportSchema = z.object({
  prNumber: z.number(),
  disposition: z.enum(["approve", "request-changes", "comment"]),
  criticalCount: z.number(),
  warningCount: z.number(),
  suggestionCount: z.number(),
  testStatus: z.enum(["passing", "failing", "unknown"]),
  needsRerun: z.boolean(),
  summary: z.string(),
});

// ── Smithers setup ───────────────────────────────────────────────────────────

const { Workflow, Task, smithers, outputs } = createSmithers({
  diff: diffSchema,
  testResults: testResultsSchema,
  prContext: prContextSchema,
  review: reviewOutputSchema,
  report: reportSchema,
});

// ── Agents ───────────────────────────────────────────────────────────────────

const gatherDiffAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, read, grep },
  instructions: `You gather PR diff information. Run git diff against the base branch,
identify changed files, count additions/deletions, extract patch hunks,
and flag risk areas (security-sensitive paths, config changes, migrations).`,
});

const gatherTestsAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, read },
  instructions: `You gather test results for a PR. Run the test suite targeting
changed files, collect pass/fail/skip counts, identify failing suites,
and compute coverage delta if available.`,
});

const gatherContextAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, read, grep },
  instructions: `You gather PR metadata and related context. Fetch PR title, author,
labels, reviewers, linked issues, and identify related files that may be
affected by the changes but are not in the diff.`,
});

const reviewerAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep },
  instructions: `You are a thorough code reviewer. Given diff hunks, test results,
and PR context, produce structured review comments. Each comment must specify
file, line, severity, and category. Prioritize critical bugs and security
issues. End with a disposition: approve, request-changes, or comment.`,
});

// ── Workflow ─────────────────────────────────────────────────────────────────

export default smithers((ctx) => {
  const diff = ctx.outputMaybe("diff", { nodeId: "gather-diff" });
  const testResults = ctx.outputMaybe("testResults", { nodeId: "gather-tests" });
  const prContext = ctx.outputMaybe("prContext", { nodeId: "gather-context" });
  const review = ctx.outputMaybe("review", { nodeId: "reviewer" });

  const criticalCount =
    review?.comments.filter((c) => c.severity === "critical").length ?? 0;
  const warningCount =
    review?.comments.filter((c) => c.severity === "warning").length ?? 0;
  const suggestionCount =
    review?.comments.filter(
      (c) => c.severity === "suggestion" || c.severity === "nit",
    ).length ?? 0;

  const testStatus =
    testResults == null
      ? "unknown"
      : testResults.failed > 0
        ? "failing"
        : "passing";

  const needsRerun = criticalCount > 0 || testStatus === "failing";

  return (
    <Workflow name="pr-shepherd">
      <Sequence>
        {/* ═══ CONTEXT GATHERING: diff, tests, and PR metadata in parallel ═══ */}
        <Parallel maxConcurrency={3}>
          <Task id="gather-diff" output={outputs.diff} agent={gatherDiffAgent}>
            <GatherDiffPrompt
              prNumber={ctx.input.prNumber}
              repo={ctx.input.repo}
              baseBranch={ctx.input.baseBranch ?? "main"}
            />
          </Task>

          <Task
            id="gather-tests"
            output={outputs.testResults}
            agent={gatherTestsAgent}
            continueOnFail
          >
            <GatherTestsPrompt
              prNumber={ctx.input.prNumber}
              repo={ctx.input.repo}
              changedFiles={ctx.input.changedFiles}
            />
          </Task>

          <Task
            id="gather-context"
            output={outputs.prContext}
            agent={gatherContextAgent}
          >
            <GatherContextPrompt
              prNumber={ctx.input.prNumber}
              repo={ctx.input.repo}
            />
          </Task>
        </Parallel>

        {/* ═══ REVIEWER: structured comments from gathered context ═══ */}
        <Task id="reviewer" output={outputs.review} agent={reviewerAgent}>
          <ReviewerPrompt
            diff={diff}
            testResults={testResults}
            prContext={prContext}
          />
        </Task>

        {/* ═══ REPORT: final review status ═══ */}
        <Task id="report" output={outputs.report}>
          <ReportPrompt
            prNumber={ctx.input.prNumber}
            review={review}
            testStatus={testStatus}
            needsRerun={needsRerun}
            criticalCount={criticalCount}
            warningCount={warningCount}
            suggestionCount={suggestionCount}
          />
        </Task>
      </Sequence>
    </Workflow>
  );
});
