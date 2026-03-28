/**
 * <Audit> — Scan → Categorize → Process → Report.
 *
 * Pattern: Discover items needing attention → triage → act on each → summarize.
 * Use cases: security audit, dependency audit, license audit, accessibility audit,
 * dead code audit, config drift audit.
 */
import { createSmithers, Sequence, Parallel } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import ScanPrompt from "./prompts/audit/scan.mdx";
import InvestigatePrompt from "./prompts/audit/investigate.mdx";

const scanSchema = z.object({
  items: z.array(z.object({
    id: z.string(),
    category: z.string(),
    severity: z.enum(["critical", "high", "medium", "low", "info"]),
    description: z.string(),
    location: z.string(),
  })),
  totalScanned: z.number(),
});

const findingSchema = z.object({
  itemId: z.string(),
  status: z.enum(["confirmed", "false-positive", "needs-investigation"]),
  details: z.string(),
  recommendation: z.string(),
});

const reportSchema = z.object({
  totalItems: z.number(),
  critical: z.number(),
  high: z.number(),
  medium: z.number(),
  low: z.number(),
  falsePositives: z.number(),
  recommendations: z.array(z.string()),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  scan: scanSchema,
  finding: findingSchema,
  report: reportSchema,
});

const scanner = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep, bash },
  instructions: `You are a thorough auditor. Scan systematically and categorize findings
by severity. Don't miss anything but also don't over-report.`,
});

const investigator = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep, bash },
  instructions: `You are a finding investigator. For each item, determine if it's a real
issue or a false positive. Provide specific, actionable recommendations.`,
});

export default smithers((ctx) => {
  const scan = ctx.outputMaybe("scan", { nodeId: "scan" });
  const findings = ctx.outputs.finding ?? [];

  const auditType = ctx.input.auditType ?? "general";
  const auditFocus: Record<string, string> = {
    security: "vulnerabilities, injection risks, secrets, auth issues, OWASP top 10",
    dependency: "outdated packages, known CVEs, abandoned dependencies, license issues",
    "dead-code": "unused exports, unreachable code, unused variables, empty files",
    accessibility: "missing alt text, color contrast, keyboard navigation, ARIA labels",
    performance: "N+1 queries, missing indexes, unbounded queries, memory leaks",
    general: "code quality, security, performance, and maintainability issues",
  };

  return (
    <Workflow name="audit">
      <Sequence>
        <Task id="scan" output={outputs.scan} agent={scanner}>
          <ScanPrompt
            directory={ctx.input.directory}
            auditType={auditType}
            focus={auditFocus[auditType] ?? auditFocus.general}
            glob={ctx.input.glob}
          />
        </Task>

        {/* Investigate high+ severity items */}
        {scan && (
          <Parallel maxConcurrency={5}>
            {scan.items
              .filter((item) => ["critical", "high"].includes(item.severity))
              .map((item) => (
                <Task
                  key={item.id}
                  id={`investigate-${item.id}`}
                  output={outputs.finding}
                  agent={investigator}
                  continueOnFail
                >
                  <InvestigatePrompt
                    id={item.id}
                    severity={item.severity}
                    category={item.category}
                    location={item.location}
                    description={item.description}
                  />
                </Task>
              ))}
          </Parallel>
        )}

        <Task id="report" output={outputs.report}>
          {{
            totalItems: scan?.items.length ?? 0,
            critical: scan?.items.filter((i) => i.severity === "critical").length ?? 0,
            high: scan?.items.filter((i) => i.severity === "high").length ?? 0,
            medium: scan?.items.filter((i) => i.severity === "medium").length ?? 0,
            low: scan?.items.filter((i) => i.severity === "low").length ?? 0,
            falsePositives: findings.filter((f) => f.status === "false-positive").length,
            recommendations: findings
              .filter((f) => f.status === "confirmed")
              .map((f) => f.recommendation),
            summary: `Audit complete: ${scan?.items.length ?? 0} items found, ${findings.filter((f) => f.status === "confirmed").length} confirmed issues`,
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});
