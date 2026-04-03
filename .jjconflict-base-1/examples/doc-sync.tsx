/**
 * <DocSync> — Compare docs to code → find discrepancies → fix → PR.
 *
 * Pattern: Audit docs against source of truth → auto-fix → open PR.
 * Use cases: API docs sync, README updates, changelog generation, JSDoc sync.
 */
import { Sequence, Parallel } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, write, edit, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import AuditPrompt from "./prompts/doc-sync/audit.mdx";
import FixPrompt from "./prompts/doc-sync/fix.mdx";
import PrPrompt from "./prompts/doc-sync/pr.mdx";

const auditSchema = z.object({
  discrepancies: z.array(z.object({
    docFile: z.string(),
    codeFile: z.string(),
    issue: z.enum(["outdated-api", "missing-param", "wrong-example", "missing-doc", "stale-reference"]),
    description: z.string(),
    severity: z.enum(["critical", "warning", "info"]),
  })),
  totalDocsChecked: z.number(),
});

const fixSchema = z.object({
  file: z.string(),
  changes: z.string(),
  status: z.enum(["fixed", "needs-human", "skipped"]),
});

const prSchema = z.object({
  branch: z.string(),
  prUrl: z.string().optional(),
  filesChanged: z.number(),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
  audit: auditSchema,
  fix: fixSchema,
  pr: prSchema,
});

const auditor = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep, bash },
  instructions: `You are a docs auditor. Compare documentation files against the actual
source code. Check that API signatures, parameter names, return types, and examples
all match the current implementation. Be thorough and precise.`,
});

const fixer = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, edit },
  instructions: `You are a technical writer. Fix documentation to match the actual code.
Preserve the existing style and tone. Only fix factual inaccuracies — don't rewrite
for style. Make minimal, surgical edits.`,
});

const prAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash },
  instructions: `You are a git/GitHub agent. Create a branch, commit changes, and open a PR.
Write clear commit messages and PR descriptions.`,
});

export default smithers((ctx) => {
  const audit = ctx.outputMaybe("audit", { nodeId: "audit" });
  const fixes = ctx.outputs.fix ?? [];
  const fixableDiscrepancies = audit?.discrepancies?.filter((d) => d.severity !== "info") ?? [];
  const fixedFiles = fixes.filter((f) => f.status === "fixed").map((f) => f.file);
  const branchName = `docs/auto-sync-${Date.now()}`;

  return (
    <Workflow name="doc-sync">
      <Sequence>
        <Task id="audit" output={outputs.audit} agent={auditor}>
          <AuditPrompt
            docsDir={ctx.input.docsDir ?? "docs/"}
            srcDir={ctx.input.srcDir ?? "src/"}
            format={ctx.input.format ?? "mdx"}
          />
        </Task>

        {/* Fix discrepancies in parallel */}
        {fixableDiscrepancies.length > 0 && (
          <Parallel maxConcurrency={3}>
            {fixableDiscrepancies.map((d, i) => (
              <Task
                key={`${d.docFile}-${i}`}
                id={`fix-${i}`}
                output={outputs.fix}
                agent={fixer}
                continueOnFail
              >
                <FixPrompt
                  docFile={d.docFile}
                  issue={d.issue}
                  description={d.description}
                  codeFile={d.codeFile}
                />
              </Task>
            ))}
          </Parallel>
        )}

        {/* Open PR if fixes were made */}
        <Task
          id="pr"
          output={outputs.pr}
          agent={prAgent}
          skipIf={fixedFiles.length === 0}
        >
          <PrPrompt
            branchName={branchName}
            fixedFiles={fixedFiles}
            fixedCount={fixedFiles.length}
          />
        </Task>
      </Sequence>
    </Workflow>
  );
});
