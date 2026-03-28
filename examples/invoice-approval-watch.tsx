// @ts-nocheck
/**
 * <InvoiceApprovalWatch> — Extract invoice data, validate against rules,
 * and route only suspicious or high-value items for human approval.
 *
 * Pattern: email/file trigger → extractor → rule checker → approval queue.
 * Use cases: AP automation, fraud detection, duplicate invoice flagging,
 * threshold-based approval routing, vendor compliance checks.
 */
import { createSmithers, Sequence } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import ExtractPrompt from "./prompts/invoice-approval-watch/extract.mdx";
import ValidatePrompt from "./prompts/invoice-approval-watch/validate.mdx";
import RoutePrompt from "./prompts/invoice-approval-watch/route.mdx";

const invoiceDataSchema = z.object({
  invoices: z.array(z.object({
    id: z.string(),
    invoiceNumber: z.string(),
    vendorName: z.string(),
    vendorId: z.string().optional(),
    amount: z.number(),
    currency: z.string().default("USD"),
    lineItems: z.array(z.object({
      description: z.string(),
      quantity: z.number(),
      unitPrice: z.number(),
      total: z.number(),
    })),
    dueDate: z.string().optional(),
    poNumber: z.string().optional(),
    sourceFile: z.string(),
  })),
});

const validationSchema = z.object({
  results: z.array(z.object({
    invoiceId: z.string(),
    invoiceNumber: z.string(),
    vendorName: z.string(),
    amount: z.number(),
    flags: z.array(z.enum([
      "high-value",
      "duplicate-suspect",
      "vendor-mismatch",
      "missing-po",
      "unusual-line-items",
      "over-budget",
      "new-vendor",
      "none",
    ])),
    riskScore: z.number().min(0).max(1),
    needsApproval: z.boolean(),
    reasoning: z.string(),
  })),
});

const approvalQueueSchema = z.object({
  totalProcessed: z.number(),
  autoApproved: z.number(),
  queuedForApproval: z.number(),
  rejected: z.number(),
  queue: z.array(z.object({
    invoiceId: z.string(),
    invoiceNumber: z.string(),
    vendorName: z.string(),
    amount: z.number(),
    flags: z.array(z.string()),
    riskScore: z.number(),
    assignedApprover: z.string(),
    priority: z.enum(["urgent", "standard", "low"]),
    recommendedAction: z.enum(["approve", "review", "reject"]),
    reasoning: z.string(),
  })),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  invoiceData: invoiceDataSchema,
  validation: validationSchema,
  approvalQueue: approvalQueueSchema,
});

const extractor = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep, bash },
  instructions: `You are an invoice data extractor. Parse incoming emails, PDFs,
and attachments to extract structured invoice data. Identify invoice number,
vendor, line items, amounts, PO references, and due dates. Handle multiple
formats and normalize currency values.`,
});

const ruleChecker = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep, bash },
  instructions: `You are an invoice validation agent. Check each extracted invoice
against approval rules: flag high-value invoices above threshold, detect potential
duplicates, verify vendor records, check PO matching, and identify unusual line
items. Assign a risk score and determine whether human approval is needed.`,
});

const approvalRouter = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash },
  instructions: `You are an approval queue coordinator. Take validated invoices
that need human review and route them to the correct approver based on amount
thresholds, department, and vendor tier. Auto-approve clean invoices below
threshold. Prioritize by due date urgency and risk score.`,
});

export default smithers((ctx) => {
  const extracted = ctx.outputMaybe("invoiceData", { nodeId: "extract" });
  const validated = ctx.outputMaybe("validation", { nodeId: "validate" });

  const flagged = validated?.results?.filter((r) => r.needsApproval) ?? [];

  return (
    <Workflow name="invoice-approval-watch">
      <Sequence>
        {/* Stage 1: Extract structured invoice data from emails/files */}
        <Task id="extract" output={outputs.invoiceData} agent={extractor}>
          <ExtractPrompt
            source={ctx.input.source ?? "email"}
            files={ctx.input.files ?? null}
            inboxFilter={ctx.input.inboxFilter ?? null}
          />
        </Task>

        {/* Stage 2: Validate invoices against approval rules */}
        <Task id="validate" output={outputs.validation} agent={ruleChecker}>
          <ValidatePrompt
            invoices={extracted?.invoices ?? []}
            approvalThreshold={ctx.input.approvalThreshold ?? 5000}
            vendorAllowlist={ctx.input.vendorAllowlist ?? null}
            duplicateWindow={ctx.input.duplicateWindow ?? "30d"}
          />
        </Task>

        {/* Stage 3: Route suspicious/high-value items to approval queue */}
        <Task id="route" output={outputs.approvalQueue} agent={approvalRouter}>
          <RoutePrompt
            flaggedInvoices={flagged}
            totalProcessed={validated?.results?.length ?? 0}
            approverMapping={ctx.input.approverMapping ?? null}
            escalationRules={ctx.input.escalationRules ?? null}
          />
        </Task>
      </Sequence>
    </Workflow>
  );
});
