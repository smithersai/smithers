/**
 * <Waterfall> — Sequential phases where each receives the previous phase's output.
 *
 * Pattern: Phase A → Phase B (using A's output) → Phase C (using B's output).
 * Use cases: multi-stage pipelines, progressive refinement, build pipelines,
 * content pipelines (outline → draft → edit → publish).
 */
import { Sequence } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, write, edit, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import OutlinePrompt from "./prompts/waterfall/outline.mdx";
import DraftPrompt from "./prompts/waterfall/draft.mdx";
import EditPrompt from "./prompts/waterfall/edit.mdx";
import PublishPrompt from "./prompts/waterfall/publish.mdx";

const outlineSchema = z.object({
  sections: z.array(z.object({
    title: z.string(),
    keyPoints: z.array(z.string()),
    estimatedLength: z.number(),
  })),
  totalSections: z.number(),
  targetAudience: z.string(),
});

const draftSchema = z.object({
  content: z.string(),
  wordCount: z.number(),
  sectionsCompleted: z.number(),
});

const editSchema = z.object({
  content: z.string(),
  wordCount: z.number(),
  changesApplied: z.array(z.string()),
  readabilityScore: z.number(),
});

const publishSchema = z.object({
  outputFile: z.string(),
  format: z.string(),
  wordCount: z.number(),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
  outline: outlineSchema,
  draft: draftSchema,
  edit: editSchema,
  publish: publishSchema,
});

const outliner = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep },
  instructions: `You are a content strategist. Create detailed outlines with clear structure.
Consider the target audience and purpose.`,
});

const drafter = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  instructions: `You are a technical writer. Write high-quality content from outlines.
Follow the structure exactly. Be thorough but concise.`,
});

const editor = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  instructions: `You are an editor. Improve clarity, fix errors, tighten prose.
Don't change the meaning or structure — just make it better.`,
});

const publisher = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { write },
  instructions: `You are a publisher. Format content for the target medium and write it to a file.`,
});

export default smithers((ctx) => {
  const outline = ctx.outputMaybe("outline", { nodeId: "outline" });
  const draft = ctx.outputMaybe("draft", { nodeId: "draft" });
  const edited = ctx.outputMaybe("edit", { nodeId: "edit" });

  return (
    <Workflow name="waterfall">
      <Sequence>
        <Task id="outline" output={outputs.outline} agent={outliner}>
          <OutlinePrompt
            topic={ctx.input.topic}
            audience={ctx.input.audience ?? "developers"}
            targetWords={ctx.input.targetWords ?? 2000}
            context={ctx.input.context}
          />
        </Task>

        <Task id="draft" output={outputs.draft} agent={drafter}>
          <DraftPrompt
            sections={outline?.sections ?? []}
            targetAudience={outline?.targetAudience ?? ctx.input.audience ?? "developers"}
          />
        </Task>

        <Task id="edit" output={outputs.edit} agent={editor}>
          <EditPrompt content={draft?.content ?? "Waiting for draft..."} />
        </Task>

        <Task id="publish" output={outputs.publish} agent={publisher}>
          <PublishPrompt
            content={edited?.content ?? "Waiting for edits..."}
            outputFile={ctx.input.outputFile ?? "output.md"}
            format={ctx.input.format ?? "markdown"}
          />
        </Task>
      </Sequence>
    </Workflow>
  );
});
