// @ts-nocheck
/**
 * <FailingTestAuthor> — Given an issue or traceback, write the smallest failing test
 * before any fix is attempted.
 *
 * Pattern: Issue reader → repro/test author agent → test runner → downstream handoff.
 */
import { Sequence } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, write, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import AnalyzePrompt from "./prompts/failing-test-author/analyze.mdx";
import AuthorPrompt from "./prompts/failing-test-author/author.mdx";
import RunnerPrompt from "./prompts/failing-test-author/runner.mdx";

const analysisSchema = z.object({
  component: z.string(),
  reproSteps: z.array(z.string()),
  expectedBehavior: z.string(),
  actualBehavior: z.string(),
  summary: z.string(),
});

const testSchema = z.object({
  testPath: z.string(),
  testName: z.string(),
  assertion: z.string(),
  linesOfCode: z.number(),
  summary: z.string(),
});

const runResultSchema = z.object({
  testPath: z.string(),
  didFail: z.boolean(),
  exitCode: z.number(),
  errorOutput: z.string(),
  summary: z.string(),
});

const reportSchema = z.object({
  reproTestPath: z.string(),
  verified: z.boolean(),
  readyForFix: z.boolean(),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
  analysis: analysisSchema,
  test: testSchema,
  runResult: runResultSchema,
  report: reportSchema,
});

const issueReader = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep },
  instructions: `You are a bug triage specialist. Read the issue description and any
traceback provided, then identify the affected component, minimal reproduction steps,
and the gap between expected and actual behavior. Be precise and concise.`,
});

const testAuthor = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, write, grep },
  instructions: `You are a test engineer. Write the smallest possible failing test that
reproduces the reported bug. The test must fail for the right reason — it should assert
the expected behavior that is currently broken. Follow existing test conventions in the
codebase. Do NOT attempt to fix the bug.`,
});

const testRunner = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash },
  instructions: `Run the specified test file and report whether it fails. The test MUST
fail to confirm it captures the bug. If it passes, report that verification failed.`,
});

export default smithers((ctx) => (
  <Workflow name="failing-test-author">
    <Sequence>
      <Task id="analyze" output={outputs.analysis} agent={issueReader}>
        <AnalyzePrompt
          title={ctx.input.issue?.title}
          traceback={ctx.input.issue?.traceback}
          description={ctx.input.issue?.description}
          endpoint={ctx.input.issue?.endpoint}
        />
      </Task>

      <Task id="author-test" output={outputs.test} agent={testAuthor} deps={{ analyze: outputs.analysis }}>
        {(deps) => (
          <AuthorPrompt
            component={deps.analyze.component}
            reproSteps={deps.analyze.reproSteps}
            expectedBehavior={deps.analyze.expectedBehavior}
            actualBehavior={deps.analyze.actualBehavior}
            testDir={ctx.input.testDir ?? "tests"}
          />
        )}
      </Task>

      <Task
        id="run-test"
        output={outputs.runResult}
        agent={testRunner}
        deps={{ author: outputs.test }}
        needs={{ author: "author-test" }}
      >
        {(deps) => (
          <RunnerPrompt
            testPath={deps.author.testPath}
            testCmd={ctx.input.testCmd ?? "npx vitest run"}
          />
        )}
      </Task>

      <Task
        id="report"
        output={outputs.report}
        deps={{ author: outputs.test, run: outputs.runResult }}
        needs={{ author: "author-test", run: "run-test" }}
      >
        {(deps) => ({
          reproTestPath: deps.author.testPath,
          verified: deps.run.didFail,
          readyForFix: deps.run.didFail,
          summary: deps.run.didFail
            ? `Verified failing test at ${deps.author.testPath} — ready for fix`
            : "Test did not fail as expected — repro may be incomplete",
        })}
      </Task>
    </Sequence>
  </Workflow>
));
