/**
 * <FinancialInboxGuard> — Monitor finance mailboxes for invoices, exceptions,
 * urgent approvals, or risky language and raise the right signal.
 *
 * Pattern: inbox trigger → classifier/extractor → finance-specific actions.
 * Use cases: AP automation, fraud detection, spend compliance, urgent approval routing.
 */
import { createSmithers, Sequence, Parallel } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import IngestPrompt from "./prompts/financial-inbox-guard/ingest.mdx";
import ClassifyPrompt from "./prompts/financial-inbox-guard/classify.mdx";
import ExtractInvoicePrompt from "./prompts/financial-inbox-guard/extract-invoice.mdx";
import DetectRiskPrompt from "./prompts/financial-inbox-guard/detect-risk.mdx";
import RoutePrompt from "./prompts/financial-inbox-guard/route.mdx";

const emailSchema = z.object({
  messageId: z.string().describe("Unique email message identifier"),
  from: z.string().describe("Sender address"),
  subject: z.string(),
  bodyPreview: z.string().describe("First 500 chars of email body"),
  attachments: z.array(z.string()).describe("Attachment filenames"),
  receivedAt: z.string().describe("ISO-8601 timestamp"),
});

const classificationSchema = z.object({
  messageId: z.string(),
  category: z.enum(["invoice", "exception", "urgent-approval", "risky-language", "informational"]),
  confidence: z.number().min(0).max(100),
  flags: z.array(z.string()).describe("Specific flags raised (e.g. duplicate-vendor, unusual-amount)"),
  summary: z.string(),
});

const invoiceExtractSchema = z.object({
  messageId: z.string(),
  invoiceNumber: z.string(),
  vendorName: z.string(),
  amount: z.number(),
  currency: z.string(),
  dueDate: z.string().describe("ISO-8601 date"),
  lineItems: z.array(z.object({
    description: z.string(),
    amount: z.number(),
  })),
  poMatch: z.boolean().describe("Whether a matching PO was found"),
});

const riskAssessmentSchema = z.object({
  messageId: z.string(),
  riskLevel: z.enum(["critical", "high", "medium", "low", "none"]),
  signals: z.array(z.object({
    type: z.string().describe("e.g. urgency-pressure, bank-change-request, impersonation"),
    evidence: z.string(),
    severity: z.enum(["critical", "high", "medium", "low"]),
  })),
  recommendation: z.string(),
});

const routingDecisionSchema = z.object({
  messageId: z.string(),
  action: z.enum(["auto-process", "queue-approval", "escalate", "quarantine", "archive"]),
  assignee: z.string().describe("Team or individual to route to"),
  priority: z.enum(["critical", "high", "normal", "low"]),
  notifyChannels: z.array(z.string()),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  email: emailSchema,
  classification: classificationSchema,
  invoice: invoiceExtractSchema,
  risk: riskAssessmentSchema,
  routing: routingDecisionSchema,
});

const classifier = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep },
  instructions: `You are a financial email classifier. Analyze the email subject, body, sender,
and attachments to determine the category: invoice, exception (PO mismatch, short-pay, etc.),
urgent-approval (time-sensitive spend requests), risky-language (social engineering, bank change
requests, impersonation), or informational. Flag anything anomalous.`,
});

const invoiceExtractor = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are an invoice data extractor. Parse invoice details from email body and
attachments: invoice number, vendor, amount, currency, due date, and line items. Cross-reference
against known PO numbers to determine if there is a match. Be precise with amounts and dates.`,
});

const riskDetector = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep },
  instructions: `You are a financial fraud and risk detection specialist. Scan email content for
social engineering tactics (urgency pressure, authority impersonation, bank detail change requests),
unusual patterns (first-time vendor, amount outliers, domain spoofing), and compliance red flags.
Assign a risk level and cite specific evidence for each signal.`,
});

export default smithers((ctx) => {
  const email = ctx.outputMaybe("email", { nodeId: "ingest" });
  const classification = ctx.outputMaybe("classification", { nodeId: "classify" });
  const invoice = ctx.outputMaybe("invoice", { nodeId: "extract-invoice" });
  const risk = ctx.outputMaybe("risk", { nodeId: "detect-risk" });

  return (
    <Workflow name="financial-inbox-guard">
      <Sequence>
        {/* Phase 1: Ingest and normalize the raw email */}
        <Task id="ingest" output={outputs.email}>
          <IngestPrompt
            rawEmail={ctx.input.rawEmail}
            mailbox={ctx.input.mailbox ?? "ap@company.com"}
          />
        </Task>

        {/* Phase 2: Classify the email and detect risk in parallel */}
        <Parallel maxConcurrency={2}>
          <Task id="classify" output={outputs.classification} agent={classifier}>
            <ClassifyPrompt
              email={email}
              knownVendors={ctx.input.knownVendors ?? []}
              recentExceptions={ctx.input.recentExceptions ?? []}
            />
          </Task>
          <Task id="detect-risk" output={outputs.risk} agent={riskDetector}>
            <DetectRiskPrompt
              email={email}
              knownDomains={ctx.input.knownDomains ?? []}
              recentBankChanges={ctx.input.recentBankChanges ?? []}
            />
          </Task>
        </Parallel>

        {/* Phase 3: Extract invoice details if classified as invoice */}
        <Task id="extract-invoice" output={outputs.invoice} agent={invoiceExtractor}>
          <ExtractInvoicePrompt
            email={email}
            category={classification?.category ?? "informational"}
            openPOs={ctx.input.openPOs ?? []}
          />
        </Task>

        {/* Phase 4: Route to the right action based on classification + risk */}
        <Task id="route" output={outputs.routing}>
          <RoutePrompt
            messageId={email?.messageId ?? "unknown"}
            classification={classification}
            risk={risk}
            invoice={invoice}
            approvalThreshold={ctx.input.approvalThreshold ?? 10000}
            escalationTeam={ctx.input.escalationTeam ?? "finance-ops"}
            notifyChannels={ctx.input.notifyChannels ?? ["#finance-alerts"]}
          />
        </Task>
      </Sequence>
    </Workflow>
  );
});
