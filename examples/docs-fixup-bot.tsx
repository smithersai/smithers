// @ts-nocheck
/**
 * <DocsFixupBot> — Scan docs for broken examples or drift and propose targeted
 * fixes with validation.
 *
 * Pattern: docs scanner -> repair agent -> verifier -> PR.
 * Use cases: broken code snippets, outdated imports, stale CLI examples, dead links.
 */
import { createSmithers, Sequence, Parallel } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { bash, read, write, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import ScanDocsPrompt from "./prompts/docs-fixup-bot/scan-docs.mdx";
import RepairPrompt from "./prompts/docs-fixup-bot/repair.mdx";
import VerifyPrompt from "./prompts/docs-fixup-bot/verify.mdx";
import OpenPRPrompt from "./prompts/docs-fixup-bot/open-pr.mdx";

// ── Schemas ──────────────────────────────────────────────────────────────────

const brokenExampleSchema = z.object({
  docPath: z.string(),
  lineRange: z.object({ start: z.number(), end: z.number() }),
  language: z.string(),
  snippet: z.string(),
  error: z.string(),
  category: z.enum(["import", "api", "cli", "syntax", "dead-link", "other"]),
});

const scanSchema = z.object({
  brokenExamples: z.array(brokenExampleSchema),
  totalDocsScanned: z.number(),
  totalBroken: z.number(),
  summary: z.string(),
});

const repairSchema = z.object({
  fixes: z.array(
    z.object({
      docPath: z.string(),
      original: z.string(),
      fixed: z.string(),
      explanation: z.string(),
    }),
  ),
  filesChanged: z.array(z.string()),
  skipped: z.array(
    z.object({
      docPath: z.string(),
      reason: z.string(),
    }),
  ),
  summary: z.string(),
});

const verifySchema = z.object({
  allPassing: z.boolean(),
  results: z.array(
    z.object({
      docPath: z.string(),
      passed: z.boolean(),
      issues: z.array(z.string()),
    }),
  ),
  regressions: z.array(z.string()),
  summary: z.string(),
});

const prSchema = z.object({
  prNumber: z.number().optional(),
  prUrl: z.string().optional(),
  branch: z.string(),
  title: z.string(),
  filesChanged: z.array(z.string()),
  created: z.boolean(),
  summary: z.string(),
});

// ── Smithers setup ───────────────────────────────────────────────────────────

const { Workflow, Task, smithers, outputs } = createSmithers({
  scan: scanSchema,
  repair: repairSchema,
  verify: verifySchema,
  pr: prSchema,
});

// ── Agents ───────────────────────────────────────────────────────────────────

const scanner = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, read, grep },
  instructions: `You scan documentation files for broken code examples and drift.
For each doc file, extract fenced code blocks and validate them: check imports resolve,
API calls match current signatures, CLI flags exist, and links are not dead. Report
every broken example with its location, language, and the specific error.`,
});

const repairAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, write, grep },
  instructions: `You repair broken documentation examples. For each broken snippet,
look up the correct current API, import path, or CLI usage in the source code and
rewrite the example to be valid. Preserve surrounding prose and formatting. Skip
any example you cannot confidently fix and explain why.`,
});

const verifier = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You verify that repaired documentation examples are correct. For code
snippets, attempt to type-check or syntax-check them. For CLI examples, confirm the
flags and subcommands exist. For links, verify targets resolve. Report any regressions
introduced by the repair step.`,
});

const prOpener = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash },
  instructions: `You open a PR with the fixed documentation. Create a branch, stage
all changed doc files, commit with a descriptive message listing every fix, push, and
open a PR via the gh CLI. The PR body should include a table of fixed examples.`,
});

// ── Workflow ─────────────────────────────────────────────────────────────────

export default smithers((ctx) => {
  const scan = ctx.outputMaybe("scan", { nodeId: "scan-docs" });
  const repair = ctx.outputMaybe("repair", { nodeId: "repair" });
  const verification = ctx.outputMaybe("verify", { nodeId: "verify" });

  return (
    <Workflow name="docs-fixup-bot">
      <Sequence>
        {/* ═══ SCAN: find broken examples across all docs ═══ */}
        <Task id="scan-docs" output={outputs.scan} agent={scanner}>
          <ScanDocsPrompt
            docGlobs={ctx.input.docGlobs ?? ["docs/**/*.mdx", "docs/**/*.md"]}
            srcGlobs={ctx.input.srcGlobs ?? ["src/**/*.ts", "src/**/*.tsx"]}
            categories={ctx.input.categories ?? ["import", "api", "cli", "syntax", "dead-link"]}
          />
        </Task>

        {/* ═══ REPAIR: fix each broken example ═══ */}
        <Task id="repair" output={outputs.repair} agent={repairAgent}>
          <RepairPrompt
            brokenExamples={scan?.brokenExamples ?? []}
            totalBroken={scan?.totalBroken ?? 0}
          />
        </Task>

        {/* ═══ VERIFY + PR: validate fixes then open PR in parallel ═══ */}
        <Parallel>
          <Task id="verify" output={outputs.verify} agent={verifier}>
            <VerifyPrompt
              fixes={repair?.fixes ?? []}
              filesChanged={repair?.filesChanged ?? []}
            />
          </Task>

          <Task id="open-pr" output={outputs.pr} agent={prOpener}>
            <OpenPRPrompt
              filesChanged={repair?.filesChanged ?? []}
              summary={repair?.summary ?? ""}
              totalFixed={repair?.fixes?.length ?? 0}
              skipped={repair?.skipped ?? []}
              repo={ctx.input.repo}
              dryRun={ctx.input.dryRun ?? false}
            />
          </Task>
        </Parallel>
      </Sequence>
    </Workflow>
  );
});
