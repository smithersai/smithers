/**
 * Group recurring errors into clusters and keep a remediation knowledge base current.
 *
 * Port of the 0.x `error-clusterer.jsx`. An ingester agent reads errors from
 * the given sources and fingerprints each one; the flow groups them by
 * fingerprint, largest cluster first; an explainer agent gives each cluster a
 * root cause, remediation and severity; and an updater agent writes them to
 * the knowledge base and returns the remediation table. The steps run in
 * sequence, and any failure fails the run.
 *
 * 0.x's knowledge base is files the updater writes under `kbPath`, and so is this port's; it does not move them into `@smthrs/memory` facts.
 * 0.x's prompts were placeholders that dumped their props; these are minimal prompts over the same props.
 * 0.x gave the agents `bash`, `read`, `grep` and `write` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

const Source = Schema.Literals(["ci", "api", "runtime"])

/** One normalized error. */
export const ErrorEntry = Schema.Struct({
  id: Schema.String,
  source: Source,
  message: Schema.String,
  stackTrace: Schema.optional(Schema.String),
  timestamp: Schema.String,
  fingerprint: Schema.String.annotate({ description: "Normalized signature for dedup grouping" })
})

/** What the ingester read. */
export const Ingested = Schema.Struct({
  errors: Schema.Array(ErrorEntry),
  totalIngested: Schema.Number,
  sources: Schema.Record(Source, Schema.Number)
})

/** Every error sharing one fingerprint. */
export const Cluster = Schema.Struct({
  clusterId: Schema.String,
  fingerprint: Schema.String,
  representative: Schema.String.annotate({ description: "Representative error message for the cluster" }),
  count: Schema.Number,
  source: Source,
  errorIds: Schema.Array(Schema.String),
  firstSeen: Schema.String,
  lastSeen: Schema.String
})

/** The clusters, largest first. */
export const Clusters = Schema.Struct({
  clusters: Schema.Array(Cluster),
  totalClusters: Schema.Number,
  largestClusterSize: Schema.Number
})

/** The explainer's analysis of every cluster. */
export const Explanations = Schema.Struct({
  explanations: Schema.Array(Schema.Struct({
    clusterId: Schema.String,
    fingerprint: Schema.String,
    rootCause: Schema.String,
    remediation: Schema.String,
    severity: Schema.Literals(["critical", "high", "medium", "low"]),
    relatedDocs: Schema.optional(Schema.Array(Schema.String)),
    suggestedOwner: Schema.optional(Schema.String)
  })),
  summary: Schema.String
})

/** What the updater wrote, and the remediation table the flow settles with. */
export const KbUpdate = Schema.Struct({
  entriesWritten: Schema.Number,
  ticketsCreated: Schema.Array(Schema.String),
  kbPath: Schema.String,
  remediationTable: Schema.Array(Schema.Struct({
    fingerprint: Schema.String,
    rootCause: Schema.String,
    remediation: Schema.String,
    severity: Schema.String,
    occurrences: Schema.Number
  })),
  summary: Schema.String
})

/** Reads and fingerprints the errors. */
export const Ingest = AgentAction.make("examples/ErrorClusterer/Ingest", {
  payload: { sources: Schema.Array(Source), logPaths: Schema.Array(Schema.String), since: Schema.String },
  output: Ingested,
  seat,
  system: [
    `You are an error ingester. Read error logs from the provided sources
(CI logs, API error endpoints, runtime crash reports). Normalize each error into a
canonical form with a stable fingerprint derived from the error message and stack trace.
Strip variable parts (timestamps, request IDs, line numbers) to produce consistent signatures.`
  ],
  prompt: ({ logPaths, since, sources }) =>
    `Ingest the errors from these sources.\n\nSources: ${JSON.stringify(sources)}\nLog paths: ${
      JSON.stringify(logPaths)
    }\nSince: ${since}`
})

/** Explains every cluster. */
export const Explain = AgentAction.make("examples/ErrorClusterer/Explain", {
  payload: { clusters: Schema.Array(Cluster), totalClusters: Schema.Number, kbPath: Schema.String },
  output: Explanations,
  seat,
  system: [
    `You are an error analyst. For each error cluster, determine the root cause,
suggest a remediation, and assign a severity. Reference existing documentation or runbooks
when available. Be specific and actionable — vague advice like "check the logs" is not helpful.`
  ],
  prompt: ({ clusters, kbPath, totalClusters }) =>
    `Explain these ${totalClusters} error clusters.\n\nKnowledge base: ${kbPath}\nClusters: ${JSON.stringify(clusters)}`
})

/** Writes the explanations to the knowledge base and opens tickets. */
export const Update = AgentAction.make("examples/ErrorClusterer/Update", {
  payload: {
    explanations: Explanations.fields.explanations,
    kbPath: Schema.String,
    ticketPrefix: Schema.String,
    clusters: Schema.Array(Cluster)
  },
  output: KbUpdate,
  seat,
  system: [
    `You are a knowledge base maintainer. Write error explanations and remediation
steps to the configured KB path as structured entries. Create ticket stubs for critical/high
severity clusters that lack existing tickets. Output a searchable remediation table.`
  ],
  prompt: ({ clusters, explanations, kbPath, ticketPrefix }) =>
    `Update the knowledge base at ${kbPath}.\n\nTicket prefix: ${ticketPrefix}\nExplanations: ${
      JSON.stringify(explanations)
    }\nClusters: ${JSON.stringify(clusters)}`
})

type Ingested = typeof Ingested.Type
type Cluster = typeof Cluster.Type
type Clusters = typeof Clusters.Type

/**
 * Groups the errors by fingerprint, as 0.x did: ids in order of first
 * appearance, the first error's message and source, `lastSeen` from the last
 * error listed, largest cluster first. Pure, so it is a `Node.map`, not a step.
 */
const cluster = ({ errors }: Ingested): Clusters => {
  const byFingerprint = new Map<string, { -readonly [K in keyof Cluster]: Cluster[K] }>()
  for (const err of errors) {
    let found = byFingerprint.get(err.fingerprint)
    if (found === undefined) {
      found = {
        clusterId: `cluster-${byFingerprint.size + 1}`,
        fingerprint: err.fingerprint,
        representative: err.message,
        count: 0,
        source: err.source,
        errorIds: [],
        firstSeen: err.timestamp,
        lastSeen: err.timestamp
      }
      byFingerprint.set(err.fingerprint, found)
    }
    found.count += 1
    found.errorIds = [...found.errorIds, err.id]
    found.lastSeen = err.timestamp
  }
  const clusters = [...byFingerprint.values()].sort((a, b) => b.count - a.count)
  return {
    clusters,
    totalClusters: clusters.length,
    largestClusterSize: Math.max(0, ...clusters.map((c) => c.count))
  }
}

/** The flow: ingest, cluster, explain, update the knowledge base. */
export const ErrorClusterer = Flow.make("examples/ErrorClusterer", {
  payload: {
    sources: Schema.optional(Schema.Array(Source)),
    logPaths: Schema.optional(Schema.Array(Schema.String)),
    since: Schema.optional(Schema.String),
    kbPath: Schema.optional(Schema.String),
    ticketPrefix: Schema.optional(Schema.String)
  },
  success: KbUpdate,
  error: AgentAction.AgentFailure,
  body: ({ kbPath = "./error-kb", logPaths = [], since = "24h", sources = ["ci" as const], ticketPrefix = "ERR" }) =>
    Node.bindPlanned(
      Node.map(Ingest.call({ sources, logPaths, since }), cluster),
      (clustered: Planned.Planned<Clusters>) =>
        Node.bindPlanned(
          Explain.call({ clusters: clustered.clusters, totalClusters: clustered.totalClusters, kbPath }),
          (explained: Planned.Planned<typeof Explanations.Type>) =>
            Update.call({ explanations: explained.explanations, kbPath, ticketPrefix, clusters: clustered.clusters })
        )
    )
})

/** Every step the flow calls. */
export const layer = Layer.mergeAll(Ingest.layer, Explain.layer, Update.layer)
