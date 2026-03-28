/**
 * <DynamicSchemaEnricher> — Build or select output schemas dynamically based on
 * source, tenant, or document family, then extract into the right shape.
 *
 * Shape: input/context → dynamic type resolver → extractor → typed output.
 */
import { createSmithers, Sequence } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import ContextPrompt from "./prompts/dynamic-schema-enricher/context.mdx";
import ResolvePrompt from "./prompts/dynamic-schema-enricher/resolve.mdx";
import ExtractPrompt from "./prompts/dynamic-schema-enricher/extract.mdx";
import OutputPrompt from "./prompts/dynamic-schema-enricher/output.mdx";

const contextSchema = z.object({
  source: z.string(),
  tenant: z.string(),
  documentFamily: z.enum(["invoice", "contract", "receipt", "onboarding", "support-ticket", "unknown"]),
  rawContent: z.string(),
  detectedLanguage: z.string(),
  summary: z.string(),
});

const resolvedSchemaSpec = z.object({
  schemaId: z.string(),
  schemaFamily: z.string(),
  fields: z.array(
    z.object({
      name: z.string(),
      type: z.enum(["string", "number", "boolean", "date", "array", "object"]),
      required: z.boolean(),
      description: z.string(),
    })
  ),
  tenantOverrides: z.array(
    z.object({
      field: z.string(),
      rule: z.string(),
    })
  ),
  confidence: z.number().min(0).max(1),
  summary: z.string(),
});

const extractionSchema = z.object({
  schemaId: z.string(),
  extractedFields: z.record(z.string(), z.unknown()),
  missingRequired: z.array(z.string()),
  warnings: z.array(z.string()),
  extractionConfidence: z.number().min(0).max(1),
  summary: z.string(),
});

const typedOutputSchema = z.object({
  schemaId: z.string(),
  tenant: z.string(),
  documentFamily: z.string(),
  payload: z.record(z.string(), z.unknown()),
  valid: z.boolean(),
  validationErrors: z.array(z.string()),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  context: contextSchema,
  resolvedSchema: resolvedSchemaSpec,
  extraction: extractionSchema,
  typedOutput: typedOutputSchema,
});

const resolverAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a schema resolution specialist. Given a document's source, tenant, and family,
determine the correct output schema to use. Look up tenant-specific field overrides, select the
appropriate schema family, and return the full field specification with types and requirements.`,
});

const extractorAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a structured data extractor. Given raw document content and a target schema
specification, extract every field defined in the schema. Flag any required fields that are missing
and note confidence levels. Handle ambiguous values by choosing the most likely interpretation.`,
});

export default smithers((ctx) => {
  const context = ctx.outputMaybe("context", { nodeId: "context" });
  const resolved = ctx.outputMaybe("resolvedSchema", { nodeId: "resolve" });
  const extraction = ctx.outputMaybe("extraction", { nodeId: "extract" });

  return (
    <Workflow name="dynamic-schema-enricher">
      <Sequence>
        {/* Stage 1: Parse input context — identify source, tenant, and document family */}
        <Task id="context" output={outputs.context}>
          <ContextPrompt
            rawInput={ctx.input.document ?? ""}
            source={ctx.input.source ?? "unknown"}
            tenant={ctx.input.tenant ?? "default"}
          />
        </Task>

        {/* Stage 2: Dynamically resolve the right schema for this document type */}
        <Task id="resolve" output={outputs.resolvedSchema} agent={resolverAgent}>
          <ResolvePrompt
            documentFamily={context?.documentFamily ?? "unknown"}
            tenant={context?.tenant ?? "default"}
            source={context?.source ?? "unknown"}
            detectedLanguage={context?.detectedLanguage ?? "en"}
            schemaRegistry={ctx.input.schemaRegistry ?? "default"}
          />
        </Task>

        {/* Stage 3: Extract fields from raw content using the resolved schema */}
        <Task id="extract" output={outputs.extraction} agent={extractorAgent}>
          <ExtractPrompt
            rawContent={context?.rawContent ?? ""}
            schemaId={resolved?.schemaId ?? ""}
            fields={resolved?.fields ?? []}
            tenantOverrides={resolved?.tenantOverrides ?? []}
          />
        </Task>

        {/* Stage 4: Validate and produce the final typed output */}
        <Task id="output" output={outputs.typedOutput}>
          <OutputPrompt
            schemaId={resolved?.schemaId ?? ""}
            tenant={context?.tenant ?? "default"}
            documentFamily={context?.documentFamily ?? "unknown"}
            extractedFields={extraction?.extractedFields ?? {}}
            missingRequired={extraction?.missingRequired ?? []}
            warnings={extraction?.warnings ?? []}
            confidence={extraction?.extractionConfidence ?? 0}
          />
        </Task>
      </Sequence>
    </Workflow>
  );
});
