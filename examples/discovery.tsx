/**
 * <Discovery> — Scan a codebase/directory/API, categorize findings, store structured results.
 *
 * Pattern: Agent scans → structured categorization → stored to schema table.
 * Use cases: file audits, dependency scans, API endpoint discovery, dead code detection.
 */
import { createSmithers, Sequence } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import ScanPrompt from "./prompts/discovery/scan.mdx";

const findingSchema = z.object({
  category: z.enum(["bug", "tech-debt", "security", "performance", "style"]),
  severity: z.enum(["critical", "high", "medium", "low"]),
  file: z.string(),
  line: z.number().optional(),
  description: z.string(),
  suggestion: z.string(),
});

const discoverySchema = z.object({
  findings: z.array(findingSchema),
  summary: z.string(),
  totalFiles: z.number(),
  scannedAt: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  discovery: discoverySchema,
});

const scanner = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep, bash },
  instructions: `You are a codebase scanner. Thoroughly explore the target directory,
categorize everything you find, and output structured findings.
Be systematic: list files, check for common issues, categorize by severity.`,
});

export default smithers((ctx) => (
  <Workflow name="discovery">
    <Task id="scan" output={outputs.discovery} agent={scanner}>
      <ScanPrompt
        directory={ctx.input.directory}
        focus={ctx.input.focus}
        glob={ctx.input.glob}
      />
    </Task>
  </Workflow>
));
