// @ts-nocheck
/**
 * <ComplianceEvidenceCollector> — Gather compliance evidence from APIs, MCP tools,
 * or browser fallback, then assemble a review packet.
 *
 * Pattern: Orchestrator → parallel evidence fetchers → normalizer/extractor → packet agent.
 * Use cases: SOC 2 evidence collection, ISO 27001 audits, PCI-DSS reviews,
 * regulatory compliance gathering.
 */
import { Sequence, Parallel } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, write, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import OrchestratorPrompt from "./prompts/compliance-evidence-collector/orchestrator.mdx";
import FetchPrompt from "./prompts/compliance-evidence-collector/fetch.mdx";
import NormalizePrompt from "./prompts/compliance-evidence-collector/normalize.mdx";
import PacketPrompt from "./prompts/compliance-evidence-collector/packet.mdx";

const evidenceItemSchema = z.object({
  sourceId: z.string(),
  controlId: z.string(),
  title: z.string(),
  rawPayload: z.string(),
  fetchedAt: z.string(),
  method: z.enum(["api", "mcp", "browser"]),
  status: z.enum(["collected", "partial", "failed"]),
});

const planSchema = z.object({
  controls: z.array(z.object({
    controlId: z.string(),
    description: z.string(),
    sources: z.array(z.object({
      sourceId: z.string(),
      endpoint: z.string(),
      preferredMethod: z.enum(["api", "mcp", "browser"]),
    })),
  })),
  totalSources: z.number(),
});

const normalizedSchema = z.object({
  controlId: z.string(),
  sourceId: z.string(),
  finding: z.string(),
  compliant: z.boolean(),
  severity: z.enum(["info", "low", "medium", "high", "critical"]).optional(),
  extractedFields: z.record(z.string()).optional(),
});

const packetSchema = z.object({
  framework: z.string(),
  generatedAt: z.string(),
  controlCount: z.number(),
  compliantCount: z.number(),
  nonCompliantCount: z.number(),
  findings: z.array(z.object({
    controlId: z.string(),
    status: z.enum(["compliant", "non-compliant", "insufficient-evidence"]),
    evidence: z.array(z.string()),
    recommendation: z.string().optional(),
  })),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
  plan: planSchema,
  evidence: evidenceItemSchema,
  normalized: normalizedSchema,
  packet: packetSchema,
});

const orchestrator = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep },
  instructions: `You are a compliance planning agent. Given a compliance framework and scope,
identify the controls that need evidence and plan which sources to query for each.`,
});

const fetcher = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, read, grep },
  instructions: `You are an evidence fetcher. Collect raw evidence from the assigned source
using the preferred method (API call, MCP tool, or browser fallback). Return the raw payload.`,
});

const normalizer = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read },
  instructions: `You are an evidence normalizer. Take raw evidence payloads and extract
structured findings: compliance status, severity, and key fields.`,
});

const packetAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { write },
  instructions: `You are a compliance packet assembler. Aggregate normalized findings into
a final review packet with per-control verdicts, evidence references, and recommendations.`,
});

export default smithers((ctx) => {
  const plan = ctx.outputMaybe("plan", { nodeId: "plan" });
  const evidenceItems = ctx.outputs.evidence ?? [];
  const normalized = ctx.outputs.normalized ?? [];

  return (
    <Workflow name="compliance-evidence-collector">
      <Sequence>
        {/* Step 1: Plan which controls and sources to collect */}
        <Task id="plan" output={outputs.plan} agent={orchestrator}>
          <OrchestratorPrompt
            framework={ctx.input.framework ?? "SOC2"}
            scope={ctx.input.scope}
            controls={ctx.input.controls}
          />
        </Task>

        {/* Step 2: Fan-out — fetch evidence from each source in parallel */}
        {plan && (
          <Parallel maxConcurrency={ctx.input.maxConcurrency ?? 5}>
            {plan.controls.flatMap((control) =>
              control.sources.map((source) => (
                <Task
                  key={`${control.controlId}-${source.sourceId}`}
                  id={`fetch-${control.controlId}-${source.sourceId}`}
                  output={outputs.evidence}
                  agent={fetcher}
                  continueOnFail
                  timeoutMs={ctx.input.timeoutMs ?? 60_000}
                >
                  <FetchPrompt
                    controlId={control.controlId}
                    sourceId={source.sourceId}
                    endpoint={source.endpoint}
                    method={source.preferredMethod}
                  />
                </Task>
              ))
            )}
          </Parallel>
        )}

        {/* Step 3: Normalize and extract structured findings */}
        {evidenceItems.length > 0 && (
          <Parallel maxConcurrency={ctx.input.maxConcurrency ?? 5}>
            {evidenceItems.map((item) => (
              <Task
                key={`norm-${item.controlId}-${item.sourceId}`}
                id={`normalize-${item.controlId}-${item.sourceId}`}
                output={outputs.normalized}
                agent={normalizer}
              >
                <NormalizePrompt
                  controlId={item.controlId}
                  sourceId={item.sourceId}
                  rawPayload={item.rawPayload}
                  method={item.method}
                />
              </Task>
            ))}
          </Parallel>
        )}

        {/* Step 4: Assemble the final review packet */}
        <Task id="packet" output={outputs.packet} agent={packetAgent}>
          <PacketPrompt
            framework={ctx.input.framework ?? "SOC2"}
            findings={normalized}
            controls={plan?.controls ?? []}
          />
        </Task>
      </Sequence>
    </Workflow>
  );
});
