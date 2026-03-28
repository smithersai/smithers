/**
 * <TypedExtractorStage> — Turn messy text/files into a typed structured object
 * for downstream workflow steps. Reusable extraction component.
 *
 * Shape: raw input → extractor agent → typed state → next workflow step.
 */
import { createSmithers, Sequence } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import ExtractPrompt from "./prompts/typed-extractor-stage/extract.mdx";
import ValidatePrompt from "./prompts/typed-extractor-stage/validate.mdx";
import ForwardPrompt from "./prompts/typed-extractor-stage/forward.mdx";

const extractedSchema = z.object({
  entityName: z.string(),
  entityType: z.enum(["person", "company", "product", "event", "document", "other"]),
  fields: z.array(z.object({
    key: z.string(),
    value: z.string(),
    confidence: z.number().min(0).max(1),
  })),
  rawSnippets: z.array(z.string()),
  summary: z.string(),
});

const validatedSchema = z.object({
  entityName: z.string(),
  entityType: z.enum(["person", "company", "product", "event", "document", "other"]),
  fields: z.array(z.object({
    key: z.string(),
    value: z.string(),
    confidence: z.number().min(0).max(1),
    valid: z.boolean(),
    correctedValue: z.string().optional(),
  })),
  overallConfidence: z.number().min(0).max(1),
  issues: z.array(z.string()),
  summary: z.string(),
});

const forwardSchema = z.object({
  entityName: z.string(),
  entityType: z.enum(["person", "company", "product", "event", "document", "other"]),
  structuredOutput: z.record(z.string(), z.string()),
  overallConfidence: z.number().min(0).max(1),
  nextStep: z.string(),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  extracted: extractedSchema,
  validated: validatedSchema,
  forward: forwardSchema,
});

const extractorAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a structured data extractor. Given messy unstructured text or file paths,
identify the primary entity and extract all relevant fields into typed key-value pairs.
Assign a confidence score to each field. Preserve raw snippets that support your extractions.`,
});

const validatorAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a data validation specialist. Review extracted fields for correctness,
consistency, and completeness. Flag issues, correct obvious errors, and compute an overall
confidence score. Mark each field as valid or invalid.`,
});

export default smithers((ctx) => {
  const extracted = ctx.outputMaybe("extracted", { nodeId: "extract" });
  const validated = ctx.outputMaybe("validated", { nodeId: "validate" });

  return (
    <Workflow name="typed-extractor-stage">
      <Sequence>
        {/* Stage 1: Extract structured fields from raw messy input */}
        <Task id="extract" output={outputs.extracted} agent={extractorAgent}>
          <ExtractPrompt
            rawInput={ctx.input.rawInput ?? ""}
            filePaths={ctx.input.filePaths ?? []}
            targetSchema={ctx.input.targetSchema ?? "auto-detect"}
          />
        </Task>

        {/* Stage 2: Validate and correct extracted fields */}
        <Task id="validate" output={outputs.validated} agent={validatorAgent}>
          <ValidatePrompt
            entityName={extracted?.entityName ?? ""}
            entityType={extracted?.entityType ?? "other"}
            fields={extracted?.fields ?? []}
            rawSnippets={extracted?.rawSnippets ?? []}
          />
        </Task>

        {/* Stage 3: Produce final typed output for the next workflow step */}
        <Task id="forward" output={outputs.forward}>
          <ForwardPrompt
            entityName={validated?.entityName ?? ""}
            entityType={validated?.entityType ?? "other"}
            fields={validated?.fields?.filter((f) => f.valid) ?? []}
            overallConfidence={validated?.overallConfidence ?? 0}
            issues={validated?.issues ?? []}
            nextStep={ctx.input.nextStep ?? "downstream-processor"}
          />
        </Task>
      </Sequence>
    </Workflow>
  );
});
