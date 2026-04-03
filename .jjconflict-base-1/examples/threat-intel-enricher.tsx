// @ts-nocheck
/**
 * <ThreatIntelEnricher> — Enrich a security alert with external and internal context,
 * then produce a recommended severity and first-action list.
 *
 * Shape: alert ingester -> enrichment tools/APIs -> analyst agent -> case system.
 */
import { Sequence, Parallel } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import IngestPrompt from "./prompts/threat-intel-enricher/ingest.mdx";
import ExternalEnrichPrompt from "./prompts/threat-intel-enricher/external-enrich.mdx";
import InternalEnrichPrompt from "./prompts/threat-intel-enricher/internal-enrich.mdx";
import AnalystPrompt from "./prompts/threat-intel-enricher/analyst.mdx";
import CasePrompt from "./prompts/threat-intel-enricher/case.mdx";

const ingestedAlertSchema = z.object({
  alertId: z.string(),
  source: z.string(),
  indicators: z.array(
    z.object({
      type: z.enum(["ip", "domain", "hash", "email", "url", "other"]),
      value: z.string(),
    })
  ),
  rawDescription: z.string(),
  timestamp: z.string(),
  summary: z.string(),
});

const externalEnrichmentSchema = z.object({
  indicators: z.array(
    z.object({
      value: z.string(),
      threatFeeds: z.array(z.string()),
      knownMalicious: z.boolean(),
      firstSeen: z.string().optional(),
      tags: z.array(z.string()),
    })
  ),
  cveMatches: z.array(
    z.object({
      id: z.string(),
      severity: z.string(),
      description: z.string(),
    })
  ),
  summary: z.string(),
});

const internalEnrichmentSchema = z.object({
  affectedAssets: z.array(
    z.object({
      hostname: z.string(),
      service: z.string(),
      environment: z.enum(["production", "staging", "development"]),
      owner: z.string(),
    })
  ),
  recentActivity: z.array(
    z.object({
      timestamp: z.string(),
      event: z.string(),
      relevance: z.enum(["low", "medium", "high"]),
    })
  ),
  priorIncidents: z.array(z.string()),
  summary: z.string(),
});

const analystVerdictSchema = z.object({
  severity: z.enum(["low", "medium", "high", "critical"]),
  confidence: z.number().min(0).max(1),
  attackVector: z.string(),
  threatActor: z.string().optional(),
  firstActions: z.array(z.string()),
  narrative: z.string(),
  summary: z.string(),
});

const caseRecordSchema = z.object({
  caseId: z.string(),
  severity: z.enum(["low", "medium", "high", "critical"]),
  title: z.string(),
  assignee: z.string(),
  firstActions: z.array(z.string()),
  enrichmentSummary: z.string(),
  status: z.enum(["open", "triaged", "investigating", "resolved"]),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
  ingestedAlert: ingestedAlertSchema,
  externalEnrichment: externalEnrichmentSchema,
  internalEnrichment: internalEnrichmentSchema,
  analystVerdict: analystVerdictSchema,
  caseRecord: caseRecordSchema,
});

const enrichmentAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a threat intelligence enrichment specialist. Given a set of indicators,
query external threat feeds, CVE databases, and reputation services. Return structured
enrichment data including known-malicious flags, threat-feed matches, and relevant CVEs.`,
});

const internalContextAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are an internal security context gatherer. Given alert indicators,
look up affected assets in the CMDB, pull recent authentication and network logs,
and find any prior incidents involving the same indicators or assets.`,
});

const analystAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a senior security analyst. Given ingested alert data plus external
and internal enrichment, determine the recommended severity, identify the likely attack vector,
and produce a prioritized list of first-response actions. Be specific and actionable.`,
});

export default smithers((ctx) => {
  const ingested = ctx.outputMaybe("ingestedAlert", { nodeId: "ingest" });
  const external = ctx.outputMaybe("externalEnrichment", { nodeId: "external-enrich" });
  const internal = ctx.outputMaybe("internalEnrichment", { nodeId: "internal-enrich" });
  const verdict = ctx.outputMaybe("analystVerdict", { nodeId: "analyst" });

  return (
    <Workflow name="threat-intel-enricher">
      <Sequence>
        {/* Stage 1: Ingest and normalize the raw security alert */}
        <Task id="ingest" output={outputs.ingestedAlert}>
          <IngestPrompt
            alert={ctx.input.alert ?? {}}
            source={ctx.input.source ?? "unknown"}
          />
        </Task>

        {/* Stage 2: Enrich indicators via external feeds and internal systems in parallel */}
        <Parallel maxConcurrency={2}>
          <Task id="external-enrich" output={outputs.externalEnrichment} agent={enrichmentAgent}>
            <ExternalEnrichPrompt
              indicators={ingested?.indicators ?? []}
              alertId={ingested?.alertId ?? ""}
            />
          </Task>

          <Task id="internal-enrich" output={outputs.internalEnrichment} agent={internalContextAgent}>
            <InternalEnrichPrompt
              indicators={ingested?.indicators ?? []}
              rawDescription={ingested?.rawDescription ?? ""}
            />
          </Task>
        </Parallel>

        {/* Stage 3: Analyst agent synthesizes enrichment into a verdict */}
        <Task id="analyst" output={outputs.analystVerdict} agent={analystAgent}>
          <AnalystPrompt
            alert={ingested ?? {}}
            externalEnrichment={external ?? {}}
            internalEnrichment={internal ?? {}}
          />
        </Task>

        {/* Stage 4: File into the case management system */}
        <Task id="case" output={outputs.caseRecord}>
          <CasePrompt
            alertId={ingested?.alertId ?? ""}
            severity={verdict?.severity ?? "medium"}
            narrative={verdict?.narrative ?? ""}
            firstActions={verdict?.firstActions ?? []}
            affectedAssets={internal?.affectedAssets ?? []}
          />
        </Task>
      </Sequence>
    </Workflow>
  );
});
