// @ts-nocheck
/**
 * <ReproHarnessBuilder> — Build a minimal Docker/harness repro from an issue,
 * stack trace, or bug report so later steps run in a reproducible environment.
 *
 * Shape: issue reader → environment planner → Docker/code tool executor → repro validator.
 * Use cases: bug triage, pre-fix environment setup, CI reproduction pipelines.
 */
import { createSmithers, Sequence } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep, write } from "smithers-orchestrator/tools";
import { z } from "zod";
import AnalyzePrompt from "./prompts/repro-harness-builder/analyze.mdx";
import PlanPrompt from "./prompts/repro-harness-builder/plan.mdx";
import BuildPrompt from "./prompts/repro-harness-builder/build.mdx";
import ValidatePrompt from "./prompts/repro-harness-builder/validate.mdx";

const analysisSchema = z.object({
  title: z.string().describe("Short title summarising the bug"),
  language: z.string().describe("Primary language/runtime involved"),
  dependencies: z.array(z.string()).describe("Key packages or system deps mentioned"),
  errorSignature: z.string().describe("Core error message or stack trace head"),
  minimalSteps: z.array(z.string()).describe("Ordered steps to trigger the bug"),
  summary: z.string(),
});

const environmentSchema = z.object({
  baseImage: z.string().describe("Docker base image, e.g. node:20-alpine"),
  dockerfile: z.string().describe("Full Dockerfile content"),
  reproScript: z.string().describe("Entrypoint script that triggers the bug"),
  reproFiles: z.array(z.object({
    path: z.string(),
    content: z.string(),
  })).describe("Additional fixture files needed for repro"),
  runCommand: z.string().describe("docker run command to execute the repro"),
  summary: z.string(),
});

const validationSchema = z.object({
  reproduced: z.boolean().describe("Whether the bug was successfully reproduced"),
  exitCode: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  artifact: z.string().describe("Docker image or tarball identifier"),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  analysis: analysisSchema,
  environment: environmentSchema,
  validation: validationSchema,
});

const issueAnalyzer = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep },
  instructions: `You are an issue analyst. Given a bug report, stack trace, or issue description,
extract the essential reproduction details: language, dependencies, error signature, and minimal
steps to trigger the bug. Be precise — downstream agents rely on your output to build a working harness.`,
});

const environmentBuilder = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, write, read },
  instructions: `You are an environment builder. Given an issue analysis, produce a minimal Dockerfile,
repro script, and any fixture files needed to reproduce the bug in an isolated container.
Keep the image small — use alpine bases where possible. The repro script should exit non-zero
when the bug is present so validation can check the exit code.`,
});

const reproValidator = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, read, grep },
  instructions: `You are a repro validator. Build the Docker image from the generated Dockerfile,
run the repro command, and verify the bug manifests. Capture stdout, stderr, and exit code.
Report whether reproduction succeeded. Do not attempt to fix the bug.`,
});

export default smithers((ctx) => {
  const analysis = ctx.outputMaybe("analysis", { nodeId: "analyze" });
  const environment = ctx.outputMaybe("environment", { nodeId: "build" });

  return (
    <Workflow name="repro-harness-builder">
      <Sequence>
        {/* Phase 1: Issue analyzer — extract reproduction essentials */}
        <Task id="analyze" output={outputs.analysis} agent={issueAnalyzer}>
          <AnalyzePrompt
            issue={ctx.input.issue}
            stackTrace={ctx.input.stackTrace}
            language={ctx.input.language}
          />
        </Task>

        {/* Phase 2: Environment builder — create Dockerfile and repro script */}
        <Task id="build" output={outputs.environment} agent={environmentBuilder}>
          <PlanPrompt
            analysis={analysis}
            language={analysis?.language ?? ctx.input.language ?? "node"}
            dependencies={analysis?.dependencies ?? []}
            minimalSteps={analysis?.minimalSteps ?? []}
          />
        </Task>

        {/* Phase 3: Docker/code tool executor — build and run the container */}
        <Task id="validate" output={outputs.validation} agent={reproValidator}>
          <ValidatePrompt
            dockerfile={environment?.dockerfile ?? ""}
            runCommand={environment?.runCommand ?? "docker run --rm repro-harness"}
            reproScript={environment?.reproScript ?? ""}
            expectedError={analysis?.errorSignature ?? ""}
          />
        </Task>
      </Sequence>
    </Workflow>
  );
});
