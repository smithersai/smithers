// @ts-nocheck
/**
 * <Scaffold> — Generate project/feature structure from a template or spec.
 *
 * Pattern: Read spec → plan structure → generate files → verify.
 * Use cases: new project setup, feature scaffolding, component generation,
 * API endpoint generation, test file generation.
 */
import { Sequence, Parallel } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, write, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import BlueprintPrompt from "./prompts/scaffold/blueprint.mdx";
import GeneratePrompt from "./prompts/scaffold/generate.mdx";
import VerifyPrompt from "./prompts/scaffold/verify.mdx";

const blueprintSchema = z.object({
  files: z.array(z.object({
    path: z.string(),
    type: z.enum(["component", "test", "config", "types", "util", "route", "style"]),
    description: z.string(),
    template: z.string().optional(),
  })),
  directories: z.array(z.string()),
  totalFiles: z.number(),
});

const fileGenSchema = z.object({
  path: z.string(),
  created: z.boolean(),
  linesOfCode: z.number(),
  summary: z.string(),
});

const verifySchema = z.object({
  typecheck: z.boolean(),
  compiles: z.boolean(),
  errors: z.array(z.string()),
});

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
  blueprint: blueprintSchema,
  fileGen: fileGenSchema,
  verify: verifySchema,
});

const architect = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep },
  instructions: `You are a software architect. Analyze existing patterns in the codebase
and design a file structure that matches the project's conventions. List every file
that needs to be created with its purpose.`,
});

const generator = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, write, grep },
  instructions: `You are a code generator. Create the specified file following the project's
existing patterns and conventions. Match the style of surrounding code.`,
});

const verifier = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash },
  instructions: `Verify the generated files compile and type-check correctly.`,
});

export default smithers((ctx) => {
  const blueprint = ctx.outputMaybe("blueprint", { nodeId: "blueprint" });
  const generated = ctx.outputs.fileGen ?? [];

  return (
    <Workflow name="scaffold">
      <Sequence>
        <Task id="blueprint" output={outputs.blueprint} agent={architect}>
          <BlueprintPrompt
            feature={ctx.input.feature}
            type={ctx.input.type ?? "feature"}
            directory={ctx.input.directory}
            spec={ctx.input.spec}
          />
        </Task>

        {blueprint && (
          <Parallel maxConcurrency={5}>
            {blueprint.files.map((file) => (
              <Task
                key={file.path}
                id={`gen-${file.path.replace(/\//g, "-")}`}
                output={outputs.fileGen}
                agent={generator}
                continueOnFail
              >
                <GeneratePrompt
                  path={file.path}
                  type={file.type}
                  description={file.description}
                  template={file.template}
                  directory={ctx.input.directory}
                />
              </Task>
            ))}
          </Parallel>
        )}

        {generated.length > 0 && (
          <Task id="verify" output={outputs.verify} agent={verifier}>
            <VerifyPrompt
              directory={ctx.input.directory}
              verifyCmd={ctx.input.verifyCmd ?? "npx tsc --noEmit"}
            />
          </Task>
        )}
      </Sequence>
    </Workflow>
  );
});
