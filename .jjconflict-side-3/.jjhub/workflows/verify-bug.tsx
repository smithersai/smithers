/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Sequence, Task, Workflow } from "smithers-orchestrator";
import { ClaudeCodeAgent, CodexAgent } from "smithers-orchestrator";
import { z } from "zod";

const REPO_ROOT = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const UNSAFE = process.env.SMITHERS_UNSAFE === "1";

const claude = new ClaudeCodeAgent({
  model: process.env.CLAUDE_MODEL ?? "claude-opus-4-6",
  systemPrompt: "You are a senior engineer investigating bugs in the codebase.",
  addDir: [REPO_ROOT],
  dangerouslySkipPermissions: UNSAFE,
  timeoutMs: 30 * 60 * 1000,
});

const codex = new CodexAgent({
  model: process.env.CODEX_MODEL ?? "gpt-5.3-codex",
  systemPrompt: "You are a senior SDET writing reproducing tests for reported bugs.",
  addDir: [REPO_ROOT],
  yolo: UNSAFE,
  timeoutMs: 30 * 60 * 1000,
  config: { model_reasoning_effort: "high" },
});

const ResearchSchema = z.object({
  summary: z.string().describe("Summary of the bug"),
  suspectFiles: z.array(z.string()).describe("Files that likely contain the bug"),
  reproductionSteps: z.array(z.string()).describe("Steps to reproduce the bug manually"),
});

const ReproduceSchema = z.object({
  testFile: z.string().describe("Path to the test file created or modified"),
  testFails: z.boolean().describe("Whether the test successfully failed as expected"),
  testOutput: z.string().describe("Output of the test run"),
  rootCause: z.string().describe("The diagnosed root cause of the bug"),
});

const { smithers, outputs, tables } = createSmithers({
  research: ResearchSchema,
  reproduce: ReproduceSchema,
}, {
  dbPath: `${process.env.HOME}/.cache/smithers/verify-bug.db`,
});

export default smithers((ctx) => {
  const research = ctx.latest(tables.research, "research");

  return (
    <Workflow name="verify-bug">
      <Sequence>
        <Task id="research" output={outputs.research} agent={claude} timeoutMs={15 * 60 * 1000}>
          {`Investigate the bug report:
Title: ${ctx.input.issueTitle}
Body: ${ctx.input.issueBody}

Search the codebase to find the likely root cause.
Return a JSON object with 'summary', 'suspectFiles', and 'reproductionSteps'.`}
        </Task>

        {research ? (
          <Task id="reproduce" output={outputs.reproduce} agent={codex} timeoutMs={20 * 60 * 1000}>
            {`Write a failing test case for the bug based on the research.
Research summary: ${research.summary}
Suspect files: ${research.suspectFiles.join(", ")}

Write the test, run it, and verify that it actually fails with the reported bug.
Return JSON with 'testFile', 'testFails' (boolean), 'testOutput' (string), and 'rootCause' (string).`}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
