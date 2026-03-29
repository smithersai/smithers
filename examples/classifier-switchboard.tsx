/**
 * <ClassifierSwitchboard> — Route messages/tickets/files through a typed enum
 * classifier to specialized domain handlers.
 *
 * Pattern: intake → classifier → switchboard → domain-specific steps.
 * Use cases: support ticket routing, message dispatching, file processing
 * pipelines, multi-domain intake systems.
 */
import { Sequence, Parallel } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import IntakePrompt from "./prompts/classifier-switchboard/intake.mdx";
import ClassifyPrompt from "./prompts/classifier-switchboard/classify.mdx";
import SupportPrompt from "./prompts/classifier-switchboard/support.mdx";
import SalesPrompt from "./prompts/classifier-switchboard/sales.mdx";
import SecurityPrompt from "./prompts/classifier-switchboard/security.mdx";
import BillingPrompt from "./prompts/classifier-switchboard/billing.mdx";
import SummaryPrompt from "./prompts/classifier-switchboard/summary.mdx";

const domain = z.enum(["support", "sales", "security", "billing"]);

const intakeSchema = z.object({
  items: z.array(z.object({
    id: z.string(),
    content: z.string(),
    source: z.enum(["email", "chat", "ticket", "file"]),
    metadata: z.record(z.string(), z.string()).optional(),
  })),
});

const classificationSchema = z.object({
  classifications: z.array(z.object({
    itemId: z.string(),
    domain: domain,
    confidence: z.number().min(0).max(1),
    reasoning: z.string(),
    priority: z.enum(["critical", "high", "normal", "low"]),
  })),
});

const handlerResultSchema = z.object({
  itemId: z.string(),
  domain: domain,
  action: z.string(),
  status: z.enum(["resolved", "escalated", "pending"]),
  response: z.string(),
});

const summarySchema = z.object({
  totalProcessed: z.number(),
  byDomain: z.record(z.string(), z.number()),
  byStatus: z.record(z.string(), z.number()),
  escalations: z.array(z.object({
    itemId: z.string(),
    domain: z.string(),
    reason: z.string(),
  })),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
  intake: intakeSchema,
  classification: classificationSchema,
  handlerResult: handlerResultSchema,
  summary: summarySchema,
});

const intakeAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash },
  instructions: `You are an intake processor. Normalize incoming messages, tickets, and files
into a structured format for classification. Extract key content and metadata.`,
});

const classifierAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  instructions: `You are a classifier. Assign each item to exactly one domain: support, sales,
security, or billing. Provide a confidence score and priority level.
Be decisive — pick the single best domain even when items touch multiple areas.`,
});

const makeDomainHandler = (role: string, toolset: Record<string, any>) =>
  new Agent({
    model: anthropic("claude-sonnet-4-20250514"),
    tools: toolset as any,
    instructions: `You are the ${role} handler. Process the routed item according to
${role} best practices. Resolve if possible, otherwise escalate with clear reasoning.`,
  });

const domainHandlers: Record<z.infer<typeof domain>, any> = {
  support: makeDomainHandler("customer support", { read, bash, grep }),
  sales: makeDomainHandler("sales inquiry", { read, grep }),
  security: makeDomainHandler("security incident", { read, bash, grep }),
  billing: makeDomainHandler("billing", { read, grep }),
};

const domainPrompts: Record<z.infer<typeof domain>, typeof SupportPrompt> = {
  support: SupportPrompt,
  sales: SalesPrompt,
  security: SecurityPrompt,
  billing: BillingPrompt,
};

export default smithers((ctx) => {
  const intake = ctx.outputMaybe("intake", { nodeId: "intake" });
  const classification = ctx.outputMaybe("classification", { nodeId: "classify" });
  const results = ctx.outputs.handlerResult ?? [];

  const classified = classification?.classifications ?? [];

  return (
    <Workflow name="classifier-switchboard">
      <Sequence>
        {/* Stage 1: Intake — normalize raw input */}
        <Task id="intake" output={outputs.intake} agent={intakeAgent}>
          <IntakePrompt
            source={ctx.input.source ?? "mixed"}
            items={ctx.input.items ?? null}
            fetchCmd={ctx.input.fetchCmd ?? null}
          />
        </Task>

        {/* Stage 2: Classifier — assign each item to a domain */}
        {intake && (
          <Task id="classify" output={outputs.classification} agent={classifierAgent}>
            <ClassifyPrompt
              items={intake.items}
              domains={["support", "sales", "security", "billing"]}
            />
          </Task>
        )}

        {/* Stage 3: Switchboard — fan out to domain-specific handlers */}
        {classified.length > 0 && (
          <Parallel maxConcurrency={5}>
            {classified.map((c) => {
              const item = intake?.items.find((i) => i.id === c.itemId);
              const DomainPrompt = domainPrompts[c.domain];
              return (
                <Task
                  key={c.itemId}
                  id={`handle-${c.domain}-${c.itemId}`}
                  output={outputs.handlerResult}
                  agent={domainHandlers[c.domain]}
                  continueOnFail
                >
                  <DomainPrompt
                    itemId={c.itemId}
                    content={item?.content ?? ""}
                    priority={c.priority}
                    confidence={c.confidence}
                    reasoning={c.reasoning}
                    metadata={item?.metadata ?? {}}
                  />
                </Task>
              );
            })}
          </Parallel>
        )}

        {/* Stage 4: Summary — aggregate switchboard results */}
        <Task id="summary" output={outputs.summary} agent={classifierAgent}>
          <SummaryPrompt
            classifications={classified}
            results={results}
            totalItems={intake?.items.length ?? 0}
          />
        </Task>
      </Sequence>
    </Workflow>
  );
});
