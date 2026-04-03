/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Sequence, Task, Workflow, Parallel } from "smithers-orchestrator";
import { ClaudeCodeAgent, CodexAgent } from "smithers-orchestrator";
import { z } from "zod";

const REPO_ROOT = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const UNSAFE = process.env.SMITHERS_UNSAFE === "1";

const claude = new ClaudeCodeAgent({
  model: process.env.CLAUDE_MODEL ?? "claude-opus-4-6",
  systemPrompt: "You are a code reviewer focusing on software architecture, design patterns, and edge cases.",
  addDir: [REPO_ROOT],
  dangerouslySkipPermissions: UNSAFE,
  timeoutMs: 30 * 60 * 1000,
});

const codex = new CodexAgent({
  model: process.env.CODEX_MODEL ?? "gpt-5.3-codex",
  systemPrompt: "You are a security-focused code reviewer. Look for vulnerabilities, injection risks, and auth issues.",
  addDir: [REPO_ROOT],
  yolo: UNSAFE,
  timeoutMs: 30 * 60 * 1000,
  config: { model_reasoning_effort: "high" },
});

const ReviewSchema = z.object({
  reviewer: z.string().describe("Reviewer name or role"),
  approved: z.boolean().describe("Whether the changes are approved"),
  feedback: z.string().describe("Overall feedback"),
  issues: z.array(z.object({
    file: z.string(),
    description: z.string(),
    severity: z.enum(["nit", "minor", "major", "critical"])
  })),
});

const VerdictSchema = z.object({
  approved: z.boolean().describe("Final aggregated approval status"),
  summary: z.string().describe("Summary of both reviews"),
  criticalIssues: z.number().describe("Count of critical issues found"),
});

const { smithers, outputs, tables } = createSmithers({
  review: ReviewSchema,
  verdict: VerdictSchema,
}, {
  dbPath: `${process.env.HOME}/.cache/smithers/review-pr.db`,
});

export default smithers((ctx) => {
  const securityReview = ctx.latest(tables.review, "security-review");
  const qualityReview = ctx.latest(tables.review, "quality-review");

  return (
    <Workflow name="review-pr">
      <Sequence>
        <Parallel maxConcurrency={2}>
          <Task id="security-review" output={outputs.review} agent={codex} timeoutMs={15 * 60 * 1000} continueOnFail>
            {`Review the changes in PR #${ctx.input.prNumber} for security issues.
The PR title is: ${ctx.input.prTitle}
The PR description is: ${ctx.input.prBody}

Focus heavily on vulnerabilities. If the code is secure, set approved to true.`}
          </Task>

          <Task id="quality-review" output={outputs.review} agent={claude} timeoutMs={15 * 60 * 1000} continueOnFail>
            {`Review the changes in PR #${ctx.input.prNumber} for code quality.
The PR title is: ${ctx.input.prTitle}
The PR description is: ${ctx.input.prBody}

Focus on architecture, logic bugs, and readability. If the code is good, set approved to true.`}
          </Task>
        </Parallel>

        {securityReview && qualityReview ? (
          <Task id="aggregate-verdict" output={outputs.verdict} agent={claude} timeoutMs={10 * 60 * 1000}>
            {`Aggregate the security and quality reviews into a final verdict.
Security review: ${JSON.stringify(securityReview, null, 2)}
Quality review: ${JSON.stringify(qualityReview, null, 2)}

Approve only if BOTH reviewers approved. Count any critical issues across both reviews.`}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
