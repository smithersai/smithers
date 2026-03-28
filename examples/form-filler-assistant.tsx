// @ts-nocheck
/**
 * <FormFillerAssistant> — Extract known fields from source documents and user input,
 * iteratively ask for missing fields, then fill forms/APIs with validated structured data.
 *
 * Shape: source docs/user input → extractor → missing-field loop → form/API tool.
 */
import { createSmithers, Sequence, Loop } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, write, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import ExtractPrompt from "./prompts/form-filler-assistant/extract.mdx";
import AskMissingPrompt from "./prompts/form-filler-assistant/ask-missing.mdx";
import ValidatePrompt from "./prompts/form-filler-assistant/validate.mdx";
import SubmitPrompt from "./prompts/form-filler-assistant/submit.mdx";

const fieldEntrySchema = z.object({
  name: z.string(),
  value: z.string(),
  source: z.enum(["document", "user-input", "inferred"]),
  confidence: z.number().min(0).max(1),
});

const extractionSchema = z.object({
  knownFields: z.array(fieldEntrySchema),
  missingFields: z.array(z.object({
    name: z.string(),
    description: z.string(),
    required: z.boolean(),
  })),
  documentType: z.string(),
  summary: z.string(),
});

const clarificationSchema = z.object({
  answeredFields: z.array(fieldEntrySchema),
  stillMissing: z.array(z.object({
    name: z.string(),
    description: z.string(),
    required: z.boolean(),
  })),
  allRequiredCollected: z.boolean(),
  summary: z.string(),
});

const validationSchema = z.object({
  valid: z.boolean(),
  fields: z.array(z.object({
    name: z.string(),
    value: z.string(),
    valid: z.boolean(),
    error: z.string().optional(),
  })),
  normalizedPayload: z.record(z.string(), z.string()),
  summary: z.string(),
});

const submissionSchema = z.object({
  target: z.string(),
  status: z.enum(["submitted", "dry-run", "failed"]),
  responseCode: z.number().optional(),
  confirmationId: z.string().optional(),
  fieldCount: z.number(),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  extraction: extractionSchema,
  clarification: clarificationSchema,
  validation: validationSchema,
  submission: submissionSchema,
});

const extractorAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep },
  instructions: `You are a document field extractor. Given source documents and user input,
identify all form-relevant fields you can extract with high confidence. Flag any required
fields that are missing or ambiguous. Be precise about confidence scores.`,
});

const clarificationAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read },
  instructions: `You are a form-filling assistant that asks clear, concise follow-up questions
to collect missing required fields. When the user provides answers, validate them against
the expected format and merge them into the known field set.`,
});

const submissionAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, write },
  instructions: `You are a form submission agent. Given a validated payload and a target
form or API endpoint, submit the data using the appropriate method. For APIs, use curl
or equivalent. For file-based forms, write the structured output. Always confirm success.`,
});

export default smithers((ctx) => {
  const extraction = ctx.outputMaybe("extraction", { nodeId: "extract" });
  const clarifications = ctx.outputs.clarification ?? [];
  const latestClarification = clarifications[clarifications.length - 1];
  const allRequiredCollected = latestClarification?.allRequiredCollected ?? false;
  const noMissingRequired = (extraction?.missingFields ?? []).filter((f) => f.required).length === 0;
  const doneCollecting = allRequiredCollected || noMissingRequired;
  const validation = ctx.outputMaybe("validation", { nodeId: "validate" });

  return (
    <Workflow name="form-filler-assistant">
      <Sequence>
        {/* Stage 1: Extract known fields from source documents and user input */}
        <Task id="extract" output={outputs.extraction} agent={extractorAgent}>
          <ExtractPrompt
            documents={ctx.input.documents ?? []}
            userInput={ctx.input.userInput ?? ""}
            formSchema={ctx.input.formSchema ?? {}}
          />
        </Task>

        {/* Stage 2: Loop to collect missing required fields */}
        <Loop until={doneCollecting} maxIterations={ctx.input.maxClarifications ?? 5} onMaxReached="return-last">
          <Task id="clarify" output={outputs.clarification} agent={clarificationAgent}>
            <AskMissingPrompt
              knownFields={extraction?.knownFields ?? []}
              missingFields={latestClarification?.stillMissing ?? extraction?.missingFields ?? []}
              previousAnswers={latestClarification?.answeredFields ?? []}
              userResponses={ctx.input.userResponses ?? []}
            />
          </Task>
        </Loop>

        {/* Stage 3: Validate and normalize the complete field set */}
        <Task id="validate" output={outputs.validation}>
          <ValidatePrompt
            knownFields={extraction?.knownFields ?? []}
            collectedFields={latestClarification?.answeredFields ?? []}
            formSchema={ctx.input.formSchema ?? {}}
          />
        </Task>

        {/* Stage 4: Submit to the target form or API */}
        <Task id="submit" output={outputs.submission} agent={submissionAgent} skipIf={!validation?.valid}>
          <SubmitPrompt
            payload={validation?.normalizedPayload ?? {}}
            target={ctx.input.target ?? "stdout"}
            method={ctx.input.method ?? "dry-run"}
            dryRun={ctx.input.dryRun ?? true}
          />
        </Task>
      </Sequence>
    </Workflow>
  );
});
