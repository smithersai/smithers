/**
 * Screen content against policy and approve, modify, reject, or escalate it for human review.
 *
 * Port of the 0.x `trust-safety-moderator.jsx`. An intake step normalizes the
 * content and its metadata, a moderator agent classifies its risk level and
 * policy class and flags violating segments, and an action agent decides what
 * happens to it. The three steps run in sequence with no branch; escalating an
 * edge case to people is one of the action agent's four decisions.
 *
 * 0.x gave `intake` no agent, so it persisted its prompt element as a static output that fails its schema; here it is a model step with no system prompt.
 * 0.x gave the agents `read`, `grep` and `bash` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

/** The content, normalized. */
export const Intake = Schema.Struct({
  contentId: Schema.String,
  contentType: Schema.Literals(["text", "image_url", "structured", "mixed"]),
  rawText: Schema.String,
  metadata: Schema.Struct({
    source: Schema.String,
    authorId: Schema.optional(Schema.String),
    timestamp: Schema.optional(Schema.String)
  })
})

/** The moderator's classification. */
export const Moderation = Schema.Struct({
  contentId: Schema.String,
  riskLevel: Schema.Literals(["allow", "low", "medium", "high", "block"]),
  policyClass: Schema.Literals([
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
    "other"
  ]),
  confidence: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  reasoning: Schema.String,
  flaggedSegments: Schema.Array(Schema.Struct({
    text: Schema.String,
    policy: Schema.String,
    severity: Schema.Literals(["low", "medium", "high"])
  })),
  needsHumanReview: Schema.Boolean
})

/** The decision the flow settles with. */
export const Decision = Schema.Struct({
  contentId: Schema.String,
  decision: Schema.Literals(["approved", "modified", "rejected", "escalated"]),
  action: Schema.String,
  moderatedContent: Schema.optional(Schema.String),
  escalationReason: Schema.optional(Schema.String),
  summary: Schema.String
})

/** Normalizes the content and extracts its metadata. */
export const IntakeContent = AgentAction.make("examples/TrustSafetyModerator/Intake", {
  payload: { content: Schema.String, source: Schema.String, authorId: Schema.String },
  output: Intake,
  seat,
  prompt: ({ authorId, content, source }) =>
    `Take in this content for moderation. Normalize it and extract its metadata.\n\nSource: ${source}\nAuthor: ${authorId}\nContent: ${
      JSON.stringify(content)
    }`
})

/** Classifies risk and policy. */
export const Moderate = AgentAction.make("examples/TrustSafetyModerator/Moderate", {
  payload: {
    contentId: Schema.String,
    contentType: Intake.fields.contentType,
    rawText: Schema.String,
    policies: Schema.String
  },
  output: Moderation,
  seat,
  system: [
    `You are a trust & safety content moderator. Analyze content against policy guidelines.
Classify risk level and policy category with high precision. Flag specific segments that violate policy.
When confidence is below 0.85 or the content is ambiguous, mark for human review.`
  ],
  prompt: ({ contentId, contentType, policies, rawText }) =>
    `Moderate content ${contentId} (${contentType}) against the ${policies} policies.\n\nText: ${
      JSON.stringify(rawText)
    }`
})

/** Applies the policy action or escalates. */
export const Act = AgentAction.make("examples/TrustSafetyModerator/Action", {
  payload: {
    contentId: Schema.String,
    riskLevel: Moderation.fields.riskLevel,
    policyClass: Moderation.fields.policyClass,
    confidence: Schema.Number,
    reasoning: Schema.String,
    flaggedSegments: Moderation.fields.flaggedSegments,
    needsHumanReview: Schema.Boolean,
    rawText: Schema.String
  },
  output: Decision,
  seat,
  system: [
    `You are a trust & safety action handler. Based on moderation results, take the appropriate
policy action: approve safe content, apply modifications for borderline cases, reject clear violations,
or escalate edge cases with detailed context for human reviewers.`
  ],
  prompt: ({ rawText, ...moderation }) =>
    `Act on content ${moderation.contentId}.\n\nModeration: ${JSON.stringify(moderation)}\nText: ${
      JSON.stringify(rawText)
    }`
})

/** The flow: intake, moderate, act. */
export const TrustSafetyModerator = Flow.make("examples/TrustSafetyModerator", {
  payload: {
    content: Schema.optional(Schema.String),
    source: Schema.optional(Schema.String),
    authorId: Schema.optional(Schema.String),
    policies: Schema.optional(Schema.String)
  },
  success: Decision,
  error: AgentAction.AgentFailure,
  body: ({ authorId = "anonymous", content = "", policies = "default", source = "user_submission" }) =>
    Node.bindPlanned(IntakeContent.call({ content, source, authorId }), (intake) =>
      Node.bindPlanned(
        Moderate.call({
          contentId: intake.contentId,
          contentType: intake.contentType,
          rawText: intake.rawText,
          policies
        }),
        (moderation) =>
          Act.call({
            contentId: moderation.contentId,
            riskLevel: moderation.riskLevel,
            policyClass: moderation.policyClass,
            confidence: moderation.confidence,
            reasoning: moderation.reasoning,
            flaggedSegments: moderation.flaggedSegments,
            needsHumanReview: moderation.needsHumanReview,
            rawText: intake.rawText
          })
      ))
})

/** Every step the flow calls. */
export const layer = Layer.mergeAll(IntakeContent.layer, Moderate.layer, Act.layer)
