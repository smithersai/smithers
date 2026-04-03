/**
 * <Refactor> — Analyze → Plan refactor → Apply changes → Validate.
 *
 * Pattern: Static analysis → targeted refactoring → verification.
 * Use cases: rename across codebase, extract interfaces, convert patterns,
 * modernize syntax, split files, consolidate duplicates.
 */
import { Sequence, Parallel } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, write, edit, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import AnalyzePrompt from "./prompts/refactor/analyze.mdx";
import RefactorPrompt from "./prompts/refactor/refactor.mdx";
import VerifyPrompt from "./prompts/refactor/verify.mdx";

const analysisSchema = z.object({
  targets: z.array(z.object({
    file: z.string(),
    pattern: z.string(),
    occurrences: z.number(),
    complexity: z.enum(["simple", "moderate", "complex"]),
  })),
  totalOccurrences: z.number(),
  estimatedImpact: z.string(),
});

const changeSchema = z.object({
  file: z.string(),
  status: z.enum(["refactored", "skipped", "failed"]),
  changes: z.string(),
  linesChanged: z.number(),
});

const verifySchema = z.object({
  typecheck: z.boolean(),
  tests: z.boolean(),
  lint: z.boolean(),
  errors: z.array(z.string()),
  passed: z.boolean(),
});

const summarySchema = z.object({
  totalTargets: z.number(),
  refactored: z.number(),
  skipped: z.number(),
  failed: z.number(),
  verified: z.boolean(),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
  analysis: analysisSchema,
  change: changeSchema,
  verify: verifySchema,
  summary: summarySchema,
});

const analyzer = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep, bash },
  instructions: `You are a static analysis agent. Find all occurrences of the pattern
that needs refactoring. Be thorough — don't miss any.`,
});

const refactorer = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, edit, grep },
  instructions: `You are a refactoring agent. Apply the specified refactoring to the given file.
Make precise, minimal changes. Preserve behavior exactly. Don't change formatting
of lines you're not refactoring.`,
});

const verifier = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash },
  instructions: `You are a verification agent. Run typecheck, tests, and lint to ensure
the refactoring didn't break anything.`,
});

export default smithers((ctx) => {
  const analysis = ctx.outputMaybe("analysis", { nodeId: "analyze" });
  const changes = ctx.outputs.change ?? [];
  const verification = ctx.outputMaybe("verify", { nodeId: "verify" });

  return (
    <Workflow name="refactor">
      <Sequence>
        <Task id="analyze" output={outputs.analysis} agent={analyzer}>
          <AnalyzePrompt
            directory={ctx.input.directory}
            pattern={ctx.input.pattern}
            refactoring={ctx.input.refactoring}
            example={ctx.input.example ?? "N/A"}
          />
        </Task>

        {analysis && (
          <Parallel maxConcurrency={5}>
            {analysis.targets.map((target) => (
              <Task
                key={target.file}
                id={`refactor-${target.file.replace(/\//g, "-")}`}
                output={outputs.change}
                agent={refactorer}
                continueOnFail
              >
                <RefactorPrompt
                  file={target.file}
                  pattern={target.pattern}
                  occurrences={target.occurrences}
                  refactoring={ctx.input.refactoring}
                  example={ctx.input.example}
                />
              </Task>
            ))}
          </Parallel>
        )}

        {changes.length > 0 && (
          <Task id="verify" output={outputs.verify} agent={verifier}>
            <VerifyPrompt
              directory={ctx.input.directory}
              typecheckCmd={ctx.input.typecheckCmd ?? "npx tsc --noEmit"}
              testCmd={ctx.input.testCmd ?? "npm test"}
              lintCmd={ctx.input.lintCmd ?? "npx eslint ."}
            />
          </Task>
        )}

        <Task id="summary" output={outputs.summary}>
          {{
            totalTargets: analysis?.targets.length ?? 0,
            refactored: changes.filter((c) => c.status === "refactored").length,
            skipped: changes.filter((c) => c.status === "skipped").length,
            failed: changes.filter((c) => c.status === "failed").length,
            verified: verification?.passed ?? false,
            summary: `Refactored ${changes.filter((c) => c.status === "refactored").length}/${analysis?.targets.length ?? 0} files. Verification: ${verification?.passed ? "passed" : "pending/failed"}`,
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});
