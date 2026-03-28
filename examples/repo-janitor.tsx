// @ts-nocheck
/**
 * <RepoJanitor> — Run on a schedule to clean warnings, stale TODOs, broken examples,
 * low-risk formatting, and docs inconsistencies.
 *
 * Pattern: scheduler → scanner commands → maintenance agent → PR creator.
 * Use cases: scheduled repo hygiene, automated cleanup PRs, maintenance backlog reduction.
 */
import { createSmithers, Sequence, Parallel } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep, write } from "smithers-orchestrator/tools";
import { z } from "zod";
import ScanPrompt from "./prompts/repo-janitor/scan.mdx";
import FixWarningsPrompt from "./prompts/repo-janitor/fix-warnings.mdx";
import FixTodosPrompt from "./prompts/repo-janitor/fix-todos.mdx";
import FixExamplesPrompt from "./prompts/repo-janitor/fix-examples.mdx";
import FixFormattingPrompt from "./prompts/repo-janitor/fix-formatting.mdx";
import FixDocsPrompt from "./prompts/repo-janitor/fix-docs.mdx";
import SummarizePrompt from "./prompts/repo-janitor/summarize.mdx";

const scanResultSchema = z.object({
  category: z.enum(["warnings", "stale-todos", "broken-examples", "formatting", "docs"]),
  items: z.array(z.object({
    file: z.string(),
    line: z.number().optional(),
    description: z.string(),
    severity: z.enum(["low", "medium"]),
  })),
  count: z.number(),
});

const fixResultSchema = z.object({
  category: z.string(),
  filesChanged: z.array(z.string()),
  fixCount: z.number(),
  skipped: z.array(z.object({
    file: z.string(),
    reason: z.string(),
  })),
  summary: z.string(),
});

const prSummarySchema = z.object({
  title: z.string(),
  body: z.string(),
  totalFixes: z.number(),
  categories: z.array(z.string()),
  filesChanged: z.array(z.string()),
  riskLevel: z.enum(["low", "medium"]),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  scanResult: scanResultSchema,
  fixResult: fixResultSchema,
  prSummary: prSummarySchema,
});

const scanner = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, grep, read },
  instructions: `You are a repo scanner. Identify maintenance items in the codebase without
making any changes. Look for compiler warnings, stale TODOs, broken examples, formatting
inconsistencies, and docs drift. Be precise about file paths and line numbers.`,
});

const maintenanceAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, write, bash, grep },
  instructions: `You are a maintenance agent. Apply low-risk, mechanical fixes to the codebase.
Never change logic or public APIs. Stick to safe transformations: removing dead imports,
updating stale comments, fixing broken links, normalizing formatting. If a fix feels risky, skip it.`,
});

const prCreator = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash },
  instructions: `You are a PR author. Create a well-structured pull request summarizing
all maintenance work performed. Use conventional commit style. Group changes by category.`,
});

export default smithers((ctx) => {
  const scanResults = ctx.outputs.scanResult ?? [];
  const fixResults = ctx.outputs.fixResult ?? [];
  const allFilesChanged = fixResults.flatMap((r) => r.filesChanged);
  const totalFixes = fixResults.reduce((sum, r) => sum + r.fixCount, 0);

  return (
    <Workflow name="repo-janitor">
      <Sequence>
        {/* Phase 1: Scan the repo for maintenance items across all categories */}
        <Task id="scan" output={outputs.scanResult} agent={scanner}>
          <ScanPrompt
            repoRoot={ctx.input.repoRoot ?? "."}
            categories={["warnings", "stale-todos", "broken-examples", "formatting", "docs"]}
            maxItemsPerCategory={ctx.input.maxItemsPerCategory ?? 20}
          />
        </Task>

        {/* Phase 2: Fix each category in parallel */}
        <Parallel maxConcurrency={3}>
          <Task
            id="fix-warnings"
            output={outputs.fixResult}
            agent={maintenanceAgent}
            skipIf={!scanResults.some((r) => r.category === "warnings" && r.count > 0)}
          >
            <FixWarningsPrompt
              items={scanResults.find((r) => r.category === "warnings")?.items ?? []}
            />
          </Task>

          <Task
            id="fix-todos"
            output={outputs.fixResult}
            agent={maintenanceAgent}
            skipIf={!scanResults.some((r) => r.category === "stale-todos" && r.count > 0)}
          >
            <FixTodosPrompt
              items={scanResults.find((r) => r.category === "stale-todos")?.items ?? []}
            />
          </Task>

          <Task
            id="fix-examples"
            output={outputs.fixResult}
            agent={maintenanceAgent}
            skipIf={!scanResults.some((r) => r.category === "broken-examples" && r.count > 0)}
          >
            <FixExamplesPrompt
              items={scanResults.find((r) => r.category === "broken-examples")?.items ?? []}
            />
          </Task>

          <Task
            id="fix-formatting"
            output={outputs.fixResult}
            agent={maintenanceAgent}
            skipIf={!scanResults.some((r) => r.category === "formatting" && r.count > 0)}
          >
            <FixFormattingPrompt
              items={scanResults.find((r) => r.category === "formatting")?.items ?? []}
            />
          </Task>

          <Task
            id="fix-docs"
            output={outputs.fixResult}
            agent={maintenanceAgent}
            skipIf={!scanResults.some((r) => r.category === "docs" && r.count > 0)}
          >
            <FixDocsPrompt
              items={scanResults.find((r) => r.category === "docs")?.items ?? []}
            />
          </Task>
        </Parallel>

        {/* Phase 3: Create a PR summarizing all fixes */}
        <Task id="pr-summary-generated" output={outputs.prSummary} agent={prCreator} skipIf={totalFixes === 0}>
          <SummarizePrompt
            fixResults={fixResults}
            totalFixes={totalFixes}
            filesChanged={allFilesChanged}
            categories={fixResults.map((r) => r.category)}
          />
        </Task>

        {/* Fallback: nothing to fix */}
        <Task id="pr-summary-empty" output={outputs.prSummary} skipIf={totalFixes > 0}>
          {{
            title: "chore: repo janitor — no fixes needed",
            body: "Scanned the repository and found no actionable maintenance items.",
            totalFixes: 0,
            categories: [],
            filesChanged: [],
            riskLevel: "low",
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});
