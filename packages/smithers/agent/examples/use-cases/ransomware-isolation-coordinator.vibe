/**
 * Detect ransomware on a host, isolate it behind an operator approval, and report the incident.
 *
 * Port of the 0.x `ransomware-isolation-coordinator.jsx`. A detector agent
 * reads the host's telemetry and recommends isolation or not. When it does, an
 * operator is asked to approve; on approval a containment agent isolates the
 * host, snapshots evidence, and notifies the response channels, and a denial
 * ends the run. A reporting agent then writes the incident report, with no
 * containment data when isolation was not recommended.
 *
 * 0.x's `<Approval>` is a `HumanTask` JSON question decoded to the same approval schema, so containment reads the approver as 0.x's did.
 * 0.x's `<Approval>` failed the run on denial (its default `onDeny`), so its `approval?.approved` check never saw `false`; a denial here ends the run with `ContainmentDenied`.
 * `Runbook` does not fit: its approval answers only "approved", while 0.x hands the approver's name to containment, and isolation is gated on the detector's recommendation.
 * 0.x gave the agents a `bash` tool; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { type Action, Flow, HumanTask } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

const Severity = Schema.Literals(["low", "medium", "high", "critical"])

/** The detector's assessment. */
export const Detection = Schema.Struct({
  hostId: Schema.String,
  indicators: Schema.Array(Schema.String),
  severity: Severity,
  isolateRecommended: Schema.Boolean
})

/** What containment did. */
export const Containment = Schema.Struct({
  hostId: Schema.String,
  networkIsolated: Schema.Boolean,
  evidenceSnapshotUrl: Schema.String,
  notifiedChannels: Schema.Array(Schema.String)
})

/** The operator's decision. */
export const Approval = Schema.Struct({
  approved: Schema.Boolean,
  approvedBy: Schema.String,
  note: Schema.String
})

/** The incident report the flow settles with. */
export const Report = Schema.Struct({
  incidentId: Schema.String,
  timeline: Schema.Array(Schema.String),
  containmentStatus: Schema.Literals(["contained", "monitoring", "escalated"]),
  summary: Schema.String
})

/** The operator denied isolating the host. */
export const ContainmentDenied = Schema.TaggedStruct("examples/RansomwareIsolationCoordinator/ContainmentDenied", {
  hostId: Schema.String,
  deniedBy: Schema.String,
  note: Schema.String
})

/** The name the approval question is asked and answered under (0.x's node id). */
export const approvalTask = "approve-containment"

/** {@link Approval} as the JSON Schema a `HumanTask` checks an answer against. */
const approvalSchema = {
  type: "object",
  properties: { approved: { type: "boolean" }, approvedBy: { type: "string" }, note: { type: "string" } },
  required: ["approved", "approvedBy", "note"]
}

/** Looks for ransomware on the host. */
export const Detect = AgentAction.make("examples/RansomwareIsolationCoordinator/Detect", {
  payload: { host: Schema.String, evidence: Schema.Array(Schema.Json) },
  output: Detection,
  seat,
  timeout: 60_000,
  system: [
    `You are a ransomware detection specialist. Analyse host telemetry,
EDR alerts, and file-system signals to determine if ransomware activity is present.
Return structured indicators and a severity assessment.`
  ],
  prompt: ({ evidence, host }) => `Check host ${host} for ransomware activity.\n\nEvidence: ${JSON.stringify(evidence)}`
})

/** Isolates the host, captures evidence, and notifies responders. */
export const Contain = AgentAction.make("examples/RansomwareIsolationCoordinator/Contain", {
  payload: { hostId: Schema.String, severity: Severity, approvedBy: Schema.String },
  output: Containment,
  seat,
  timeout: 120_000,
  system: [
    `You are a containment operator. When directed, isolate the target host
from the network, capture a forensic evidence snapshot, and notify the appropriate
incident-response channels. Use the provided tools to execute each step.`
  ],
  prompt: ({ approvedBy, hostId, severity }) =>
    `Contain host ${hostId} (severity ${severity}). Isolation was approved by ${approvedBy}.`
})

/** Writes the incident report. */
export const WriteReport = AgentAction.make("examples/RansomwareIsolationCoordinator/Report", {
  payload: {
    hostId: Schema.String,
    indicators: Schema.Array(Schema.String),
    severity: Severity,
    contained: Schema.Boolean,
    evidenceUrl: Schema.String,
    notifiedChannels: Schema.Array(Schema.String)
  },
  output: Report,
  seat,
  timeout: 60_000,
  system: [
    `You are an incident reporter. Compile all detection and containment
data into a concise incident report with a timeline, containment status, and summary.`
  ],
  prompt: ({ hostId, ...incident }) =>
    `Report the ransomware incident on ${hostId}.\n\nIncident: ${JSON.stringify(incident)}`
})

type Detection = typeof Detection.Type

// `HumanTask` is a system action: its call adds no requirement, but `layer` still registers it.
type Requirements = Action.Requirement<`examples/RansomwareIsolationCoordinator/${"Detect" | "Contain" | "Report"}`>

type Failure = AgentAction.AgentFailure | HumanTask.HumanTaskFailed | typeof ContainmentDenied.Type

/** 0.x's approval request title and summary, as one question. */
const question = (detection: Pick<Detection, "hostId" | "severity" | "indicators">): string =>
  `Isolate host ${detection.hostId}\n\nSeverity: ${detection.severity}. Indicators: ${detection.indicators.join(", ")}`

/** Asks the operator, and settles with their typed decision. */
const approve = (detection: Planned.Planned<Detection>) =>
  Node.bindPlanned(
    Node.map(
      Node.succeed({ hostId: detection.hostId, severity: detection.severity, indicators: detection.indicators }),
      question
    ),
    Node.capture({}, (prompt: Planned.Planned<string>) =>
      HumanTask.action.call({ name: approvalTask, kind: "json", prompt, schema: approvalSchema }).pipe(
        HumanTask.decode(Approval)
      ))
  )

/** Approve, contain, report; or fail on a denial. */
const isolate = (detection: Planned.Planned<Detection>): Node.Node<typeof Report.Type, Failure, Requirements> =>
  Node.branch(approve(detection), {
    if: Node.capture({}, (approval) => approval.approved),
    then: Node.capture({}, (approval) =>
      Node.bindPlanned(
        Contain.call({ hostId: detection.hostId, severity: detection.severity, approvedBy: approval.approvedBy }),
        Node.capture({}, (containment) =>
          WriteReport.call({
            hostId: detection.hostId,
            indicators: detection.indicators,
            severity: detection.severity,
            contained: containment.networkIsolated,
            evidenceUrl: containment.evidenceSnapshotUrl,
            notifiedChannels: containment.notifiedChannels
          }))
      )),
    else: Node.capture({}, (approval) =>
      Node.fail({
        _tag: "examples/RansomwareIsolationCoordinator/ContainmentDenied" as const,
        hostId: detection.hostId,
        deniedBy: approval.approvedBy,
        note: approval.note
      }))
  })

/** The flow: detect, then isolate behind approval or report as is. */
export const RansomwareIsolationCoordinator = Flow.make("examples/RansomwareIsolationCoordinator", {
  payload: { host: Schema.optional(Schema.String), evidence: Schema.optional(Schema.Array(Schema.Json)) },
  success: Report,
  error: Schema.Union([AgentAction.AgentFailure, HumanTask.HumanTaskFailed, ContainmentDenied]),
  body: Node.capture({}, ({ evidence = [], host = "unknown" }) =>
    Node.branch(Detect.call({ host, evidence }), {
      if: Node.capture({}, (detection) => detection.isolateRecommended),
      then: isolate,
      else: Node.capture({}, (detection) =>
        WriteReport.call({
          hostId: detection.hostId,
          indicators: detection.indicators,
          severity: detection.severity,
          contained: false,
          evidenceUrl: "N/A",
          notifiedChannels: []
        }))
    }))
})

/** The flow's action implementations; the interpreter supplies approvals. */
export const layer = Layer.mergeAll(Detect.layer, Contain.layer, WriteReport.layer)
