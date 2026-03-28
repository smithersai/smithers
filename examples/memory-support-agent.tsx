/**
 * <MemorySupportAgent> — Handle support conversations while maintaining durable
 * customer-specific memory and retrieval, with isolation between users.
 *
 * Pattern: Support agent ↔ memory store ↔ tools/knowledge → escalation path.
 * Use cases: customer support with recall, personalised troubleshooting,
 * account-aware help desks, tiered escalation with context carry-over.
 */
import { createSmithers, Sequence } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import RecallPrompt from "./prompts/memory-support-agent/recall.mdx";
import RespondPrompt from "./prompts/memory-support-agent/respond.mdx";
import PersistPrompt from "./prompts/memory-support-agent/persist.mdx";
import EscalatePrompt from "./prompts/memory-support-agent/escalate.mdx";

const memoryEntrySchema = z.object({
  key: z.string(),
  value: z.string(),
  updatedAt: z.string(),
});

const recallSchema = z.object({
  customerId: z.string(),
  facts: z.array(memoryEntrySchema),
  recentTickets: z.array(z.string()),
  sentiment: z.enum(["positive", "neutral", "frustrated", "angry"]),
});

const responseSchema = z.object({
  reply: z.string(),
  confidenceScore: z.number().min(0).max(100),
  needsEscalation: z.boolean(),
  reasoning: z.string(),
  suggestedActions: z.array(z.string()),
});

const persistSchema = z.object({
  customerId: z.string(),
  newFacts: z.array(memoryEntrySchema),
  removedKeys: z.array(z.string()),
  summary: z.string(),
});

const escalationSchema = z.object({
  escalated: z.boolean(),
  tier: z.enum(["t1", "t2", "t3", "engineering"]),
  reason: z.string(),
  context: z.string(),
  summary: z.string(),
});

const { Workflow, Task, Branch, smithers, outputs } = createSmithers({
  recall: recallSchema,
  response: responseSchema,
  persist: persistSchema,
  escalation: escalationSchema,
});

const recallAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a memory retrieval specialist. Given a customer ID, load their
durable memory store and recent ticket history. Ensure strict isolation — never leak
facts from one customer into another's context. Assess current sentiment from the
conversation history.`,
});

const respondAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a senior support agent. Use the customer's recalled memory and
known facts to craft a personalised, accurate reply. Leverage past preferences,
known issues, and account configuration. Flag low-confidence answers for escalation
rather than guessing.`,
});

const persistAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash },
  instructions: `You are a memory persistence agent. After each support interaction,
extract new facts learned about the customer and update their durable memory store.
Remove stale or contradicted facts. Maintain strict per-customer isolation.`,
});

const escalationAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash },
  instructions: `You are an escalation router. When a support interaction exceeds the
agent's confidence or requires specialised access, determine the correct escalation
tier and package the full context so the receiving team can act without re-asking
the customer.`,
});

export default smithers((ctx) => {
  const recall = ctx.outputMaybe("recall", { nodeId: "recall" });
  const response = ctx.outputMaybe("response", { nodeId: "respond" });
  const persist = ctx.outputMaybe("persist", { nodeId: "persist" });

  const needsEscalation = response?.needsEscalation ?? false;

  return (
    <Workflow name="memory-support-agent">
      <Sequence>
        {/* 1. Recall: load customer memory with isolation */}
        <Task id="recall" output={outputs.recall} agent={recallAgent}>
          <RecallPrompt
            customerId={ctx.input.customerId ?? "unknown"}
            conversationHistory={ctx.input.conversationHistory ?? []}
          />
        </Task>

        {/* 2. Respond: craft a personalised reply using recalled memory */}
        <Task id="respond" output={outputs.response} agent={respondAgent}>
          <RespondPrompt
            customerId={recall?.customerId ?? "unknown"}
            facts={recall?.facts ?? []}
            recentTickets={recall?.recentTickets ?? []}
            sentiment={recall?.sentiment ?? "neutral"}
            latestMessage={ctx.input.latestMessage ?? ""}
          />
        </Task>

        {/* 3. Persist: update the customer's durable memory store */}
        <Task id="persist" output={outputs.persist} agent={persistAgent}>
          <PersistPrompt
            customerId={recall?.customerId ?? "unknown"}
            existingFacts={recall?.facts ?? []}
            reply={response?.reply ?? ""}
            latestMessage={ctx.input.latestMessage ?? ""}
          />
        </Task>

        {/* 4. Escalation path for low-confidence or complex cases */}
        <Branch
          if={needsEscalation}
          then={
            <Task id="escalate" output={outputs.escalation} agent={escalationAgent}>
              <EscalatePrompt
                customerId={recall?.customerId ?? "unknown"}
                confidenceScore={response?.confidenceScore ?? 0}
                reasoning={response?.reasoning ?? ""}
                suggestedActions={response?.suggestedActions ?? []}
                sentiment={recall?.sentiment ?? "neutral"}
                recentTickets={recall?.recentTickets ?? []}
              />
            </Task>
          }
        />
      </Sequence>
    </Workflow>
  );
});
