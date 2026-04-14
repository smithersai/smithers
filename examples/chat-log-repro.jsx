/**
 * Minimal repro: test chat log visibility for ClaudeCodeAgent and CodexAgent.
 * Run with: smithers up examples/chat-log-repro.jsx
 * Then check: smithers chat <run-id> --follow
 */
import { Sequence, Parallel, ClaudeCodeAgent } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit.js";
import { z } from "zod";

let CodexAgent;
try {
  ({ CodexAgent } = await import("smithers-orchestrator"));
} catch {
  // CodexAgent may not be available
}

const resultSchema = z.object({
  agent: z.string(),
  filesChanged: z.number(),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
  result: resultSchema,
});

const claude = new ClaudeCodeAgent({
  model: "claude-sonnet-4-20250514",
  systemPrompt: "You are a helpful assistant. Complete the task and report what you did.",
});

const codex = CodexAgent
  ? new CodexAgent({
      model: "gpt-5.4",
      systemPrompt: "You are a helpful assistant. Complete the task and report what you did.",
    })
  : null;

export default smithers(() => {
  return (
    <Workflow name="chat-log-repro">
      <Parallel>
        <Task id="claude-task" output={outputs.result} agent={claude} timeoutMs={120_000}>
          Create a file called /tmp/smithers-repro-claude.txt with the contents "hello from claude".
          Then read it back to confirm. Report what you did.
        </Task>
        {codex && (
          <Task id="codex-task" output={outputs.result} agent={codex} timeoutMs={120_000} noRetry continueOnFail>
            Create a file called /tmp/smithers-repro-codex.txt with the contents "hello from codex".
            Then read it back to confirm. Report what you did.
          </Task>
        )}
      </Parallel>
    </Workflow>
  );
});
