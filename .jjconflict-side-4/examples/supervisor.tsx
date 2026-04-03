/**
 * <Supervisor> — Boss agent plans and delegates to worker agents dynamically.
 *
 * Pattern: Supervisor plans → spawns workers → reviews results → re-delegates failures.
 * Use cases: project manager agent, team lead, dynamic task allocation.
 */
import { Sequence, Parallel, Loop, Worktree } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, write, edit, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import DelegatePrompt from "./prompts/supervisor/delegate.mdx";
import WorkerPrompt from "./prompts/supervisor/worker.mdx";
import SupervisePrompt from "./prompts/supervisor/supervise.mdx";

const delegationSchema = z.object({
  tasks: z.array(z.object({
    id: z.string(),
    title: z.string(),
    instructions: z.string(),
    files: z.array(z.string()),
    workerType: z.enum(["coder", "tester", "docs"]),
  })),
  strategy: z.string(),
});

const workerResultSchema = z.object({
  taskId: z.string(),
  status: z.enum(["success", "partial", "failed"]),
  summary: z.string(),
  filesChanged: z.array(z.string()),
});

const supervisionSchema = z.object({
  allDone: z.boolean(),
  retriable: z.array(z.string()),
  summary: z.string(),
  nextActions: z.array(z.string()),
});

const finalSchema = z.object({
  totalTasks: z.number(),
  succeeded: z.number(),
  failed: z.number(),
  iterations: z.number(),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
  delegation: delegationSchema,
  workerResult: workerResultSchema,
  supervision: supervisionSchema,
  final: finalSchema,
});

const boss = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep, bash },
  instructions: `You are a technical lead. Break the goal into tasks and assign them
to workers. After seeing results, decide what needs re-doing. Be strategic about
task decomposition — keep tasks small and independent.`,
});

const coder = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, write, edit, bash, grep },
  instructions: `You are a developer. Complete your assigned task with clean code.
Commit your work when done.`,
});

const tester = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, write, bash, grep },
  instructions: `You are a test engineer. Write thorough tests for the assigned code.
Cover edge cases. Commit your work.`,
});

const docsWriter = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, write, edit, grep },
  instructions: `You are a technical writer. Write clear documentation for the
assigned code. Update READMEs, add JSDoc, create usage examples.`,
});

const workerAgents = { coder, tester, docs: docsWriter };

export default smithers((ctx) => {
  const delegation = ctx.outputMaybe("delegation", { nodeId: "delegate" });
  const results = ctx.outputs.workerResult ?? [];
  const supervision = ctx.outputMaybe("supervision", { nodeId: "supervise" });
  const allDone = supervision?.allDone ?? false;

  return (
    <Workflow name="supervisor">
      <Sequence>
        {/* Boss plans and delegates */}
        <Task id="delegate" output={outputs.delegation} agent={boss}>
          <DelegatePrompt
            goal={ctx.input.goal}
            directory={ctx.input.directory}
            results={results}
            retriable={supervision?.retriable ?? []}
          />
        </Task>

        {/* Workers execute in parallel worktrees */}
        {delegation && (
          <Loop until={allDone} maxIterations={3} onMaxReached="return-last">
            <Sequence>
              <Parallel maxConcurrency={ctx.input.maxWorkers ?? 5}>
                {delegation.tasks.map((task) => (
                  <Worktree
                    key={task.id}
                    path={`.worktrees/${task.id}`}
                    branch={`worker/${task.id}`}
                  >
                    <Task
                      id={`worker-${task.id}`}
                      output={outputs.workerResult}
                      agent={workerAgents[task.workerType]}
                      continueOnFail
                      retries={1}
                      timeoutMs={300_000}
                    >
                      <WorkerPrompt
                        title={task.title}
                        instructions={task.instructions}
                        files={task.files}
                      />
                    </Task>
                  </Worktree>
                ))}
              </Parallel>

              {/* Boss reviews results */}
              <Task id="supervise" output={outputs.supervision} agent={boss}>
                <SupervisePrompt results={results} />
              </Task>
            </Sequence>
          </Loop>
        )}

        <Task id="final" output={outputs.final}>
          {{
            totalTasks: delegation?.tasks.length ?? 0,
            succeeded: results.filter((r) => r.status === "success").length,
            failed: results.filter((r) => r.status === "failed").length,
            iterations: ctx.outputs.supervision?.length ?? 1,
            summary: `${results.filter((r) => r.status === "success").length}/${delegation?.tasks.length ?? 0} tasks completed successfully`,
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});
