// @ts-nocheck
/**
 * <SupportDeflector> — Classify inbound support issues, retrieve likely knowledge,
 * draft a response, and only escalate when risk or uncertainty is high.
 *
 * Pattern: inbox/ticket trigger → classifier → retriever → draft agent → escalation path.
 * Use cases: support ticket deflection, knowledge-base self-service, tier-1 automation,
 * customer success auto-reply, FAQ routing.
 */
import { createSmithers, Sequence } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import ClassifyPrompt from "./prompts/support-deflector/classify.mdx";
import RetrievePrompt from "./prompts/support-deflector/retrieve.mdx";
import DraftPrompt from "./prompts/support-deflector/draft.mdx";
import EscalatePrompt from "./prompts/support-deflector/escalate.mdx";

const classificationSchema = z.object({
  category: z.enum(["billing", "bug", "how-to", "account", "feature-request", "outage"]),
  sentiment: z.enum(["positive", "neutral", "frustrated", "angry"]),
  confidence: z.number().min(0).max(100),
  riskLevel: z.enum(["low", "medium", "high"]),
  escalate: z.boolean(),
  reasoning: z.string(),
});

const knowledgeSchema = z.object({
  articles: z.array(z.object({
    title: z.string(),
    relevance: z.number().min(0).max(100),
    snippet: z.string(),
    source: z.string(),
  })),
  coverageScore: z.number().min(0).max(100),
});

const draftSchema = z.object({
  subject: z.string(),
  body: z.string(),
  tone: z.enum(["empathetic", "professional", "technical"]),
  suggestedActions: z.array(z.string()),
  confidenceInDraft: z.number().min(0).max(100),
});

const escalationSchema = z.object({
  reason: z.string(),
  priority: z.enum(["urgent", "high", "normal"]),
  assignTo: z.string(),
  context: z.string(),
});

const outcomeSchema = z.object({
  status: z.enum(["deflected", "escalated"]),
  ticketId: z.string(),
  summary: z.string(),
});

const { Workflow, Task, Branch, smithers, outputs } = createSmithers({
  classification: classificationSchema,
  knowledge: knowledgeSchema,
  draft: draftSchema,
  escalation: escalationSchema,
  outcome: outcomeSchema,
});

const classifier = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep },
  instructions: `You are a support ticket classifier. Analyze the inbound ticket and determine
its category, customer sentiment, confidence level, and whether it should be escalated.
Escalate when risk is high, sentiment is angry, or the issue involves data loss / security.`,
});

const retriever = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep, bash },
  instructions: `You are a knowledge-base retrieval specialist. Given a classified support ticket,
search for relevant documentation, FAQ entries, and past resolutions. Return the most relevant
articles with relevance scores. Aim for high coverage so the draft agent can compose a reply.`,
});

const drafter = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read },
  instructions: `You are a support response drafter. Using the classification and retrieved knowledge,
compose a helpful, accurate reply. Match the tone to the customer's sentiment — be empathetic with
frustrated users, concise with technical users. Include actionable next steps.`,
});

const escalator = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read },
  instructions: `You are an escalation specialist. When a ticket cannot be safely deflected,
prepare a thorough escalation package with context, priority, and recommended assignee
so the human agent can resolve it quickly.`,
});

export default smithers((ctx) => {
  const classification = ctx.outputMaybe("classification", { nodeId: "classify" });
  const knowledge = ctx.outputMaybe("knowledge", { nodeId: "retrieve" });
  const draft = ctx.outputMaybe("draft", { nodeId: "draft-reply" });

  const shouldEscalate =
    classification?.escalate === true ||
    classification?.riskLevel === "high" ||
    classification?.confidence !== undefined && classification.confidence < 60 ||
    (knowledge?.coverageScore !== undefined && knowledge.coverageScore < 40) ||
    (draft?.confidenceInDraft !== undefined && draft.confidenceInDraft < 50);

  const ticketId = ctx.input.ticket?.id ?? "unknown";

  return (
    <Workflow name="support-deflector">
      <Sequence>
        {/* Step 1: Classify the inbound ticket */}
        <Task id="classify" output={outputs.classification} agent={classifier}>
          <ClassifyPrompt
            subject={ctx.input.ticket?.subject ?? ""}
            body={ctx.input.ticket?.body ?? ""}
            customer={ctx.input.ticket?.customer ?? "unknown"}
          />
        </Task>

        {/* Step 2: Retrieve relevant knowledge */}
        <Task id="retrieve" output={outputs.knowledge} agent={retriever}>
          <RetrievePrompt
            category={classification?.category ?? "how-to"}
            reasoning={classification?.reasoning ?? ""}
            subject={ctx.input.ticket?.subject ?? ""}
          />
        </Task>

        {/* Step 3: Draft a response */}
        <Task id="draft-reply" output={outputs.draft} agent={drafter}>
          <DraftPrompt
            category={classification?.category ?? "how-to"}
            sentiment={classification?.sentiment ?? "neutral"}
            articles={knowledge?.articles ?? []}
            subject={ctx.input.ticket?.subject ?? ""}
            body={ctx.input.ticket?.body ?? ""}
          />
        </Task>

        {/* Step 4: Escalate or deflect */}
        <Branch
          if={shouldEscalate}
          then={
            <Sequence>
              <Task id="escalate" output={outputs.escalation} agent={escalator}>
                <EscalatePrompt
                  ticketId={ticketId}
                  category={classification?.category ?? "unknown"}
                  riskLevel={classification?.riskLevel ?? "high"}
                  sentiment={classification?.sentiment ?? "unknown"}
                  reasoning={classification?.reasoning ?? ""}
                  draftConfidence={draft?.confidenceInDraft ?? 0}
                  coverageScore={knowledge?.coverageScore ?? 0}
                />
              </Task>

              <Task id="outcome-escalated" output={outputs.outcome}>
                {{
                  status: "escalated" as const,
                  ticketId,
                  summary: `Ticket escalated to human agent — ${classification?.riskLevel ?? "high"} risk, ${classification?.category ?? "unknown"} category`,
                }}
              </Task>
            </Sequence>
          }
          else={
            <Task id="outcome-deflected" output={outputs.outcome}>
              {{
                status: "deflected" as const,
                ticketId,
                summary: `Auto-replied with ${draft?.tone ?? "professional"} response covering ${knowledge?.articles?.length ?? 0} knowledge articles`,
              }}
            </Task>
          }
        />
      </Sequence>
    </Workflow>
  );
});
