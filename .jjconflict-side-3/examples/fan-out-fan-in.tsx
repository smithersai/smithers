/**
 * <FanOutFanIn> — Split work into N parallel agents, aggregate results.
 *
 * Pattern: Generate items → process each in parallel → merge into single output.
 * Use cases: batch file processing, multi-file refactoring, parallel analysis,
 * map-reduce style operations.
 */
import { Sequence, Parallel, ClaudeCodeAgent } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit.js";
import { z } from "zod";
import SplitPrompt from "./prompts/fan-out-fan-in/split.mdx";
import ProcessPrompt from "./prompts/fan-out-fan-in/process.mdx";
import MergePrompt from "./prompts/fan-out-fan-in/merge.mdx";

const splitSchema = z.object({
  items: z.array(z.object({
    id: z.string(),
    input: z.string(),
    context: z.string(),
  })),
  totalItems: z.number(),
});

const processSchema = z.object({
  itemId: z.string(),
  output: z.string(),
  status: z.enum(["success", "failed"]),
  metrics: z.record(z.string(), z.number()).optional(),
});

const mergeSchema = z.object({
  totalProcessed: z.number(),
  succeeded: z.number(),
  failed: z.number(),
  aggregatedOutput: z.string(),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
  split: splitSchema,
  process: processSchema,
  merge: mergeSchema,
});

const splitter = new ClaudeCodeAgent({
  model: "claude-sonnet-4-20250514",
  systemPrompt: `You are a work splitter. Analyze the input and divide it into
independent, equally-sized chunks that can be processed in parallel.`,
});

const processor = new ClaudeCodeAgent({
  model: "claude-sonnet-4-20250514",
  systemPrompt: `You are a worker. Process your assigned item according to the instructions.
Be thorough but focused on just your item.`,
});

const merger = new ClaudeCodeAgent({
  model: "claude-sonnet-4-20250514",
  systemPrompt: `You are an aggregator. Combine multiple worker results into a single
coherent output. Resolve any conflicts. Produce a clean summary.`,
});

export default smithers((ctx) => {
  const split = ctx.outputMaybe("split", { nodeId: "split" });
  const results = ctx.outputs.process ?? [];

  return (
    <Workflow name="fan-out-fan-in">
      <Sequence>
        {/* Split: divide work */}
        <Task id="split" output={outputs.split} agent={splitter}>
          <SplitPrompt
            input={ctx.input.input ?? ctx.input.directory ?? "Analyze the sentiment of these three sentences: 1. I love Smithers! 2. AI orchestration is hard. 3. This TUI is amazing!"}
            operation={ctx.input.operation ?? "Analyze sentiment for each item independently."}
            maxChunks={ctx.input.maxChunks ?? 3}
          />
        </Task>

        {/* Fan-out: process each chunk in parallel */}
        {split && (
          <Parallel maxConcurrency={ctx.input.maxConcurrency ?? 5}>
            {split.items.map((item) => (
              <Task
                key={item.id}
                id={`process-${item.id}`}
                output={outputs.process}
                agent={processor}
                continueOnFail
                timeoutMs={ctx.input.timeoutMs ?? 120_000}
              >
                <ProcessPrompt
                  id={item.id}
                  input={item.input}
                  context={item.context}
                  operation={ctx.input.operation}
                />
              </Task>
            ))}
          </Parallel>
        )}

        {/* Fan-in: merge results */}
        <Task id="merge" output={outputs.merge} agent={merger}>
          <MergePrompt results={results} />
        </Task>
      </Sequence>
    </Workflow>
  );
});
