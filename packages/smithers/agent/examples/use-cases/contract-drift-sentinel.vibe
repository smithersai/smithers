/**
 * Diff two revisions of an API contract, flag breaking changes with consumer impact, and gate the PR.
 *
 * Port of the 0.x `contract-drift-sentinel.jsx`. A loader agent reads the
 * baseline and current contract and detects its format, a diff agent compares
 * them structurally, and an analyst agent separates breaking from safe changes,
 * names the affected consumers, and scores the risk from 0 to 100. The status
 * is computed from that score (70 or more blocks, 30 or more warns, anything
 * lower approves) and an output step writes the PR comment. No step branches.
 *
 * `DriftDetector` does not fit: it compares against a baseline declared in the plan and acts only on drift, while 0.x loads the baseline at run time and always analyzes.
 * 0.x gave `output` no agent, so it persisted its prompt element as a static output that fails its schema; here it is a model step with no system prompt.
 * 0.x gave the agents `read`, `bash` and `grep` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

const Format = Schema.Literals(["openapi", "jsonschema", "graphql", "protobuf"])

/** Both revisions of the contract. */
export const SchemaSnapshot = Schema.Struct({
  format: Format,
  version: Schema.String,
  baseline: Schema.String.annotate({ description: "Serialized content of the previous contract revision" }),
  current: Schema.String.annotate({ description: "Serialized content of the incoming contract revision" }),
  entities: Schema.Array(Schema.String).annotate({ description: "Top-level type/message/endpoint names found" })
})

/** The structural diff. */
export const DiffResult = Schema.Struct({
  additions: Schema.Array(Schema.Struct({ path: Schema.String, description: Schema.String })),
  removals: Schema.Array(Schema.Struct({ path: Schema.String, description: Schema.String })),
  modifications: Schema.Array(Schema.Struct({
    path: Schema.String,
    before: Schema.String,
    after: Schema.String,
    description: Schema.String
  })),
  breakingCandidates: Schema.Array(Schema.String).annotate({ description: "Paths likely to break existing consumers" }),
  totalChanges: Schema.Number
})

/** The analyst's compatibility verdict. */
export const Analysis = Schema.Struct({
  breakingChanges: Schema.Array(Schema.Struct({
    path: Schema.String,
    severity: Schema.Literals(["critical", "high", "medium"]),
    reason: Schema.String,
    affectedConsumers: Schema.Array(Schema.String),
    migrationHint: Schema.String
  })),
  safeChanges: Schema.Array(Schema.Struct({
    path: Schema.String,
    kind: Schema.Literals(["addition", "deprecation-with-replacement", "documentation", "optional-field"])
  })),
  riskScore: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  summary: Schema.String
})

const Status = Schema.Literals(["approve", "block", "warn"])

/** The PR status and comment the flow settles with. */
export const Output = Schema.Struct({
  status: Status,
  prComment: Schema.String,
  breakingCount: Schema.Number,
  riskScore: Schema.Number,
  summary: Schema.String
})

/** Reads both revisions and detects the format. */
export const Load = AgentAction.make("examples/ContractDriftSentinel/Load", {
  payload: { baselinePath: Schema.String, currentPath: Schema.String, format: Schema.String },
  output: SchemaSnapshot,
  seat,
  system: [
    `You are a schema loader. Read the baseline and current contract files from the
provided paths. Detect the schema format (OpenAPI, JSON Schema, GraphQL SDL, or protobuf) by
inspecting file contents. Extract top-level entity names (endpoints, types, messages). Return the
raw content for both revisions so downstream tasks can diff them.`
  ],
  prompt: ({ baselinePath, currentPath, format }) =>
    `Load both contract revisions (format: ${format}).\n\nBaseline path: ${baselinePath}\nCurrent path: ${currentPath}`
})

/** Diffs the two revisions structurally. */
export const Diff = AgentAction.make("examples/ContractDriftSentinel/Diff", {
  payload: { format: Format, baseline: Schema.String, current: Schema.String, entities: Schema.Array(Schema.String) },
  output: DiffResult,
  seat,
  system: [
    `You are a contract diff engine. Compare the baseline and current schema snapshots
structurally — not just textually. Identify additions, removals, and modifications at the
field/endpoint/message level. Flag any removal, type narrowing, or required-field addition as a
breaking candidate. Be precise about paths (e.g. "POST /users response.body.phone").`
  ],
  prompt: ({ baseline, current, entities, format }) =>
    `Diff these ${format} contract revisions.\n\nEntities: ${JSON.stringify(entities)}\nBaseline: ${
      JSON.stringify(baseline)
    }\nCurrent: ${JSON.stringify(current)}`
})

/** Separates breaking from safe changes and scores the risk. */
export const Analyze = AgentAction.make("examples/ContractDriftSentinel/Analyze", {
  payload: { diff: DiffResult, consumers: Schema.Array(Schema.String), format: Format },
  output: Analysis,
  seat,
  system: [
    `You are a contract compatibility analyst. Examine the structural diff and
determine which changes are truly breaking versus safely additive. For each breaking change,
identify which consumers are likely affected (from the consumer list provided) and suggest a
concrete migration path. Produce a risk score from 0-100.`
  ],
  prompt: ({ consumers, diff, format }) =>
    `Analyze this ${format} contract diff for breaking changes.\n\nConsumers: ${JSON.stringify(consumers)}\nDiff: ${
      JSON.stringify(diff)
    }`
})

/** Writes the PR comment for the computed status. */
export const WriteOutput = AgentAction.make("examples/ContractDriftSentinel/Output", {
  payload: {
    status: Status,
    breakingCount: Schema.Number,
    riskScore: Schema.Number,
    breakingChanges: Analysis.fields.breakingChanges,
    safeChanges: Analysis.fields.safeChanges,
    summary: Schema.String
  },
  output: Output,
  seat,
  prompt: ({ breakingChanges, breakingCount, riskScore, safeChanges, status, summary }) =>
    `Write the PR comment and status for this contract change.\n\nStatus: ${status}\nRisk score: ${riskScore}\nBreaking count: ${breakingCount}\nBreaking changes: ${
      JSON.stringify(breakingChanges)
    }\nSafe changes: ${JSON.stringify(safeChanges)}\nSummary: ${summary}`
})

/** The PR status a risk score earns. */
export const statusOf = (riskScore: number): typeof Status.Type =>
  riskScore >= 70 ? "block" : riskScore >= 30 ? "warn" : "approve"

/** The output step's payload, computed from the analysis. Pure, so it is a `Node.map`. */
const gate = (analysis: typeof Analysis.Type) => ({
  status: statusOf(analysis.riskScore),
  breakingCount: analysis.breakingChanges.length,
  riskScore: analysis.riskScore,
  breakingChanges: analysis.breakingChanges,
  safeChanges: analysis.safeChanges,
  summary: analysis.summary
})

/** The flow: load, diff, analyze, gate. */
export const ContractDriftSentinel = Flow.make("examples/ContractDriftSentinel", {
  payload: {
    baselinePath: Schema.String,
    currentPath: Schema.String,
    format: Schema.optional(Schema.String),
    consumers: Schema.optional(Schema.Array(Schema.String))
  },
  success: Output,
  error: AgentAction.AgentFailure,
  body: ({ baselinePath, consumers = [], currentPath, format = "auto" }) =>
    Node.bindPlanned(Load.call({ baselinePath, currentPath, format }), (snapshot) =>
      Node.bindPlanned(
        Diff.call({
          format: snapshot.format,
          baseline: snapshot.baseline,
          current: snapshot.current,
          entities: snapshot.entities
        }),
        (diff) =>
          Node.bindPlanned(
            Node.map(Analyze.call({ diff, consumers, format: snapshot.format }), gate),
            (gated) =>
              WriteOutput.call({
                status: gated.status,
                breakingCount: gated.breakingCount,
                riskScore: gated.riskScore,
                breakingChanges: gated.breakingChanges,
                safeChanges: gated.safeChanges,
                summary: gated.summary
              })
          )
      ))
})

/** Every step the flow calls. */
export const layer = Layer.mergeAll(Load.layer, Diff.layer, Analyze.layer, WriteOutput.layer)
