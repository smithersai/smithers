// @ts-nocheck
/**
 * <SocialInboxRouter> — Classify LinkedIn/social inbox items into leads, noise,
 * support, or follow-up actions and produce structured output.
 *
 * Shape: social trigger -> classifier -> action router.
 */
import { createSmithers, Sequence, Parallel } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import TriggerPrompt from "./prompts/social-inbox-router/trigger.mdx";
import ClassifyPrompt from "./prompts/social-inbox-router/classify.mdx";
import LeadActionPrompt from "./prompts/social-inbox-router/lead-action.mdx";
import SupportActionPrompt from "./prompts/social-inbox-router/support-action.mdx";
import FollowUpActionPrompt from "./prompts/social-inbox-router/follow-up-action.mdx";
import SummaryPrompt from "./prompts/social-inbox-router/summary.mdx";

const inboxItemSchema = z.object({
  id: z.string(),
  platform: z.enum(["linkedin", "twitter", "facebook", "instagram", "other"]),
  senderName: z.string(),
  senderTitle: z.string().optional(),
  senderCompany: z.string().optional(),
  messageBody: z.string(),
  receivedAt: z.string(),
  summary: z.string(),
});

const classificationSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      category: z.enum(["lead", "noise", "support", "follow-up"]),
      confidence: z.number().min(0).max(1),
      reasoning: z.string(),
    })
  ),
  summary: z.string(),
});

const leadActionSchema = z.object({
  actions: z.array(
    z.object({
      itemId: z.string(),
      senderName: z.string(),
      senderCompany: z.string().optional(),
      suggestedReply: z.string(),
      crmAction: z.enum(["create-contact", "update-contact", "create-opportunity"]),
      priority: z.enum(["low", "medium", "high"]),
    })
  ),
  summary: z.string(),
});

const supportActionSchema = z.object({
  tickets: z.array(
    z.object({
      itemId: z.string(),
      subject: z.string(),
      urgency: z.enum(["low", "medium", "high", "critical"]),
      suggestedReply: z.string(),
      escalate: z.boolean(),
    })
  ),
  summary: z.string(),
});

const followUpActionSchema = z.object({
  followUps: z.array(
    z.object({
      itemId: z.string(),
      senderName: z.string(),
      context: z.string(),
      suggestedReply: z.string(),
      dueBy: z.string(),
    })
  ),
  summary: z.string(),
});

const routerOutputSchema = z.object({
  totalProcessed: z.number(),
  categoryCounts: z.object({
    lead: z.number(),
    noise: z.number(),
    support: z.number(),
    followUp: z.number(),
  }),
  leadActions: z.array(z.string()),
  supportTickets: z.array(z.string()),
  followUps: z.array(z.string()),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  inboxItem: inboxItemSchema,
  classification: classificationSchema,
  leadAction: leadActionSchema,
  supportAction: supportActionSchema,
  followUpAction: followUpActionSchema,
  routerOutput: routerOutputSchema,
});

const classifierAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a social inbox classifier. Given a batch of social messages,
categorize each as lead (buying intent, demo requests, partnership inquiries),
noise (congratulations, spam, irrelevant), support (bug reports, billing issues,
feature complaints), or follow-up (ongoing conversations needing a response).
Return a confidence score and brief reasoning for each classification.`,
});

const leadAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a sales development assistant. For each identified lead,
draft a personalized reply, determine the appropriate CRM action, and assign a
priority level based on the sender's title, company, and message intent.`,
});

const supportAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a support triage specialist. For each support message,
create a ticket with a subject line, determine urgency, draft a helpful initial
reply, and flag whether escalation to engineering is needed.`,
});

const followUpAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a relationship manager. For each follow-up item,
provide context on the conversation history, draft a thoughtful reply, and
set a due-by date to keep the relationship warm.`,
});

export default smithers((ctx) => {
  const inbox = ctx.outputMaybe("inboxItem", { nodeId: "trigger" });
  const classified = ctx.outputMaybe("classification", { nodeId: "classify" });

  const leads = (classified?.items ?? []).filter((i) => i.category === "lead");
  const supportItems = (classified?.items ?? []).filter((i) => i.category === "support");
  const followUps = (classified?.items ?? []).filter((i) => i.category === "follow-up");

  const leadActions = ctx.outputMaybe("leadAction", { nodeId: "lead-actions" });
  const supportActions = ctx.outputMaybe("supportAction", { nodeId: "support-actions" });
  const followUpActions = ctx.outputMaybe("followUpAction", { nodeId: "follow-up-actions" });

  return (
    <Workflow name="social-inbox-router">
      <Sequence>
        {/* Stage 1: Ingest and normalize social trigger */}
        <Task id="trigger" output={outputs.inboxItem}>
          <TriggerPrompt
            messages={ctx.input.messages ?? []}
            platform={ctx.input.platform ?? "linkedin"}
          />
        </Task>

        {/* Stage 2: Classify each item */}
        <Task id="classify" output={outputs.classification} agent={classifierAgent}>
          <ClassifyPrompt
            items={inbox ? [inbox] : ctx.input.messages ?? []}
          />
        </Task>

        {/* Stage 3: Route actions in parallel by category */}
        <Parallel maxConcurrency={3}>
          <Task id="lead-actions" output={outputs.leadAction} agent={leadAgent}>
            <LeadActionPrompt
              leads={leads}
              senderContext={ctx.input.senderContext ?? {}}
            />
          </Task>

          <Task id="support-actions" output={outputs.supportAction} agent={supportAgent}>
            <SupportActionPrompt
              supportItems={supportItems}
              productContext={ctx.input.productContext ?? {}}
            />
          </Task>

          <Task id="follow-up-actions" output={outputs.followUpAction} agent={followUpAgent}>
            <FollowUpActionPrompt
              followUps={followUps}
              relationshipContext={ctx.input.relationshipContext ?? {}}
            />
          </Task>
        </Parallel>

        {/* Stage 4: Summarize routing results */}
        <Task id="summary" output={outputs.routerOutput}>
          <SummaryPrompt
            classified={classified ?? { items: [] }}
            leadActions={leadActions ?? { actions: [] }}
            supportActions={supportActions ?? { tickets: [] }}
            followUpActions={followUpActions ?? { followUps: [] }}
          />
        </Task>
      </Sequence>
    </Workflow>
  );
});
