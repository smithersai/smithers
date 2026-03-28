// @ts-nocheck
/**
 * <ErrorClusterer> — Group recurring CI/API/runtime errors into clusters and
 * maintain a searchable explanation set or remediation table.
 *
 * Pattern: error ingester → clusterer → explainer agent → KB/ticket update.
 * Use cases: incident dedup, error triage dashboards, runbook linking, SRE knowledge bases.
 */
import { createSmithers, Sequence } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { bash, read, write, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import IngestPrompt from "./prompts/error-clusterer/ingest.mdx";
import ClusterPrompt from "./prompts/error-clusterer/cluster.mdx";
import ExplainPrompt from "./prompts/error-clusterer/explain.mdx";
import UpdatePrompt from "./prompts/error-clusterer/update.mdx";

const errorEntrySchema = z.object({
  id: z.string(),
  source: z.enum(["ci", "api", "runtime"]),
  message: z.string(),
  stackTrace: z.string().optional(),
  timestamp: z.string(),
  fingerprint: z.string().describe("Normalized signature for dedup grouping"),
});

const ingestResultSchema = z.object({
  errors: z.array(errorEntrySchema),
  totalIngested: z.number(),
  sources: z.record(z.enum(["ci", "api", "runtime"]), z.number()),
});

const clusterSchema = z.object({
  clusters: z.array(z.object({
    clusterId: z.string(),
    fingerprint: z.string(),
    representative: z.string().describe("Representative error message for the cluster"),
    count: z.number(),
    source: z.enum(["ci", "api", "runtime"]),
    errorIds: z.array(z.string()),
    firstSeen: z.string(),
    lastSeen: z.string(),
  })),
  totalClusters: z.number(),
  largestClusterSize: z.number(),
});

const explanationSchema = z.object({
  explanations: z.array(z.object({
    clusterId: z.string(),
    fingerprint: z.string(),
    rootCause: z.string(),
    remediation: z.string(),
    severity: z.enum(["critical", "high", "medium", "low"]),
    relatedDocs: z.array(z.string()).optional(),
    suggestedOwner: z.string().optional(),
  })),
  summary: z.string(),
});

const kbUpdateSchema = z.object({
  entriesWritten: z.number(),
  ticketsCreated: z.array(z.string()),
  kbPath: z.string(),
  remediationTable: z.array(z.object({
    fingerprint: z.string(),
    rootCause: z.string(),
    remediation: z.string(),
    severity: z.string(),
    occurrences: z.number(),
  })),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  ingestResult: ingestResultSchema,
  clusters: clusterSchema,
  explanations: explanationSchema,
  kbUpdate: kbUpdateSchema,
});

const ingester = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, read, grep },
  instructions: `You are an error ingester. Read error logs from the provided sources
(CI logs, API error endpoints, runtime crash reports). Normalize each error into a
canonical form with a stable fingerprint derived from the error message and stack trace.
Strip variable parts (timestamps, request IDs, line numbers) to produce consistent signatures.`,
});

const explainer = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep, bash },
  instructions: `You are an error analyst. For each error cluster, determine the root cause,
suggest a remediation, and assign a severity. Reference existing documentation or runbooks
when available. Be specific and actionable — vague advice like "check the logs" is not helpful.`,
});

const updater = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { write, bash },
  instructions: `You are a knowledge base maintainer. Write error explanations and remediation
steps to the configured KB path as structured entries. Create ticket stubs for critical/high
severity clusters that lack existing tickets. Output a searchable remediation table.`,
});

export default smithers((ctx) => {
  const ingest = ctx.outputMaybe("ingestResult", { nodeId: "ingest" });
  const clusters = ctx.outputMaybe("clusters", { nodeId: "cluster" });
  const explanations = ctx.outputMaybe("explanations", { nodeId: "explain" });

  return (
    <Workflow name="error-clusterer">
      <Sequence>
        {/* Phase 1: Ingest — read raw errors and normalize fingerprints */}
        <Task id="ingest" output={outputs.ingestResult} agent={ingester}>
          <IngestPrompt
            sources={ctx.input.sources ?? ["ci"]}
            logPaths={ctx.input.logPaths ?? []}
            since={ctx.input.since ?? "24h"}
          />
        </Task>

        {/* Phase 2: Cluster — group errors by fingerprint */}
        <Task id="cluster" output={outputs.clusters}>
          {{
            clusters: Object.values(
              (ingest?.errors ?? []).reduce<Record<string, {
                clusterId: string;
                fingerprint: string;
                representative: string;
                count: number;
                source: "ci" | "api" | "runtime";
                errorIds: string[];
                firstSeen: string;
                lastSeen: string;
              }>>((acc, err) => {
                if (!acc[err.fingerprint]) {
                  acc[err.fingerprint] = {
                    clusterId: `cluster-${Object.keys(acc).length + 1}`,
                    fingerprint: err.fingerprint,
                    representative: err.message,
                    count: 0,
                    source: err.source,
                    errorIds: [],
                    firstSeen: err.timestamp,
                    lastSeen: err.timestamp,
                  };
                }
                acc[err.fingerprint].count += 1;
                acc[err.fingerprint].errorIds.push(err.id);
                acc[err.fingerprint].lastSeen = err.timestamp;
                return acc;
              }, {}),
            ).sort((a, b) => b.count - a.count),
            totalClusters: new Set((ingest?.errors ?? []).map((e) => e.fingerprint)).size,
            largestClusterSize: Math.max(
              0,
              ...Object.values(
                (ingest?.errors ?? []).reduce<Record<string, number>>((acc, e) => {
                  acc[e.fingerprint] = (acc[e.fingerprint] ?? 0) + 1;
                  return acc;
                }, {}),
              ),
            ),
          }}
        </Task>

        {/* Phase 3: Explain — agent analyzes each cluster for root cause */}
        <Task id="explain" output={outputs.explanations} agent={explainer}>
          <ExplainPrompt
            clusters={clusters?.clusters ?? []}
            totalClusters={clusters?.totalClusters ?? 0}
            kbPath={ctx.input.kbPath ?? "./error-kb"}
          />
        </Task>

        {/* Phase 4: KB/ticket update — persist explanations and create tickets */}
        <Task id="kb-update" output={outputs.kbUpdate} agent={updater}>
          <UpdatePrompt
            explanations={explanations?.explanations ?? []}
            kbPath={ctx.input.kbPath ?? "./error-kb"}
            ticketPrefix={ctx.input.ticketPrefix ?? "ERR"}
            clusters={clusters?.clusters ?? []}
          />
        </Task>
      </Sequence>
    </Workflow>
  );
});
