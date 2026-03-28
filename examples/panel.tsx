/**
 * <Panel> — N specialist agents review in parallel, then a moderator synthesizes.
 *
 * Pattern: Fan-out to specialist reviewers → Fan-in to synthesis agent.
 * Use cases: PR review (security + quality + architecture), design review,
 * RFC feedback, multi-perspective analysis.
 */
import { createSmithers, Sequence, Parallel } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, grep, bash } from "smithers-orchestrator/tools";
import { z } from "zod";
import ReviewPrompt from "./prompts/panel/review.mdx";
import SynthesisPrompt from "./prompts/panel/synthesis.mdx";

const specialistReviewSchema = z.object({
  role: z.string(),
  verdict: z.enum(["approve", "request-changes", "comment"]),
  findings: z.array(
    z.object({
      severity: z.enum(["critical", "warning", "info"]),
      description: z.string(),
      file: z.string().optional(),
      suggestion: z.string().optional(),
    })
  ),
  summary: z.string(),
});

const synthesisSchema = z.object({
  overallVerdict: z.enum(["approve", "request-changes", "comment"]),
  criticalIssues: z.array(z.string()),
  suggestions: z.array(z.string()),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  specialistReview: specialistReviewSchema,
  synthesis: synthesisSchema,
});

const makeSpecialist = (role: string, focus: string) =>
  new Agent({
    model: anthropic("claude-sonnet-4-20250514"),
    tools: { read, grep, bash },
    instructions: `You are a ${role}. Focus exclusively on: ${focus}
Be thorough but stay in your lane. Don't comment on areas outside your expertise.`,
  });

const securityReviewer = makeSpecialist(
  "Security Reviewer",
  "vulnerabilities, injection risks, auth/authz issues, secrets exposure, OWASP top 10"
);
const qualityReviewer = makeSpecialist(
  "Code Quality Reviewer",
  "readability, maintainability, DRY violations, naming, error handling, test coverage"
);
const architectureReviewer = makeSpecialist(
  "Architecture Reviewer",
  "design patterns, coupling, scalability, API design, dependency direction, separation of concerns"
);
const performanceReviewer = makeSpecialist(
  "Performance Reviewer",
  "N+1 queries, unnecessary allocations, missing caching, algorithmic complexity, bundle size"
);

const moderator = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  instructions: `You are a review moderator. Synthesize multiple specialist reviews into
a single coherent verdict. Prioritize critical issues, deduplicate overlapping feedback,
and produce actionable recommendations.`,
});

export default smithers((ctx) => {
  const reviews = ctx.outputs.specialistReview ?? [];

  // Configurable panel — default to all 4 specialists
  const panelConfig = ctx.input.panel ?? ["security", "quality", "architecture", "performance"];
  const specialists: Record<string, { agent: typeof securityReviewer; label: string }> = {
    security: { agent: securityReviewer, label: "Security" },
    quality: { agent: qualityReviewer, label: "Code Quality" },
    architecture: { agent: architectureReviewer, label: "Architecture" },
    performance: { agent: performanceReviewer, label: "Performance" },
  };

  const activePanel = panelConfig.map((key: string) => ({ key, ...specialists[key] }));

  return (
    <Workflow name="panel">
      <Sequence>
        {/* Fan-out: parallel specialist reviews */}
        <Parallel>
          {activePanel.map(({ key, agent, label }: { key: string; agent: typeof securityReviewer; label: string }) => (
            <Task
              key={key}
              id={`review-${key}`}
              output={outputs.specialistReview}
              agent={agent}
              timeoutMs={120_000}
            >
              <ReviewPrompt
                directory={ctx.input.directory}
                label={label}
                context={ctx.input.context ?? ""}
              />
            </Task>
          ))}
        </Parallel>

        {/* Fan-in: synthesize all reviews */}
        <Task id="synthesis" output={outputs.synthesis} agent={moderator}>
          <SynthesisPrompt reviews={reviews} />
        </Task>
      </Sequence>
    </Workflow>
  );
});
