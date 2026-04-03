// @ts-nocheck
/**
 * <ContractDriftSentinel> — Compare OpenAPI/JSON Schema/GraphQL/protobuf contracts
 * and flag likely breaking changes with consumer impact.
 *
 * Pattern: schema loader → diff engine → analyst agent → PR/status output.
 * Use cases: API governance, contract-first development, consumer impact analysis.
 */
import { Sequence } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import LoadPrompt from "./prompts/contract-drift-sentinel/load.mdx";
import DiffPrompt from "./prompts/contract-drift-sentinel/diff.mdx";
import AnalyzePrompt from "./prompts/contract-drift-sentinel/analyze.mdx";
import OutputPrompt from "./prompts/contract-drift-sentinel/output.mdx";

const schemaSnapshotSchema = z.object({
  format: z.enum(["openapi", "jsonschema", "graphql", "protobuf"]),
  version: z.string(),
  baseline: z.string().describe("Serialized content of the previous contract revision"),
  current: z.string().describe("Serialized content of the incoming contract revision"),
  entities: z.array(z.string()).describe("Top-level type/message/endpoint names found"),
});

const diffResultSchema = z.object({
  additions: z.array(z.object({
    path: z.string(),
    description: z.string(),
  })),
  removals: z.array(z.object({
    path: z.string(),
    description: z.string(),
  })),
  modifications: z.array(z.object({
    path: z.string(),
    before: z.string(),
    after: z.string(),
    description: z.string(),
  })),
  breakingCandidates: z.array(z.string()).describe("Paths likely to break existing consumers"),
  totalChanges: z.number(),
});

const analysisSchema = z.object({
  breakingChanges: z.array(z.object({
    path: z.string(),
    severity: z.enum(["critical", "high", "medium"]),
    reason: z.string(),
    affectedConsumers: z.array(z.string()),
    migrationHint: z.string(),
  })),
  safeChanges: z.array(z.object({
    path: z.string(),
    kind: z.enum(["addition", "deprecation-with-replacement", "documentation", "optional-field"]),
  })),
  riskScore: z.number().min(0).max(100),
  summary: z.string(),
});

const outputSchema = z.object({
  status: z.enum(["approve", "block", "warn"]),
  prComment: z.string(),
  breakingCount: z.number(),
  riskScore: z.number(),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
  schema: schemaSnapshotSchema,
  diff: diffResultSchema,
  analysis: analysisSchema,
  output: outputSchema,
});

const schemaLoader = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash },
  instructions: `You are a schema loader. Read the baseline and current contract files from the
provided paths. Detect the schema format (OpenAPI, JSON Schema, GraphQL SDL, or protobuf) by
inspecting file contents. Extract top-level entity names (endpoints, types, messages). Return the
raw content for both revisions so downstream tasks can diff them.`,
});

const diffEngine = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a contract diff engine. Compare the baseline and current schema snapshots
structurally — not just textually. Identify additions, removals, and modifications at the
field/endpoint/message level. Flag any removal, type narrowing, or required-field addition as a
breaking candidate. Be precise about paths (e.g. "POST /users response.body.phone").`,
});

const analyst = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep },
  instructions: `You are a contract compatibility analyst. Examine the structural diff and
determine which changes are truly breaking versus safely additive. For each breaking change,
identify which consumers are likely affected (from the consumer list provided) and suggest a
concrete migration path. Produce a risk score from 0-100.`,
});

export default smithers((ctx) => {
  const schema = ctx.outputMaybe("schema", { nodeId: "load" });
  const diff = ctx.outputMaybe("diff", { nodeId: "diff" });
  const analysis = ctx.outputMaybe("analysis", { nodeId: "analyze" });

  const riskScore = analysis?.riskScore ?? 0;
  const breakingCount = analysis?.breakingChanges.length ?? 0;
  const status = riskScore >= 70 ? "block" : riskScore >= 30 ? "warn" : "approve";

  return (
    <Workflow name="contract-drift-sentinel">
      <Sequence>
        {/* Phase 1: Load baseline and current schema revisions */}
        <Task id="load" output={outputs.schema} agent={schemaLoader}>
          <LoadPrompt
            baselinePath={ctx.input.baselinePath}
            currentPath={ctx.input.currentPath}
            format={ctx.input.format ?? "auto"}
          />
        </Task>

        {/* Phase 2: Structural diff between the two revisions */}
        <Task id="diff" output={outputs.diff} agent={diffEngine}>
          <DiffPrompt
            format={schema?.format ?? "unknown"}
            baseline={schema?.baseline ?? ""}
            current={schema?.current ?? ""}
            entities={schema?.entities ?? []}
          />
        </Task>

        {/* Phase 3: Analyst agent evaluates breaking changes and consumer impact */}
        <Task id="analyze" output={outputs.analysis} agent={analyst}>
          <AnalyzePrompt
            diff={diff}
            consumers={ctx.input.consumers ?? []}
            format={schema?.format ?? "unknown"}
          />
        </Task>

        {/* Phase 4: Produce PR comment and status gate */}
        <Task id="output" output={outputs.output}>
          <OutputPrompt
            status={status}
            breakingCount={breakingCount}
            riskScore={riskScore}
            breakingChanges={analysis?.breakingChanges ?? []}
            safeChanges={analysis?.safeChanges ?? []}
            summary={analysis?.summary ?? "No analysis available"}
          />
        </Task>
      </Sequence>
    </Workflow>
  );
});
