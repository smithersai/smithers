/**
 * <ReceiptStreamWatcher> — Stream a structured extraction from receipt data and
 * stop early once enough high-confidence fields are present for routing or
 * validation.
 *
 * Pattern: file/input → streaming extractor → partial-state consumer → downstream step.
 * Use cases: receipt OCR streaming, invoice field extraction, real-time document
 * parsing with early exit, confidence-gated routing.
 */
import { createSmithers, Sequence } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import ExtractPrompt from "./prompts/receipt-stream-watcher/extract.mdx";
import ConsumePrompt from "./prompts/receipt-stream-watcher/consume.mdx";
import RoutePrompt from "./prompts/receipt-stream-watcher/route.mdx";

const fieldConfidenceSchema = z.object({
  value: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});

const partialExtractionSchema = z.object({
  merchant: fieldConfidenceSchema,
  total: fieldConfidenceSchema,
  date: fieldConfidenceSchema,
  currency: fieldConfidenceSchema,
  lineItems: z.array(z.object({
    description: z.string(),
    amount: z.number(),
  })).optional(),
  iterationsUsed: z.number(),
  complete: z.boolean(),
});

const consumeResultSchema = z.object({
  merchant: z.string().nullable(),
  total: z.number().nullable(),
  date: z.string().nullable(),
  currency: z.string().nullable(),
  highConfidenceCount: z.number(),
  readyForRouting: z.boolean(),
  summary: z.string(),
});

const routingDecisionSchema = z.object({
  destination: z.enum(["expense-report", "reimbursement", "audit-review", "manual-review"]),
  merchant: z.string(),
  total: z.number(),
  currency: z.string(),
  date: z.string(),
  reasoning: z.string(),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  extraction: partialExtractionSchema,
  consumed: consumeResultSchema,
  routing: routingDecisionSchema,
});

const CONFIDENCE_THRESHOLD = 0.85;
const MIN_FIELDS_FOR_ROUTING = 3;

const extractorAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a receipt extraction agent. Read the provided receipt file or
text and extract structured fields (merchant, total, date, currency, line items).
For each field, assign a confidence score between 0 and 1. Stream partial results
as you identify each field — you do not need every field to produce output.`,
});

const consumerAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read },
  instructions: `You are a partial-state consumer. Evaluate the extracted fields and
their confidence scores. Determine whether enough high-confidence fields are present
to route the receipt downstream. A field is "high confidence" if its score is >= ${CONFIDENCE_THRESHOLD}.
At least ${MIN_FIELDS_FOR_ROUTING} high-confidence fields are needed for routing.`,
});

const routingAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep },
  instructions: `You are a receipt routing agent. Based on the extracted and validated
fields, decide which downstream process should handle this receipt: expense-report
(standard business expense), reimbursement (employee out-of-pocket), audit-review
(high-value or flagged), or manual-review (insufficient data).`,
});

export default smithers((ctx) => {
  const extraction = ctx.outputMaybe("extraction", { nodeId: "extract" });
  const consumed = ctx.outputMaybe("consumed", { nodeId: "consume" });

  const fields = extraction
    ? [extraction.merchant, extraction.total, extraction.date, extraction.currency]
    : [];
  const highConfCount = fields.filter(
    (f) => f && f.confidence >= CONFIDENCE_THRESHOLD && f.value != null,
  ).length;
  const readyForRouting = highConfCount >= MIN_FIELDS_FOR_ROUTING;

  return (
    <Workflow name="receipt-stream-watcher">
      <Sequence>
        {/* Step 1: Stream extraction from receipt file/input */}
        <Task id="extract" output={outputs.extraction} agent={extractorAgent}>
          <ExtractPrompt
            file={ctx.input.file ?? null}
            text={ctx.input.text ?? null}
            confidenceThreshold={CONFIDENCE_THRESHOLD}
          />
        </Task>

        {/* Step 2: Consume partial state and decide if routing-ready */}
        <Task id="consume" output={outputs.consumed} agent={consumerAgent}>
          <ConsumePrompt
            extraction={extraction}
            threshold={CONFIDENCE_THRESHOLD}
            minFields={MIN_FIELDS_FOR_ROUTING}
          />
        </Task>

        {/* Step 3: Route downstream — only if enough confident fields */}
        {(consumed?.readyForRouting ?? readyForRouting) && (
          <Task id="route" output={outputs.routing} agent={routingAgent}>
            <RoutePrompt
              merchant={extraction?.merchant?.value ?? null}
              total={extraction?.total?.value ?? null}
              currency={extraction?.currency?.value ?? null}
              date={extraction?.date?.value ?? null}
              highConfidenceCount={consumed?.highConfidenceCount ?? highConfCount}
            />
          </Task>
        )}
      </Sequence>
    </Workflow>
  );
});
