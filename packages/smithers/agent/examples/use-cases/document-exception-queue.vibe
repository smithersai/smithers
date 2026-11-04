/**
 * Classify and extract a document packet in parallel, reconcile it, and ask a person only about high-severity exceptions.
 *
 * Port of the 0.x `document-exception-queue.jsx`. A classifier agent types each
 * file of the packet, then an extractor agent extracts each file told every
 * file's type, both at most `maxConcurrency` (default 8) at a time. A
 * reconciliation agent checks the extractions against each other and the
 * vendor master; while it fails, a targeted re-extraction adds a corrected
 * extraction and it checks again, for at most `maxReconcileIterations` rounds
 * (default 2). A high-severity exception in the last reconciliation asks a
 * person to review the packet, and a denial fails the run. An export agent
 * then writes the normalized record and exception queue.
 *
 * 0.x's `<Parallel maxConcurrency>` is `Bounded.all`; its `<Approval>` is a `HumanTask` asking for 0.x's approval schema, and a denial fails the run as 0.x's default did.
 * 0.x's prompts ended by asking for "only structured data matching the task output schema"; `AgentAction` renders and enforces the output schema instead.
 * 0.x gave the agents `read`, `write`, `bash` and `grep` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { type Action, Flow, HumanTask } from "@smthrs/flow"
import * as Bounded from "@smthrs/patterns/Bounded"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

const Fraction = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))

/** The packet 0.x reconciled when given no files. */
export const defaultFiles = [
  "fixtures/document-exception-queue/invoice.pdf",
  "fixtures/document-exception-queue/purchase-order.pdf",
  "fixtures/document-exception-queue/receipt.png"
]

/** The fields 0.x extracted when given none. */
export const defaultTargetFields = ["vendor", "amount", "tax", "poNumber", "date", "lineItems"]

/** The reconciliation checks 0.x ran when given none. */
export const defaultChecks = [
  "Invoice total equals line subtotal plus tax.",
  "Vendor matches vendor master.",
  "PO number appears on purchase order and invoice.",
  "Receipt amount does not exceed approved PO amount."
]

/** The name the review question is asked under. */
export const reviewTask = "human-exception-review"

/** One file's document type. */
export const DocumentClass = Schema.Struct({
  file: Schema.String,
  type: Schema.Literals(["invoice", "purchase-order", "receipt", "contract", "bank-statement", "unknown"]),
  confidence: Fraction,
  reason: Schema.String
})

/** One file's extracted fields and tables. */
export const Extraction = Schema.Struct({
  file: Schema.String,
  fields: Schema.Record(Schema.String, Schema.Json),
  tables: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
  confidence: Fraction,
  missingFields: Schema.Array(Schema.String)
})

/** The reconciliation's verdict. */
export const Reconciliation = Schema.Struct({
  passed: Schema.Boolean,
  checks: Schema.Array(Schema.Struct({ name: Schema.String, passed: Schema.Boolean, explanation: Schema.String })),
  exceptions: Schema.Array(Schema.Struct({
    severity: Schema.Literals(["low", "medium", "high"]),
    message: Schema.String,
    files: Schema.Array(Schema.String)
  }))
})

/** The reviewer's decision on the high-severity exceptions. */
export const Approval = Schema.Struct({ approved: Schema.Boolean, reviewer: Schema.String, note: Schema.String })

/** What the export wrote. The flow settles with it. */
export const ExportRecord = Schema.Struct({
  normalizedJsonPath: Schema.String,
  exceptionQueuePath: Schema.String,
  passThrough: Schema.Boolean,
  summary: Schema.String
})

/** The failure a denied review settles with. */
export const ReviewDenied = Schema.TaggedStruct("examples/DocumentExceptionQueue/ReviewDenied", {
  reviewer: Schema.String,
  note: Schema.String
})

/** {@link Approval} as the JSON Schema a `HumanTask` checks an answer against. */
const approvalSchema = {
  type: "object",
  properties: { approved: { type: "boolean" }, reviewer: { type: "string" }, note: { type: "string" } },
  required: ["approved", "reviewer", "note"]
}

const extractorSystem = `You are a document extractor. Extract typed fields and tables,
track missing fields, and report honest confidence. Prefer source-grounded values.`

/** Types one file of the packet. */
export const Classify = AgentAction.make("examples/DocumentExceptionQueue/Classify", {
  payload: { file: Schema.String, packetContext: Schema.String },
  output: DocumentClass,
  seat,
  system: [
    `You are a document packet classifier. Identify document type and
confidence from filenames, OCR text, or supplied content. Explain uncertain cases.`
  ],
  prompt: (input) =>
    `Classify the document type and confidence. Explain uncertain classifications from filename, content, or packet context.\n\nINPUT: ${
      JSON.stringify(input)
    }`
})

/** Extracts one file, told every file's type. */
export const Extract = AgentAction.make("examples/DocumentExceptionQueue/Extract", {
  payload: {
    file: Schema.String,
    documentClasses: Schema.Array(DocumentClass),
    targetFields: Schema.Array(Schema.String)
  },
  output: Extraction,
  seat,
  system: [extractorSystem],
  prompt: (input) =>
    `Extract target fields and tables from the document. Include missing fields and confidence.\n\nINPUT: ${
      JSON.stringify(input)
    }`
})

/** Checks the extractions against each other and the vendor master. */
export const Reconcile = AgentAction.make("examples/DocumentExceptionQueue/Reconcile", {
  payload: {
    extractions: Schema.Array(Extraction),
    documentClasses: Schema.Array(DocumentClass),
    vendorMaster: Schema.String,
    checks: Schema.Array(Schema.String)
  },
  output: Reconciliation,
  seat,
  system: [
    `You are a reconciliation analyst. Compare extracted fields across
documents and master data. Check totals, vendor identity, PO references, dates,
and policy rules. Return exceptions with severity.`
  ],
  prompt: (input) =>
    `Reconcile extractions across the document packet and master data. Return checks, pass/fail status, and exceptions.\n\nINPUT: ${
      JSON.stringify(input)
    }`
})

/** Re-extracts only what a failed reconciliation implicated. */
export const TargetedReextract = AgentAction.make("examples/DocumentExceptionQueue/TargetedReextract", {
  payload: {
    reconciliation: Reconciliation,
    extractions: Schema.Array(Extraction),
    files: Schema.Array(Schema.String)
  },
  output: Extraction,
  seat,
  system: [extractorSystem],
  prompt: (input) =>
    `Retry only the fields or documents implicated by reconciliation exceptions. Preserve prior good extractions.\n\nINPUT: ${
      JSON.stringify(input)
    }`
})

/** Writes the normalized record and the exception queue. */
export const Export = AgentAction.make("examples/DocumentExceptionQueue/Export", {
  payload: {
    extractions: Schema.Array(Extraction),
    reconciliation: Reconciliation,
    approval: Schema.NullOr(Approval),
    outputDir: Schema.String
  },
  output: ExportRecord,
  seat,
  system: [
    `You are a document operations exporter. Write normalized JSON and
exception queue files. Mark passThrough false when unresolved high-severity issues remain.`
  ],
  prompt: (input) =>
    `Export normalized JSON and an exception queue. Mark passThrough false when unresolved high-severity exceptions remain.\n\nINPUT: ${
      JSON.stringify(input)
    }`
})

type DocumentClass = typeof DocumentClass.Type
type Extraction = typeof Extraction.Type
type Reconciliation = typeof Reconciliation.Type

type Tags =
  | "examples/DocumentExceptionQueue/Classify"
  | "examples/DocumentExceptionQueue/Extract"
  | "examples/DocumentExceptionQueue/Reconcile"
  | "examples/DocumentExceptionQueue/TargetedReextract"
  | "examples/DocumentExceptionQueue/Export"

type Step = Node.Node<
  typeof ExportRecord.Type,
  AgentAction.AgentFailure | HumanTask.HumanTaskFailed | typeof ReviewDenied.Type,
  Action.Requirement<Tags>
>

/** What the steps after extraction read from the payload. */
interface Settings {
  readonly files: ReadonlyArray<string>
  readonly vendorMaster: string
  readonly checks: ReadonlyArray<string>
  readonly maxReconcileIterations: number
  readonly outputDir: string
}

/** 0.x's step id for a file. */
const nodeId = (file: string): string =>
  file.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "document"

/**
 * Runs one step per file, at most `concurrency` at a time, and collects the
 * results in file order.
 */
const perFile = <A, Tag extends Tags>(
  files: ReadonlyArray<string>,
  concurrency: number,
  step: (file: string) => Node.Node<A, AgentAction.AgentFailure, Action.Requirement<Tag>>,
  is: (value: unknown) => value is A
): Node.Node<ReadonlyArray<A>, AgentAction.AgentFailure, Action.Requirement<Tag>> => {
  if (files.length === 0) return Node.succeed([])
  const members = Object.fromEntries(files.map((file) => [nodeId(file), step(file)]))
  const joined = Bounded.all(members, { concurrency })
  return Node.map(joined, Node.capture({}, (byFile) => Object.keys(members).map((key) => byFile[key]).filter(is)))
}

/** Every extraction so far, plus the re-extraction. Pure, so it is a `Node.map`, not a step. */
const append = ({ again, prior }: { readonly prior: ReadonlyArray<Extraction>; readonly again: Extraction }) => [
  ...prior,
  again
]

/** The reviewer's prompt: 0.x's request title and summary. */
const reviewPrompt = ({ exceptions }: Reconciliation): string =>
  `Review document exception queue: ${
    exceptions.filter((exception) => exception.severity === "high").length
  } high-severity exception(s) require review.`

const exportRecord = (
  settings: Settings,
  extractions: Planned.Planned<ReadonlyArray<Extraction>>,
  reconciliation: Planned.Planned<Reconciliation>,
  approval: Planned.Planned<typeof Approval.Type> | null
): Step => Export.call({ extractions, reconciliation, approval, outputDir: settings.outputDir })

/** Asks a person only when the last reconciliation raised a high-severity exception, then exports. */
const review = (
  settings: Settings,
  extractions: Planned.Planned<ReadonlyArray<Extraction>>,
  reconciliation: Planned.Planned<Reconciliation>
): Step =>
  Node.branch(Node.succeed(reconciliation), {
    if: Node.capture({}, ({ exceptions }) => exceptions.some((exception) => exception.severity === "high")),
    then: Node.capture({ settings }, () =>
      Node.branch(
        Node.bindPlanned(
          Node.map(Node.succeed(reconciliation), reviewPrompt),
          Node.capture({}, (prompt: Planned.Planned<string>) =>
            HumanTask.action.call({ name: reviewTask, kind: "json", prompt, schema: approvalSchema }).pipe(
              HumanTask.decode(Approval)
            ))
        ),
        {
          if: Node.capture({}, (approval) => approval.approved),
          then: Node.capture({ settings }, (approval) =>
            exportRecord(settings, extractions, reconciliation, approval)),
          else: Node.capture({}, (approval) =>
            Node.fail({
              _tag: "examples/DocumentExceptionQueue/ReviewDenied" as const,
              reviewer: approval.reviewer,
              note: approval.note
            }))
        }
      )),
    else: Node.capture({ settings }, () => exportRecord(settings, extractions, reconciliation, null))
  })

/**
 * Reconciliation round `round`: a pass goes on to review; a failure
 * re-extracts, adds that extraction to the rest, and checks again until the
 * last planned round, which goes on to review with its failing verdict.
 */
const reconcile = (
  settings: Settings,
  documentClasses: Planned.Planned<ReadonlyArray<DocumentClass>>,
  extractions: Planned.Planned<ReadonlyArray<Extraction>>,
  round: number
): Step =>
  Node.branch(
    Reconcile.call({ extractions, documentClasses, vendorMaster: settings.vendorMaster, checks: settings.checks }),
    {
      if: Node.capture({}, (reconciliation) => reconciliation.passed),
      then: Node.capture({ settings }, (reconciliation) => review(settings, extractions, reconciliation)),
      else: Node.capture({ settings, round }, (reconciliation) =>
        Node.bindPlanned(
          TargetedReextract.call({ reconciliation, extractions, files: settings.files }),
          Node.capture({ settings, round }, (again: Planned.Planned<Extraction>) =>
            Node.bindPlanned(
              Node.map(Node.succeed({ prior: extractions, again }), append),
              Node.capture({ settings, round }, (all: Planned.Planned<ReadonlyArray<Extraction>>) =>
                round >= settings.maxReconcileIterations
                  ? review(settings, all, reconciliation)
                  : reconcile(settings, documentClasses, all, round + 1))
            ))
        ))
    }
  )

const Bound = Schema.Int.check(Schema.isGreaterThan(0))

/** The flow: classify, extract, reconcile, review the exceptions, export. */
export const DocumentExceptionQueue = Flow.make("examples/DocumentExceptionQueue", {
  payload: {
    files: Schema.optional(Schema.Array(Schema.String)),
    packetContext: Schema.optional(Schema.String),
    targetFields: Schema.optional(Schema.Array(Schema.String)),
    vendorMaster: Schema.optional(Schema.String),
    checks: Schema.optional(Schema.Array(Schema.String)),
    outputDir: Schema.optional(Schema.String),
    maxConcurrency: Schema.optional(Bound),
    maxReconcileIterations: Schema.optional(Bound)
  },
  success: ExportRecord,
  error: Schema.Union([AgentAction.AgentFailure, HumanTask.HumanTaskFailed, ReviewDenied]),
  body: Node.capture({}, ({
    checks = defaultChecks,
    files = defaultFiles,
    maxConcurrency = 8,
    maxReconcileIterations = 2,
    outputDir = "artifacts/document-exception-queue",
    packetContext = "",
    targetFields = defaultTargetFields,
    vendorMaster = "fixtures/document-exception-queue/vendor-master.json"
  }) => {
    const settings: Settings = { files, vendorMaster, checks, maxReconcileIterations, outputDir }
    return Node.bindPlanned(
      perFile(
        files,
        maxConcurrency,
        Node.capture({ packetContext }, (file) => Classify.call({ file, packetContext })),
        Schema.is(DocumentClass)
      ),
      Node.capture(
        { settings, maxConcurrency, targetFields },
        (documentClasses: Planned.Planned<ReadonlyArray<DocumentClass>>) =>
          Node.bindPlanned(
            perFile(
              files,
              maxConcurrency,
              Node.capture({ targetFields }, (file) => Extract.call({ file, documentClasses, targetFields })),
              Schema.is(Extraction)
            ),
            Node.capture(
              { settings },
              (extractions: Planned.Planned<ReadonlyArray<Extraction>>) =>
                reconcile(settings, documentClasses, extractions, 1)
            )
          )
      )
    )
  })
})

/** Every step the flow calls, and the human task it asks. */
export const layer = Layer.mergeAll(
  Classify.layer,
  Extract.layer,
  Reconcile.layer,
  TargetedReextract.layer,
  Export.layer
)
