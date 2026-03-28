// @ts-nocheck
/**
 * <RevenueScout> — Scan support conversations, forms, or email threads
 * to find latent sales opportunities and route them to sales.
 *
 * Pattern: message stream → classifier/extractor → CRM handoff.
 * Use cases: upsell detection, expansion signals, churn-risk flagging,
 * cross-sell identification, renewal timing.
 */
import { createSmithers, Sequence } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import ClassifyPrompt from "./prompts/revenue-scout/classify.mdx";
import ExtractPrompt from "./prompts/revenue-scout/extract.mdx";
import HandoffPrompt from "./prompts/revenue-scout/handoff.mdx";

const opportunitySchema = z.object({
  conversations: z.array(z.object({
    id: z.string(),
    source: z.enum(["support", "form", "email"]),
    hasSignal: z.boolean(),
    signalType: z.enum(["upsell", "expansion", "cross-sell", "renewal", "none"]),
    confidence: z.number().min(0).max(1),
    reasoning: z.string(),
  })),
});

const extractionSchema = z.object({
  opportunities: z.array(z.object({
    conversationId: z.string(),
    signalType: z.enum(["upsell", "expansion", "cross-sell", "renewal"]),
    product: z.string(),
    customerName: z.string(),
    accountId: z.string().optional(),
    estimatedValue: z.string().optional(),
    keyQuotes: z.array(z.string()),
    urgency: z.enum(["immediate", "near-term", "exploratory"]),
    summary: z.string(),
  })),
});

const handoffSchema = z.object({
  totalScanned: z.number(),
  opportunitiesFound: z.number(),
  routedToCrm: z.number(),
  bySignalType: z.record(z.number()),
  handoffs: z.array(z.object({
    conversationId: z.string(),
    assignedRep: z.string(),
    priority: z.enum(["hot", "warm", "cool"]),
    nextStep: z.string(),
  })),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  opportunity: opportunitySchema,
  extraction: extractionSchema,
  handoff: handoffSchema,
});

const classifier = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep, bash },
  instructions: `You are a revenue signal classifier. Scan support conversations,
form submissions, and email threads for latent sales opportunities.
Look for expansion intent, feature requests tied to growth, multi-team rollout
language, budget mentions, competitor comparisons, and renewal timing cues.
Mark conversations with no signal as "none".`,
});

const extractor = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep, bash },
  instructions: `You are a sales intelligence extractor. For each flagged conversation,
extract structured opportunity data: customer details, signal type, product interest,
key quotes, and estimated deal urgency. Be precise — sales reps will act on this.`,
});

const router = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash },
  instructions: `You are a CRM handoff coordinator. Take extracted opportunities and
prepare them for sales team routing. Assign priority based on urgency and estimated
value. Map each opportunity to the appropriate sales rep or queue.`,
});

export default smithers((ctx) => {
  const classified = ctx.outputMaybe("opportunity", { nodeId: "classify" });
  const extracted = ctx.outputMaybe("extraction", { nodeId: "extract" });

  const flagged = classified?.conversations?.filter((c) => c.hasSignal) ?? [];

  return (
    <Workflow name="revenue-scout">
      <Sequence>
        {/* Stage 1: Classify inbound message stream for revenue signals */}
        <Task id="classify" output={outputs.opportunity} agent={classifier}>
          <ClassifyPrompt
            source={ctx.input.source ?? "support"}
            conversations={ctx.input.conversations ?? null}
            fetchCmd={ctx.input.fetchCmd ?? null}
          />
        </Task>

        {/* Stage 2: Extract structured opportunity data from flagged conversations */}
        {flagged.length > 0 && (
          <Task id="extract" output={outputs.extraction} agent={extractor}>
            <ExtractPrompt
              flaggedConversations={flagged}
              accountContext={ctx.input.accountContext ?? null}
            />
          </Task>
        )}

        {/* Stage 3: Route opportunities to CRM / sales reps */}
        <Task id="handoff" output={outputs.handoff} agent={router}>
          <HandoffPrompt
            opportunities={extracted?.opportunities ?? []}
            totalScanned={classified?.conversations?.length ?? 0}
            crmTarget={ctx.input.crmTarget ?? "salesforce"}
            teamMapping={ctx.input.teamMapping ?? null}
          />
        </Task>
      </Sequence>
    </Workflow>
  );
});
