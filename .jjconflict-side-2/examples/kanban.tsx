/**
 * <Kanban> — Process items through columns (backlog → in-progress → review → done).
 *
 * Pattern: Plan tasks → Execute in parallel → Review each → Mark done or loop back.
 * Use cases: issue processing, PR queues, ticket triage, batch operations.
 */
import { Sequence, Parallel, Loop } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, write, edit, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import TriagePrompt from "./prompts/kanban/triage.mdx";
import WorkPrompt from "./prompts/kanban/work.mdx";
import ReviewPrompt from "./prompts/kanban/review.mdx";

const itemSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  column: z.enum(["backlog", "in-progress", "review", "done", "blocked"]),
});

const triageSchema = z.object({
  items: z.array(itemSchema),
  totalItems: z.number(),
});

const workResultSchema = z.object({
  itemId: z.string(),
  column: z.enum(["review", "done", "blocked"]),
  summary: z.string(),
  filesChanged: z.array(z.string()),
});

const reviewResultSchema = z.object({
  itemId: z.string(),
  approved: z.boolean(),
  feedback: z.string(),
  column: z.enum(["done", "backlog"]),
});

const boardSchema = z.object({
  done: z.array(z.string()),
  blocked: z.array(z.string()),
  loopedBack: z.array(z.string()),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
  triage: triageSchema,
  work: workResultSchema,
  review: reviewResultSchema,
  board: boardSchema,
});

const triageAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep, bash },
  instructions: `You are a project manager. Analyze the input and break it into discrete work items.
Prioritize them and put them all in the "backlog" column.`,
});

const workerAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, write, edit, bash, grep },
  instructions: `You are a developer. Complete the assigned task. Make clean, minimal changes.
Move the item to "review" when done, or "blocked" if you can't proceed.`,
});

const reviewerAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep },
  instructions: `You are a code reviewer. Check the work done on this item.
If it looks good, move to "done". If it needs fixes, move back to "backlog" with feedback.`,
});

export default smithers((ctx) => {
  const triage = ctx.outputMaybe("triage", { nodeId: "triage" });
  const workResults = ctx.outputs.work ?? [];
  const reviewResults = ctx.outputs.review ?? [];

  const doneIds = new Set(reviewResults.filter((r) => r.column === "done").map((r) => r.itemId));
  const allDone = triage ? triage.items.every((item) => doneIds.has(item.id)) : false;

  return (
    <Workflow name="kanban">
      <Sequence>
        {/* Triage: break input into work items */}
        <Task id="triage" output={outputs.triage} agent={triageAgent}>
          <TriagePrompt goal={ctx.input.goal} directory={ctx.input.directory} />
        </Task>

        {/* Process: work on backlog items in parallel */}
        {triage && (
          <Loop until={allDone} maxIterations={3} onMaxReached="return-last">
            <Sequence>
              <Parallel maxConcurrency={ctx.input.maxAgents ?? 3}>
                {triage.items
                  .filter((item) => !doneIds.has(item.id))
                  .map((item) => (
                    <Task
                      key={item.id}
                      id={`work-${item.id}`}
                      output={outputs.work}
                      agent={workerAgent}
                      continueOnFail
                    >
                      <WorkPrompt
                        id={item.id}
                        title={item.title}
                        description={item.description}
                        directory={ctx.input.directory}
                      />
                    </Task>
                  ))}
              </Parallel>

              {/* Review each completed item */}
              <Parallel maxConcurrency={2}>
                {workResults
                  .filter((r) => r.column === "review")
                  .map((result) => (
                    <Task
                      key={result.itemId}
                      id={`review-${result.itemId}`}
                      output={outputs.review}
                      agent={reviewerAgent}
                    >
                      <ReviewPrompt
                        itemId={result.itemId}
                        summary={result.summary}
                        filesChanged={result.filesChanged}
                      />
                    </Task>
                  ))}
              </Parallel>
            </Sequence>
          </Loop>
        )}

        {/* Final board state */}
        <Task id="board" output={outputs.board}>
          {{
            done: reviewResults.filter((r) => r.column === "done").map((r) => r.itemId),
            blocked: workResults.filter((r) => r.column === "blocked").map((r) => r.itemId),
            loopedBack: reviewResults.filter((r) => r.column === "backlog").map((r) => r.itemId),
            summary: `Processed ${triage?.totalItems ?? 0} items: ${doneIds.size} done, ${workResults.filter((r) => r.column === "blocked").length} blocked`,
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});
