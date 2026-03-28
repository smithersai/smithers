/**
 * <TrustSafetyModerator> — Screen content, classify policy/risk, and route edge cases for review.
 *
 * Pattern: Content intake → moderator agent → policy-specific action or escalation.
 * Use cases: user-generated content moderation, AI output screening, policy enforcement,
 * abuse detection, compliance gating.
 */
import { createSmithers, Sequence } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import IntakePrompt from "./prompts/trust-safety-moderator/intake.mdx";
import ModeratePrompt from "./prompts/trust-safety-moderator/moderate.mdx";
import ActionPrompt from "./prompts/trust-safety-moderator/action.mdx";

const intakeSchema = z.object({
  contentId: z.string(),
  contentType: z.enum(["text", "image_url", "structured", "mixed"]),
  rawText: z.string(),
  metadata: z.object({
    source: z.string(),
    authorId: z.string().optional(),
    timestamp: z.string().optional(),
  }),
});

const moderationSchema = z.object({
  contentId: z.string(),
  riskLevel: z.enum(["allow", "low", "medium", "high", "block"]),
  policyClass: z.enum([
    "safe",
    "harassment",
    "hate_speech",
    "violence",
    "sexual_content",
    "self_harm",
    "pii_leak",
    "misinformation",
    "spam",
    "copyright",
    "other",
  ]),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  flaggedSegments: z.array(z.object({
    text: z.string(),
    policy: z.string(),
    severity: z.enum(["low", "medium", "high"]),
  })),
  needsHumanReview: z.boolean(),
});

const actionSchema = z.object({
  contentId: z.string(),
  decision: z.enum(["approved", "modified", "rejected", "escalated"]),
  action: z.string(),
  moderatedContent: z.string().optional(),
  escalationReason: z.string().optional(),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  intake: intakeSchema,
  moderation: moderationSchema,
  action: actionSchema,
});

const moderator = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep, bash },
  instructions: `You are a trust & safety content moderator. Analyze content against policy guidelines.
Classify risk level and policy category with high precision. Flag specific segments that violate policy.
When confidence is below 0.85 or the content is ambiguous, mark for human review.`,
});

const actionAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash },
  instructions: `You are a trust & safety action handler. Based on moderation results, take the appropriate
policy action: approve safe content, apply modifications for borderline cases, reject clear violations,
or escalate edge cases with detailed context for human reviewers.`,
});

export default smithers((ctx) => {
  const intake = ctx.outputMaybe("intake", { nodeId: "intake" });
  const moderation = ctx.outputMaybe("moderation", { nodeId: "moderate" });

  return (
    <Workflow name="trust-safety-moderator">
      <Sequence>
        {/* Content intake — normalize and extract metadata */}
        <Task id="intake" output={outputs.intake}>
          <IntakePrompt
            content={ctx.input.content ?? ""}
            source={ctx.input.source ?? "user_submission"}
            authorId={ctx.input.authorId ?? "anonymous"}
          />
        </Task>

        {/* Moderator agent — classify risk and policy */}
        <Task id="moderate" output={outputs.moderation} agent={moderator}>
          <ModeratePrompt
            contentId={intake?.contentId ?? "unknown"}
            contentType={intake?.contentType ?? "text"}
            rawText={intake?.rawText ?? ctx.input.content ?? ""}
            policies={ctx.input.policies ?? "default"}
          />
        </Task>

        {/* Policy-specific action or escalation */}
        <Task id="action" output={outputs.action} agent={actionAgent}>
          <ActionPrompt
            contentId={moderation?.contentId ?? intake?.contentId ?? "unknown"}
            riskLevel={moderation?.riskLevel ?? "allow"}
            policyClass={moderation?.policyClass ?? "safe"}
            confidence={moderation?.confidence ?? 1}
            reasoning={moderation?.reasoning ?? ""}
            flaggedSegments={moderation?.flaggedSegments ?? []}
            needsHumanReview={moderation?.needsHumanReview ?? false}
            rawText={intake?.rawText ?? ctx.input.content ?? ""}
          />
        </Task>
      </Sequence>
    </Workflow>
  );
});
