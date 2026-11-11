/**
 * Read one finance-mailbox email, classify it, check it for fraud signals, and decide the action and alert for it.
 *
 * Port of the 0.x `financial-inbox-guard.jsx`. An ingest agent normalizes the
 * raw email. A classifier agent (invoice, exception, urgent approval, risky
 * language, informational) and a risk agent (social engineering, spoofing,
 * bank-detail changes) read it in parallel. An extractor agent then pulls
 * invoice fields, told the category, and a routing agent picks the action,
 * assignee, priority and channels to notify from all three answers.
 *
 * The invoice extractor runs for every category, told the category, as it did in 0.x.
 * 0.x declared `ingest` and `route` with prompts but no agent, so they could not produce their schemas; here each is an agent step.
 * 0.x's prompts were placeholders that printed their props; these are minimal prompts written from the same props.
 * 0.x gave the agents `read`, `bash` and `grep` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

/** The normalized email. */
export const Email = Schema.Struct({
  messageId: Schema.String.annotate({ description: "Unique email message identifier" }),
  from: Schema.String.annotate({ description: "Sender address" }),
  subject: Schema.String,
  bodyPreview: Schema.String.annotate({ description: "First 500 chars of email body" }),
  attachments: Schema.Array(Schema.String).annotate({ description: "Attachment filenames" }),
  receivedAt: Schema.String.annotate({ description: "ISO-8601 timestamp" })
})

/** What kind of finance email it is. `confidence` is 0 to 100. */
export const Classification = Schema.Struct({
  messageId: Schema.String,
  category: Schema.Literals(["invoice", "exception", "urgent-approval", "risky-language", "informational"]),
  confidence: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  flags: Schema.Array(Schema.String).annotate({
    description: "Specific flags raised (e.g. duplicate-vendor, unusual-amount)"
  }),
  summary: Schema.String
})

/** The invoice fields the email carries. */
export const InvoiceExtract = Schema.Struct({
  messageId: Schema.String,
  invoiceNumber: Schema.String,
  vendorName: Schema.String,
  amount: Schema.Number,
  currency: Schema.String,
  dueDate: Schema.String.annotate({ description: "ISO-8601 date" }),
  lineItems: Schema.Array(Schema.Struct({ description: Schema.String, amount: Schema.Number })),
  poMatch: Schema.Boolean.annotate({ description: "Whether a matching PO was found" })
})

/** The fraud and risk signals in the email. */
export const RiskAssessment = Schema.Struct({
  messageId: Schema.String,
  riskLevel: Schema.Literals(["critical", "high", "medium", "low", "none"]),
  signals: Schema.Array(Schema.Struct({
    type: Schema.String.annotate({ description: "e.g. urgency-pressure, bank-change-request, impersonation" }),
    evidence: Schema.String,
    severity: Schema.Literals(["critical", "high", "medium", "low"])
  })),
  recommendation: Schema.String
})

/** The action and alert the flow settles with. */
export const RoutingDecision = Schema.Struct({
  messageId: Schema.String,
  action: Schema.Literals(["auto-process", "queue-approval", "escalate", "quarantine", "archive"]),
  assignee: Schema.String.annotate({ description: "Team or individual to route to" }),
  priority: Schema.Literals(["critical", "high", "normal", "low"]),
  notifyChannels: Schema.Array(Schema.String),
  summary: Schema.String
})

/** Normalizes the raw email. */
export const Ingest = AgentAction.make("examples/FinancialInboxGuard/Ingest", {
  payload: { rawEmail: Schema.String, mailbox: Schema.String },
  output: Email,
  seat,
  prompt: ({ mailbox, rawEmail }) =>
    `Normalize this raw email from the ${mailbox} mailbox.\n\nRaw email: ${JSON.stringify(rawEmail)}`
})

/** Classifies the email. */
export const Classify = AgentAction.make("examples/FinancialInboxGuard/Classify", {
  payload: { email: Email, knownVendors: Schema.Array(Schema.Json), recentExceptions: Schema.Array(Schema.Json) },
  output: Classification,
  seat,
  system: [
    `You are a financial email classifier. Analyze the email subject, body, sender,
and attachments to determine the category: invoice, exception (PO mismatch, short-pay, etc.),
urgent-approval (time-sensitive spend requests), risky-language (social engineering, bank change
requests, impersonation), or informational. Flag anything anomalous.`
  ],
  prompt: ({ email, knownVendors, recentExceptions }) =>
    `Classify this email.\n\nEmail: ${JSON.stringify(email)}\nKnown vendors: ${
      JSON.stringify(knownVendors)
    }\nRecent exceptions: ${JSON.stringify(recentExceptions)}`
})

/** Scans the email for fraud and risk signals. */
export const DetectRisk = AgentAction.make("examples/FinancialInboxGuard/DetectRisk", {
  payload: { email: Email, knownDomains: Schema.Array(Schema.Json), recentBankChanges: Schema.Array(Schema.Json) },
  output: RiskAssessment,
  seat,
  system: [
    `You are a financial fraud and risk detection specialist. Scan email content for
social engineering tactics (urgency pressure, authority impersonation, bank detail change requests),
unusual patterns (first-time vendor, amount outliers, domain spoofing), and compliance red flags.
Assign a risk level and cite specific evidence for each signal.`
  ],
  prompt: ({ email, knownDomains, recentBankChanges }) =>
    `Assess this email for risk.\n\nEmail: ${JSON.stringify(email)}\nKnown domains: ${
      JSON.stringify(knownDomains)
    }\nRecent bank changes: ${JSON.stringify(recentBankChanges)}`
})

/** Pulls the invoice fields, told the email's category. */
export const ExtractInvoice = AgentAction.make("examples/FinancialInboxGuard/ExtractInvoice", {
  payload: { email: Email, category: Classification.fields.category, openPOs: Schema.Array(Schema.Json) },
  output: InvoiceExtract,
  seat,
  system: [
    `You are an invoice data extractor. Parse invoice details from email body and
attachments: invoice number, vendor, amount, currency, due date, and line items. Cross-reference
against known PO numbers to determine if there is a match. Be precise with amounts and dates.`
  ],
  prompt: ({ category, email, openPOs }) =>
    `Extract the invoice details from this email.\n\nCategory: ${category}\nEmail: ${
      JSON.stringify(email)
    }\nOpen POs: ${JSON.stringify(openPOs)}`
})

/** Picks the action, assignee, priority and channels. */
export const Route = AgentAction.make("examples/FinancialInboxGuard/Route", {
  payload: {
    messageId: Schema.String,
    classification: Classification,
    risk: RiskAssessment,
    invoice: InvoiceExtract,
    approvalThreshold: Schema.Number,
    escalationTeam: Schema.String,
    notifyChannels: Schema.Array(Schema.String)
  },
  output: RoutingDecision,
  seat,
  prompt: ({ approvalThreshold, classification, escalationTeam, invoice, messageId, notifyChannels, risk }) =>
    `Decide the action for finance email ${messageId}.\n\nApproval threshold: ${approvalThreshold}\nEscalation team: ${escalationTeam}\nNotify channels: ${
      JSON.stringify(notifyChannels)
    }\nClassification: ${JSON.stringify(classification)}\nRisk: ${JSON.stringify(risk)}\nInvoice: ${
      JSON.stringify(invoice)
    }`
})

/** The flow: ingest, classify and assess risk in parallel, extract, route. */
export const FinancialInboxGuard = Flow.make("examples/FinancialInboxGuard", {
  payload: {
    rawEmail: Schema.String,
    mailbox: Schema.optional(Schema.String),
    knownVendors: Schema.optional(Schema.Array(Schema.Json)),
    recentExceptions: Schema.optional(Schema.Array(Schema.Json)),
    knownDomains: Schema.optional(Schema.Array(Schema.Json)),
    recentBankChanges: Schema.optional(Schema.Array(Schema.Json)),
    openPOs: Schema.optional(Schema.Array(Schema.Json)),
    approvalThreshold: Schema.optional(Schema.Number),
    escalationTeam: Schema.optional(Schema.String),
    notifyChannels: Schema.optional(Schema.Array(Schema.String))
  },
  success: RoutingDecision,
  error: AgentAction.AgentFailure,
  body: ({
    approvalThreshold = 10_000,
    escalationTeam = "finance-ops",
    knownDomains = [],
    knownVendors = [],
    mailbox = "ap@company.com",
    notifyChannels = ["#finance-alerts"],
    openPOs = [],
    rawEmail,
    recentBankChanges = [],
    recentExceptions = []
  }) =>
    Node.bindPlanned(
      Ingest.call({ rawEmail, mailbox }),
      (email: Planned.Planned<typeof Email.Type>) =>
        Node.bindPlanned(
          Node.all({
            classification: Classify.call({ email, knownVendors, recentExceptions }),
            risk: DetectRisk.call({ email, knownDomains, recentBankChanges })
          }),
          (checked) =>
            Node.bindPlanned(
              ExtractInvoice.call({ email, category: checked.classification.category, openPOs }),
              (invoice: Planned.Planned<typeof InvoiceExtract.Type>) =>
                Route.call({
                  messageId: email.messageId,
                  classification: checked.classification,
                  risk: checked.risk,
                  invoice,
                  approvalThreshold,
                  escalationTeam,
                  notifyChannels
                })
            )
        )
    )
})

/** Every step the flow calls. */
export const layer = Layer.mergeAll(Ingest.layer, Classify.layer, DetectRisk.layer, ExtractInvoice.layer, Route.layer)
