/**
 * <ExtractAnythingWorkbench> — Reusable local workbench for trying typed
 * extraction over arbitrary inputs before fixing a pipeline.
 *
 * Shape: arbitrary input → candidate extractors (parallel) → validator/preview.
 */
import { createSmithers, Sequence, Parallel } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import ExtractPrompt from "./prompts/extract-anything-workbench/extract.mdx";
import ValidatePrompt from "./prompts/extract-anything-workbench/validate.mdx";
import PreviewPrompt from "./prompts/extract-anything-workbench/preview.mdx";

const candidateSchema = z.object({
  extractorName: z.string(),
  fields: z.array(z.object({
    key: z.string(),
    value: z.string(),
    confidence: z.number().min(0).max(1),
  })),
  rawOutput: z.string(),
  overallConfidence: z.number().min(0).max(1),
});

const validationSchema = z.object({
  extractorName: z.string(),
  isValid: z.boolean(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  fieldCount: z.number(),
  confidenceScore: z.number().min(0).max(1),
});

const previewSchema = z.object({
  selectedExtractor: z.string().nullable(),
  extractedData: z.record(z.string(), z.string()).nullable(),
  summary: z.string(),
  recommendation: z.enum(["use", "refine", "discard"]),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  candidate: candidateSchema,
  validation: validationSchema,
  preview: previewSchema,
});

const extractorAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a typed extractor. Given arbitrary input and a target schema,
extract structured fields with confidence scores. Be precise and honest about confidence.`,
});

const validatorAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  instructions: `You are a schema validator. Check extracted data against the target schema.
Flag missing fields, type mismatches, and low-confidence values. Be strict.`,
});

const previewAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  instructions: `You are an extraction reviewer. Compare validated candidates and pick the
best extractor. Summarise what was extracted and whether the pipeline should adopt it.`,
});

export default smithers((ctx) => {
  const extractors: string[] = ctx.input.extractors ?? ["auto"];
  const validations = ctx.outputs.validation ?? [];

  return (
    <Workflow name="extract-anything-workbench">
      <Sequence>
        {/* Run candidate extractors in parallel */}
        <Parallel maxConcurrency={extractors.length}>
          {extractors.map((name: string) => (
            <Task
              key={name}
              id={`extract-${name}`}
              output={outputs.candidate}
              agent={extractorAgent}
            >
              <ExtractPrompt
                extractorName={name}
                input={ctx.input.input}
                targetSchema={ctx.input.targetSchema}
              />
            </Task>
          ))}
        </Parallel>

        {/* Validate each candidate in parallel */}
        <Parallel maxConcurrency={extractors.length}>
          {(ctx.outputs.candidate ?? []).map((candidate) => (
            <Task
              key={candidate.extractorName}
              id={`validate-${candidate.extractorName}`}
              output={outputs.validation}
              agent={validatorAgent}
            >
              <ValidatePrompt
                candidate={candidate}
                targetSchema={ctx.input.targetSchema}
              />
            </Task>
          ))}
        </Parallel>

        {/* Preview: pick the best extractor and summarise */}
        <Task id="preview" output={outputs.preview} agent={previewAgent}>
          <PreviewPrompt
            validations={validations}
            candidates={ctx.outputs.candidate ?? []}
            input={ctx.input.input}
          />
        </Task>
      </Sequence>
    </Workflow>
  );
});
