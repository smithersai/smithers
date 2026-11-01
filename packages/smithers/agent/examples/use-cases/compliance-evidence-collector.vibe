/**
 * Plan the evidence a compliance framework needs, fetch and normalize it in parallel, and assemble a review packet.
 *
 * Port of the 0.x `compliance-evidence-collector.jsx`. A planning agent lists
 * the controls in scope and the sources to query for each. A fetcher agent
 * collects raw evidence from every control and source pair, at most
 * `maxConcurrency` (default 5) at a time with a `timeoutMs` (default 60 s)
 * bound each, and a failed fetch drops only its own evidence. Once every fetch
 * has settled, a normalizer agent extracts a finding from each evidence item
 * at the same bound, and a packet agent assembles per-control verdicts.
 *
 * 0.x re-rendered its tree once the plan and then the evidence landed; here each fan-out runs in a `.child()` flow whose body plans over the real list.
 * `MapReduce` does not fit: its reducer sees only the shards and their results, not the framework and plan the packet reads, and 0.x normalizes only after every fetch has settled.
 * 0.x gave the agents `read`, `write`, `bash` and `grep` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Flow, Interpreter } from "@smthrs/flow"
import * as Bounded from "@smthrs/patterns/Bounded"
import { Node } from "@smthrs/plan"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

const Method = Schema.Literals(["api", "mcp", "browser"])

const Positive = Schema.Int.check(Schema.isGreaterThan(0))

/** One control in scope and the sources that evidence it. */
export const PlannedControl = Schema.Struct({
  controlId: Schema.String,
  description: Schema.String,
  sources: Schema.Array(Schema.Struct({
    sourceId: Schema.String,
    endpoint: Schema.String,
    preferredMethod: Method
  }))
})

/** The collection plan. */
export const Plan = Schema.Struct({
  controls: Schema.Array(PlannedControl),
  totalSources: Schema.Number
})

/** Raw evidence from one source for one control. */
export const EvidenceItem = Schema.Struct({
  sourceId: Schema.String,
  controlId: Schema.String,
  title: Schema.String,
  rawPayload: Schema.String,
  fetchedAt: Schema.String,
  method: Method,
  status: Schema.Literals(["collected", "partial", "failed"])
})

/** One structured finding. */
export const Normalized = Schema.Struct({
  controlId: Schema.String,
  sourceId: Schema.String,
  finding: Schema.String,
  compliant: Schema.Boolean,
  severity: Schema.optional(Schema.Literals(["info", "low", "medium", "high", "critical"])),
  extractedFields: Schema.optional(Schema.Record(Schema.String, Schema.String))
})

/** The review packet the flow settles with. */
export const Packet = Schema.Struct({
  framework: Schema.String,
  generatedAt: Schema.String,
  controlCount: Schema.Number,
  compliantCount: Schema.Number,
  nonCompliantCount: Schema.Number,
  findings: Schema.Array(Schema.Struct({
    controlId: Schema.String,
    status: Schema.Literals(["compliant", "non-compliant", "insufficient-evidence"]),
    evidence: Schema.Array(Schema.String),
    recommendation: Schema.optional(Schema.String)
  })),
  summary: Schema.String
})

type EvidenceItem = typeof EvidenceItem.Type
type Normalized = typeof Normalized.Type

/** Plans which controls and sources to collect. */
export const PlanCollection = AgentAction.make("examples/ComplianceEvidenceCollector/Plan", {
  payload: { framework: Schema.String, scope: Schema.optional(Schema.Json), controls: Schema.optional(Schema.Json) },
  output: Plan,
  seat,
  system: [
    `You are a compliance planning agent. Given a compliance framework and scope,
identify the controls that need evidence and plan which sources to query for each.`
  ],
  prompt: ({ controls, framework, scope }) =>
    `Plan the evidence collection for ${framework}.\n\nScope: ${JSON.stringify(scope ?? null)}\nControls: ${
      JSON.stringify(controls ?? null)
    }`
})

/** Collects raw evidence from one source. */
export const Fetch = AgentAction.make("examples/ComplianceEvidenceCollector/Fetch", {
  payload: {
    controlId: Schema.String,
    sourceId: Schema.String,
    endpoint: Schema.String,
    method: Method,
    timeoutMs: Positive
  },
  output: EvidenceItem,
  seat,
  timeout: ({ timeoutMs }) => timeoutMs,
  system: [
    `You are an evidence fetcher. Collect raw evidence from the assigned source
using the preferred method (API call, MCP tool, or browser fallback). Return the raw payload.`
  ],
  prompt: ({ controlId, endpoint, method, sourceId }) =>
    `Fetch evidence for control ${controlId} from source ${sourceId} by ${method}.\n\nEndpoint: ${endpoint}`
})

/** Extracts a finding from one evidence item. */
export const Normalize = AgentAction.make("examples/ComplianceEvidenceCollector/Normalize", {
  payload: { controlId: Schema.String, sourceId: Schema.String, rawPayload: Schema.String, method: Method },
  output: Normalized,
  seat,
  system: [
    `You are an evidence normalizer. Take raw evidence payloads and extract
structured findings: compliance status, severity, and key fields.`
  ],
  prompt: ({ controlId, method, rawPayload, sourceId }) =>
    `Normalize the evidence for control ${controlId} from source ${sourceId} (fetched by ${method}).\n\nRaw payload: ${
      JSON.stringify(rawPayload)
    }`
})

/** Assembles the review packet. */
export const AssemblePacket = AgentAction.make("examples/ComplianceEvidenceCollector/Packet", {
  payload: { framework: Schema.String, findings: Schema.Array(Normalized), controls: Schema.Array(PlannedControl) },
  output: Packet,
  seat,
  system: [
    `You are a compliance packet assembler. Aggregate normalized findings into
a final review packet with per-control verdicts, evidence references, and recommendations.`
  ],
  prompt: ({ controls, findings, framework }) =>
    `Assemble the ${framework} review packet.\n\nControls: ${JSON.stringify(controls)}\nFindings: ${
      JSON.stringify(findings)
    }`
})

/**
 * Fetches every control and source pair in the plan. It runs as a child
 * execution, so its payload is the real plan when its body plans the fan-out.
 */
export const FetchEvidence = Flow.make("examples/ComplianceEvidenceCollector/FetchEvidence", {
  payload: { controls: Schema.Array(PlannedControl), concurrency: Positive, timeoutMs: Positive },
  success: Schema.Array(EvidenceItem),
  body: ({ concurrency, controls, timeoutMs }) => {
    // 0.x `continueOnFail`: a failed fetch settles as null instead of failing its siblings.
    const members = Object.fromEntries(controls.flatMap((control) =>
      control.sources.map((source) => [
        `fetch-${control.controlId}-${source.sourceId}`,
        Node.catch(
          Fetch.call({
            controlId: control.controlId,
            sourceId: source.sourceId,
            endpoint: source.endpoint,
            method: source.preferredMethod,
            timeoutMs
          }),
          { onFailure: () => Node.succeed(null) }
        )
      ])
    ))
    if (Object.keys(members).length === 0) return Node.succeed([])
    const joined = Bounded.all(members, { concurrency })
    return Node.map(joined, (fetched) => Object.values(fetched).filter(Schema.is(EvidenceItem)))
  }
})

/** Normalizes every collected evidence item, once all of them are in. */
export const NormalizeEvidence = Flow.make("examples/ComplianceEvidenceCollector/NormalizeEvidence", {
  payload: { evidence: Schema.Array(EvidenceItem), concurrency: Positive },
  success: Schema.Array(Normalized),
  error: AgentAction.AgentFailure,
  body: ({ concurrency, evidence }) => {
    if (evidence.length === 0) return Node.succeed([])
    const members = Object.fromEntries(evidence.map((item: EvidenceItem) => [
      `normalize-${item.controlId}-${item.sourceId}`,
      Normalize.call({
        controlId: item.controlId,
        sourceId: item.sourceId,
        rawPayload: item.rawPayload,
        method: item.method
      })
    ]))
    const joined = Bounded.all(members, { concurrency })
    return Node.map(
      joined,
      (normalized): ReadonlyArray<Normalized> => Object.values(normalized).filter(Schema.is(Normalized))
    )
  }
})

/** The flow: plan, fetch, normalize, assemble. */
export const ComplianceEvidenceCollector = Flow.make("examples/ComplianceEvidenceCollector", {
  payload: {
    framework: Schema.optional(Schema.String),
    scope: Schema.optional(Schema.Json),
    controls: Schema.optional(Schema.Json),
    maxConcurrency: Schema.optional(Positive),
    timeoutMs: Schema.optional(Positive)
  },
  success: Packet,
  error: AgentAction.AgentFailure,
  body: ({ controls, framework = "SOC2", maxConcurrency = 5, scope, timeoutMs = 60_000 }) =>
    Node.bindPlanned(PlanCollection.call({ framework, scope, controls }), (plan) =>
      Node.bindPlanned(
        FetchEvidence.child({ controls: plan.controls, concurrency: maxConcurrency, timeoutMs }),
        (evidence) =>
          Node.bindPlanned(
            NormalizeEvidence.child({ evidence, concurrency: maxConcurrency }),
            (findings) => AssemblePacket.call({ framework, findings, controls: plan.controls })
          )
      ))
})

/** Every step the flow calls, and the child flows it starts. */
export const layer = Layer.mergeAll(
  PlanCollection.layer,
  Fetch.layer,
  Normalize.layer,
  AssemblePacket.layer,
  Interpreter.layer(FetchEvidence),
  Interpreter.layer(NormalizeEvidence)
)
