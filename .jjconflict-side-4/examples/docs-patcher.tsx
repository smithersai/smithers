// @ts-nocheck
/**
 * <DocsPatcher> — Detect public API / CLI changes, patch affected docs, verify
 * correctness, and open a follow-up PR or checklist.
 *
 * Pattern: contract/diff detector -> docs patch agent -> verifier -> PR creator.
 * Use cases: API migration docs, CLI flag renames, SDK changelog snippets, README sync.
 */
import { Sequence, Parallel } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { bash, read, write, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import DetectDriftPrompt from "./prompts/docs-patcher/detect-drift.mdx";
import PatchDocsPrompt from "./prompts/docs-patcher/patch-docs.mdx";
import VerifyPrompt from "./prompts/docs-patcher/verify.mdx";
import CreatePRPrompt from "./prompts/docs-patcher/create-pr.mdx";

// ── Schemas ──────────────────────────────────────────────────────────────────

const surfaceChangeSchema = z.object({
  kind: z.enum(["api", "cli", "sdk", "config"]),
  name: z.string(),
  before: z.string(),
  after: z.string(),
  file: z.string(),
});

const driftSchema = z.object({
  changes: z.array(surfaceChangeSchema),
  affectedDocs: z.array(
    z.object({
      path: z.string(),
      reason: z.string(),
      staleSnippets: z.array(z.string()),
    }),
  ),
  severity: z.enum(["breaking", "notable", "minor"]),
  summary: z.string(),
});

const patchSchema = z.object({
  patches: z.array(
    z.object({
      docPath: z.string(),
      hunks: z.array(
        z.object({
          before: z.string(),
          after: z.string(),
        }),
      ),
    }),
  ),
  filesChanged: z.array(z.string()),
  summary: z.string(),
});

const verifySchema = z.object({
  allValid: z.boolean(),
  results: z.array(
    z.object({
      docPath: z.string(),
      valid: z.boolean(),
      issues: z.array(z.string()),
    }),
  ),
  brokenLinks: z.array(z.string()),
  staleReferences: z.array(z.string()),
});

const prSchema = z.object({
  prNumber: z.number().optional(),
  prUrl: z.string().optional(),
  branch: z.string(),
  title: z.string(),
  checklist: z.array(z.string()),
  created: z.boolean(),
  summary: z.string(),
});

// ── Smithers setup ───────────────────────────────────────────────────────────

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
  drift: driftSchema,
  patch: patchSchema,
  verify: verifySchema,
  pr: prSchema,
});

// ── Agents ───────────────────────────────────────────────────────────────────

const driftDetector = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, read, grep },
  instructions: `You detect public API and CLI surface changes. Diff the current branch
against the base, identify renamed flags, changed endpoints, altered SDK signatures,
and modified config shapes. For each change, find every doc file that references the
old surface and flag it as stale.`,
});

const patchAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, write, grep },
  instructions: `You patch documentation files to reflect API/CLI changes. For each
affected doc, locate stale snippets and rewrite them to match the new surface. Preserve
surrounding prose, formatting, and frontmatter. Never invent features that do not exist
in the diff — only update what actually changed.`,
});

const verifier = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You verify patched docs for correctness. Check that every updated snippet
matches the actual new API surface. Look for broken internal links, stale cross-references,
and inconsistencies between code examples and the real implementation. Report any issues.`,
});

const prCreator = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash },
  instructions: `You create a follow-up PR with the patched documentation. Stage all
changed doc files, create a well-titled branch, commit with a clear message, push, and
open a PR using the gh CLI. Include a checklist of every doc file changed and why.`,
});

// ── Workflow ─────────────────────────────────────────────────────────────────

export default smithers((ctx) => {
  const drift = ctx.outputMaybe("drift", { nodeId: "detect-drift" });
  const patch = ctx.outputMaybe("patch", { nodeId: "patch-docs" });
  const verification = ctx.outputMaybe("verify", { nodeId: "verify" });

  return (
    <Workflow name="docs-patcher">
      <Sequence>
        {/* ═══ DETECT: find public surface changes and stale docs ═══ */}
        <Task id="detect-drift" output={outputs.drift} agent={driftDetector}>
          <DetectDriftPrompt
            baseBranch={ctx.input.baseBranch ?? "main"}
            docGlobs={ctx.input.docGlobs ?? ["docs/**/*.mdx", "README.md"]}
            scope={ctx.input.scope ?? "all"}
          />
        </Task>

        {/* ═══ PATCH: rewrite stale snippets in affected docs ═══ */}
        <Task id="patch-docs" output={outputs.patch} agent={patchAgent}>
          <PatchDocsPrompt
            changes={drift?.changes ?? []}
            affectedDocs={drift?.affectedDocs ?? []}
            severity={drift?.severity ?? "minor"}
          />
        </Task>

        {/* ═══ VERIFY + PR: validate patches then open follow-up PR in parallel ═══ */}
        <Parallel>
          <Task id="verify" output={outputs.verify} agent={verifier}>
            <VerifyPrompt
              patches={patch?.patches ?? []}
              filesChanged={patch?.filesChanged ?? []}
              baseBranch={ctx.input.baseBranch ?? "main"}
            />
          </Task>

          <Task id="create-pr" output={outputs.pr} agent={prCreator}>
            <CreatePRPrompt
              filesChanged={patch?.filesChanged ?? []}
              summary={patch?.summary ?? ""}
              severity={drift?.severity ?? "minor"}
              repo={ctx.input.repo}
              dryRun={ctx.input.dryRun ?? false}
            />
          </Task>
        </Parallel>
      </Sequence>
    </Workflow>
  );
});
