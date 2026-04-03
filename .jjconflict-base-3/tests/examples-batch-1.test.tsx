/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import {
  Workflow,
  Task,
  Sequence,
  Parallel,
  Branch,
  Loop,
  Ralph,
  runWorkflow,
} from "../src/index";
import { createTestSmithers } from "./helpers";
import { z } from "zod";

// ============================================================
// 1. alert-suppressor
// ============================================================
describe("alert-suppressor", () => {
  test("full pipeline: dedupe → context → classify → dispatch → summary", async () => {
    const dedupeResultSchema = z.object({
      uniqueAlerts: z.array(z.object({ id: z.string(), source: z.string(), severity: z.enum(["critical", "high", "medium", "low"]), message: z.string(), timestamp: z.string(), labels: z.string() })),
      suppressedCount: z.number(),
      suppressedIds: z.array(z.string()),
    });
    const contextSchema = z.object({
      recentIncidents: z.array(z.object({ id: z.string(), title: z.string(), status: z.enum(["open", "mitigated", "resolved"]), relatedAlertPatterns: z.array(z.string()) })),
      noiseRules: z.array(z.object({ pattern: z.string(), reason: z.string(), expiresAt: z.string().optional() })),
    });
    const classificationSchema = z.object({
      classifications: z.array(z.object({ alertId: z.string(), verdict: z.enum(["escalate", "suppress", "observe"]), confidence: z.number(), matchedNoiseRule: z.string().optional(), matchedIncidentId: z.string().optional(), reasoning: z.string(), riskLevel: z.enum(["critical", "high", "medium", "low"]) })),
    });
    const sinkResultSchema = z.object({
      paged: z.array(z.object({ alertId: z.string(), channel: z.string(), ticketUrl: z.string().optional() })),
      ticketed: z.array(z.object({ alertId: z.string(), ticketUrl: z.string() })),
      dropped: z.array(z.string()),
    });
    const outputSchema = z.object({
      totalReceived: z.number(),
      suppressed: z.number(),
      escalated: z.number(),
      ticketed: z.number(),
      observed: z.number(),
      summary: z.string(),
    });

    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      dedupeResult: dedupeResultSchema,
      context: contextSchema,
      classification: classificationSchema,
      sinkResult: sinkResultSchema,
      output: outputSchema,
    });

    const workflow = smithers((ctx) => {
      const deduped = ctx.outputMaybe("dedupeResult", { nodeId: "dedupe" });
      const context = ctx.outputMaybe("context", { nodeId: "context-lookup" });
      const classification = ctx.outputMaybe("classification", { nodeId: "classify" });
      const sinkResult = ctx.outputMaybe("sinkResult", { nodeId: "dispatch" });

      const alerts = ctx.input.alerts ?? [];

      return (
        <Workflow name="alert-suppressor">
          <Sequence>
            <Parallel>
              <Task id="dedupe" output={outputs.dedupeResult}>
                {{
                  uniqueAlerts: [{ id: "a1", source: "datadog", severity: "high" as const, message: "CPU spike", timestamp: "2026-01-01T00:00:00Z", labels: "env=prod" }],
                  suppressedCount: 1,
                  suppressedIds: ["a2"],
                }}
              </Task>
              <Task id="context-lookup" output={outputs.context}>
                {{
                  recentIncidents: [{ id: "inc-1", title: "CPU incident", status: "open" as const, relatedAlertPatterns: ["CPU"] }],
                  noiseRules: [{ pattern: "heartbeat", reason: "known flap" }],
                }}
              </Task>
            </Parallel>

            <Task id="classify" output={outputs.classification}>
              {{
                classifications: [
                  { alertId: "a1", verdict: "escalate" as const, confidence: 0.9, reasoning: "Novel high-severity alert", riskLevel: "high" as const },
                ],
              }}
            </Task>

            <Task id="dispatch" output={outputs.sinkResult}>
              {{
                paged: [{ alertId: "a1", channel: "pagerduty" }],
                ticketed: [],
                dropped: [],
              }}
            </Task>

            <Task id="summary" output={outputs.output}>
              {{
                totalReceived: 2,
                suppressed: 1,
                escalated: 1,
                ticketed: 0,
                observed: 0,
                summary: "Received 2 alerts. Deduplicated 1 duplicates. Escalated 1 to pagerduty. Filed 0 tickets. Suppressed 0 as known noise.",
              }}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: { alerts: [{ id: "a1" }, { id: "a2" }] } });
    expect(r.status).toBe("finished");
    const outputRows = (db as any).select().from(tables.output).all();
    expect(outputRows.length).toBe(1);
    expect(outputRows[0].totalReceived).toBe(2);
    expect(outputRows[0].escalated).toBe(1);
    cleanup();
  });
});

// ============================================================
// 2. audit
// ============================================================
describe("audit", () => {
  test("scan → investigate high-severity → report", async () => {
    const scanSchema = z.object({
      items: z.array(z.object({ id: z.string(), category: z.string(), severity: z.enum(["critical", "high", "medium", "low", "info"]), description: z.string(), location: z.string() })),
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

    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      scan: scanSchema,
      finding: findingSchema,
      report: reportSchema,
    });

    const workflow = smithers((ctx) => {
      const scan = ctx.outputMaybe("scan", { nodeId: "scan" });
      const findings = ctx.outputs("finding");

      return (
        <Workflow name="audit">
          <Sequence>
            <Task id="scan" output={outputs.scan}>
              {{
                items: [
                  { id: "v1", category: "security", severity: "critical" as const, description: "SQL injection", location: "src/db.ts" },
                  { id: "v2", category: "security", severity: "high" as const, description: "XSS risk", location: "src/ui.ts" },
                  { id: "v3", category: "quality", severity: "medium" as const, description: "Unused import", location: "src/utils.ts" },
                ],
                totalScanned: 100,
              }}
            </Task>

            {scan && (
              <Parallel>
                {scan.items
                  .filter((item) => ["critical", "high"].includes(item.severity))
                  .map((item) => (
                    <Task key={item.id} id={`investigate-${item.id}`} output={outputs.finding}>
                      {{
                        itemId: item.id,
                        status: "confirmed" as const,
                        details: `Confirmed ${item.description}`,
                        recommendation: `Fix ${item.description} in ${item.location}`,
                      }}
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
                recommendations: findings.filter((f) => f.status === "confirmed").map((f) => f.recommendation),
                summary: `Audit complete: ${scan?.items.length ?? 0} items found, ${findings.filter((f) => f.status === "confirmed").length} confirmed issues`,
              }}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: { directory: ".", auditType: "security" } });
    expect(r.status).toBe("finished");

    const findingRows = (db as any).select().from(tables.finding).all();
    expect(findingRows.length).toBe(2); // only critical + high investigated

    const reportRows = (db as any).select().from(tables.report).all();
    expect(reportRows.length).toBe(1);
    expect(reportRows[0].critical).toBe(1);
    expect(reportRows[0].high).toBe(1);
    cleanup();
  });
});

// ============================================================
// 3. benchmark-sheriff
// ============================================================
describe("benchmark-sheriff", () => {
  test("clean run: no regressions takes the else branch", async () => {
    const runSchema = z.object({
      benchmarks: z.array(z.object({ name: z.string(), valueMs: z.number() })),
      raw: z.string(),
    });
    const diffSchema = z.object({
      regressions: z.array(z.object({ name: z.string(), baselineMs: z.number(), currentMs: z.number(), deltaPercent: z.number() })),
      exceeded: z.boolean(),
    });
    const analysisSchema = z.object({
      findings: z.array(z.object({ benchmark: z.string(), likelyCause: z.string(), severity: z.enum(["low", "medium", "high"]) })),
      summary: z.string(),
    });
    const outputSchema = z.object({
      status: z.enum(["clean", "regressed"]),
      regressionCount: z.number(),
      summary: z.string(),
    });

    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      run: runSchema,
      diff: diffSchema,
      analysis: analysisSchema,
      output: outputSchema,
    });

    const workflow = smithers((ctx) => {
      const threshold = 5;
      const baseline = [{ name: "parse", valueMs: 100 }];
      const runResult = ctx.outputMaybe("run", { nodeId: "run-benchmarks" });
      const diffResult = ctx.outputMaybe("diff", { nodeId: "compute-diff" });

      const regressions = baseline
        .map((b) => {
          const current = runResult?.benchmarks.find((r: { name: string }) => r.name === b.name);
          if (!current) return null;
          const delta = ((current.valueMs - b.valueMs) / b.valueMs) * 100;
          return { name: b.name, baselineMs: b.valueMs, currentMs: current.valueMs, deltaPercent: Math.round(delta * 100) / 100 };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null && r.deltaPercent >= threshold);

      const exceeded = regressions.length > 0;

      return (
        <Workflow name="benchmark-sheriff">
          <Sequence>
            <Task id="run-benchmarks" output={outputs.run}>
              {{ benchmarks: [{ name: "parse", valueMs: 102 }], raw: "parse: 102ms" }}
            </Task>

            <Task id="compute-diff" output={outputs.diff}>
              {{ regressions, exceeded }}
            </Task>

            <Branch
              if={diffResult?.exceeded ?? false}
              then={
                <Sequence>
                  <Task id="analyze" output={outputs.analysis}>
                    {{ findings: [{ benchmark: "parse", likelyCause: "new middleware", severity: "medium" as const }], summary: "1 regression" }}
                  </Task>
                  <Task id="result-regressed" output={outputs.output}>
                    {{ status: "regressed" as const, regressionCount: regressions.length, summary: "Regressed" }}
                  </Task>
                </Sequence>
              }
              else={
                <Task id="result-clean" output={outputs.output}>
                  {{ status: "clean" as const, regressionCount: 0, summary: "All benchmarks within the 5% threshold" }}
                </Task>
              }
            />
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    const outputRows = (db as any).select().from(tables.output).all();
    expect(outputRows.length).toBe(1);
    expect(outputRows[0].status).toBe("clean");
    cleanup();
  });

  test("regressed run: takes the then branch", async () => {
    const runSchema = z.object({
      benchmarks: z.array(z.object({ name: z.string(), valueMs: z.number() })),
      raw: z.string(),
    });
    const diffSchema = z.object({
      regressions: z.array(z.object({ name: z.string(), baselineMs: z.number(), currentMs: z.number(), deltaPercent: z.number() })),
      exceeded: z.boolean(),
    });
    const analysisSchema = z.object({
      findings: z.array(z.object({ benchmark: z.string(), likelyCause: z.string(), severity: z.enum(["low", "medium", "high"]) })),
      summary: z.string(),
    });
    const outputSchema = z.object({
      status: z.enum(["clean", "regressed"]),
      regressionCount: z.number(),
      summary: z.string(),
    });

    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      run: runSchema,
      diff: diffSchema,
      analysis: analysisSchema,
      output: outputSchema,
    });

    const workflow = smithers((ctx) => {
      const threshold = 5;
      const baseline = [{ name: "parse", valueMs: 100 }];
      const runResult = ctx.outputMaybe("run", { nodeId: "run-benchmarks" });
      const diffResult = ctx.outputMaybe("diff", { nodeId: "compute-diff" });

      const regressions = baseline
        .map((b) => {
          const current = runResult?.benchmarks.find((r: { name: string }) => r.name === b.name);
          if (!current) return null;
          const delta = ((current.valueMs - b.valueMs) / b.valueMs) * 100;
          return { name: b.name, baselineMs: b.valueMs, currentMs: current.valueMs, deltaPercent: Math.round(delta * 100) / 100 };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null && r.deltaPercent >= threshold);

      const exceeded = regressions.length > 0;

      return (
        <Workflow name="benchmark-sheriff">
          <Sequence>
            <Task id="run-benchmarks" output={outputs.run}>
              {{ benchmarks: [{ name: "parse", valueMs: 150 }], raw: "parse: 150ms" }}
            </Task>

            <Task id="compute-diff" output={outputs.diff}>
              {{ regressions, exceeded }}
            </Task>

            <Branch
              if={diffResult?.exceeded ?? false}
              then={
                <Sequence>
                  <Task id="analyze" output={outputs.analysis}>
                    {{ findings: [{ benchmark: "parse", likelyCause: "new middleware", severity: "high" as const }], summary: "1 regression" }}
                  </Task>
                  <Task id="result-regressed" output={outputs.output}>
                    {{ status: "regressed" as const, regressionCount: 1, summary: "1 benchmark exceeded threshold" }}
                  </Task>
                </Sequence>
              }
              else={
                <Task id="result-clean" output={outputs.output}>
                  {{ status: "clean" as const, regressionCount: 0, summary: "All clean" }}
                </Task>
              }
            />
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    const outputRows = (db as any).select().from(tables.output).all();
    expect(outputRows.length).toBe(1);
    expect(outputRows[0].status).toBe("regressed");
    cleanup();
  });
});

// ============================================================
// 4. bisect-guide
// ============================================================
describe("bisect-guide", () => {
  test("loop converges when culpritFound is true", async () => {
    const bisectStepSchema = z.object({
      sha: z.string(),
      low: z.number(),
      high: z.number(),
      mid: z.number(),
      testOutput: z.string(),
      exitCode: z.number(),
    });
    const adjudicationSchema = z.object({
      verdict: z.enum(["good", "bad", "skip"]),
      confidence: z.number(),
      reasoning: z.string(),
      nextLow: z.number(),
      nextHigh: z.number(),
      culpritFound: z.boolean(),
      culpritSha: z.string().nullable(),
    });
    const outputSchema = z.object({
      culpritSha: z.string().nullable(),
      totalSteps: z.number(),
      summary: z.string(),
    });

    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      bisectStep: bisectStepSchema,
      adjudication: adjudicationSchema,
      output: outputSchema,
    });

    let iteration = 0;
    const workflow = smithers((ctx) => {
      const steps = ctx.outputs("adjudication");
      const latestAdj = steps[steps.length - 1];
      const culpritFound = latestAdj?.culpritFound ?? false;

      return (
        <Workflow name="bisect-guide">
          <Sequence>
            <Loop until={culpritFound} maxIterations={5}>
              <Sequence>
                <Task id="bisectStep" output={outputs.bisectStep}>
                  {() => {
                    iteration++;
                    return { sha: `abc${iteration}`, low: 0, high: 10 - iteration * 3, mid: 5, testOutput: "FAIL", exitCode: 1 };
                  }}
                </Task>
                <Task id="adjudication" output={outputs.adjudication}>
                  {() => ({
                    verdict: "bad" as const,
                    confidence: 1,
                    reasoning: "Test failed",
                    nextLow: 0,
                    nextHigh: Math.max(0, 10 - iteration * 3),
                    culpritFound: iteration >= 3,
                    culpritSha: iteration >= 3 ? "abc3" : null,
                  })}
                </Task>
              </Sequence>
            </Loop>

            <Task id="summary" output={outputs.output}>
              {() => ({
                culpritSha: "abc3",
                totalSteps: iteration,
                summary: `Found culprit at abc3 in ${iteration} steps`,
              })}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: { commitCount: 10 } });
    expect(r.status).toBe("finished");
    const outputRows = (db as any).select().from(tables.output).all();
    expect(outputRows.length).toBe(1);
    expect(outputRows[0].culpritSha).toBe("abc3");
    expect(iteration).toBeGreaterThanOrEqual(3);
    cleanup();
  });
});

// ============================================================
// 5. blog-analyzer-pipeline
// ============================================================
describe("blog-analyzer-pipeline", () => {
  test("ingest → analyze → report sequence", async () => {
    const ingestSchema = z.object({
      articles: z.array(z.object({ id: z.string(), title: z.string(), content: z.string(), author: z.string().optional(), publishedAt: z.string().optional() })),
      totalIngested: z.number(),
      errors: z.array(z.string()),
    });
    const analyzeSchema = z.object({
      insights: z.array(z.object({ articleId: z.string(), categories: z.array(z.string()), sentiment: z.enum(["positive", "neutral", "negative"]), keyTopics: z.array(z.string()), readabilityScore: z.number() })),
      totalAnalyzed: z.number(),
      topCategories: z.array(z.object({ category: z.string(), count: z.number() })),
    });
    const reportSchema = z.object({
      summary: z.string(),
      categoryBreakdown: z.record(z.string(), z.number()),
      sentimentDistribution: z.record(z.string(), z.number()),
      topTopics: z.array(z.string()),
      recommendations: z.array(z.string()),
      totalProcessed: z.number(),
    });

    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      ingest: ingestSchema,
      analyze: analyzeSchema,
      report: reportSchema,
    });

    const workflow = smithers(() => (
      <Workflow name="blog-analyzer-pipeline">
        <Sequence>
          <Task id="ingest" output={outputs.ingest}>
            {{
              articles: [
                { id: "p1", title: "Intro to TS", content: "TypeScript is great...", author: "Alice" },
                { id: "p2", title: "React Hooks", content: "Hooks changed everything...", author: "Bob" },
              ],
              totalIngested: 2,
              errors: [],
            }}
          </Task>
          <Task id="analyze" output={outputs.analyze}>
            {{
              insights: [
                { articleId: "p1", categories: ["typescript", "tutorial"], sentiment: "positive" as const, keyTopics: ["TypeScript", "types"], readabilityScore: 8.5 },
                { articleId: "p2", categories: ["react", "tutorial"], sentiment: "positive" as const, keyTopics: ["React", "hooks"], readabilityScore: 7.2 },
              ],
              totalAnalyzed: 2,
              topCategories: [{ category: "tutorial", count: 2 }],
            }}
          </Task>
          <Task id="report" output={outputs.report}>
            {{
              summary: "2 articles analyzed",
              categoryBreakdown: { tutorial: 2, typescript: 1, react: 1 },
              sentimentDistribution: { positive: 2 },
              topTopics: ["TypeScript", "React"],
              recommendations: ["More advanced content"],
              totalProcessed: 2,
            }}
          </Task>
        </Sequence>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: { source: "blog.example.com" } });
    expect(r.status).toBe("finished");
    const reportRows = (db as any).select().from(tables.report).all();
    expect(reportRows.length).toBe(1);
    expect(reportRows[0].totalProcessed).toBe(2);
    cleanup();
  });
});

// ============================================================
// 6. branch-doctor
// ============================================================
describe("branch-doctor", () => {
  test("inspect → diagnose → plan → summary (no auto-execute)", async () => {
    const inspectionSchema = z.object({
      branch: z.string(), conflictedFiles: z.array(z.string()), divergedCommits: z.number(),
      unresolvedCherryPicks: z.array(z.string()), staleGeneratedFiles: z.array(z.string()), statusSummary: z.string(),
    });
    const diagnosisSchema = z.object({
      rootCause: z.enum(["bad-rebase", "partial-cherry-pick", "divergent-generated-files", "mixed", "unknown"]),
      details: z.string(), severity: z.enum(["low", "medium", "high"]), affectedPaths: z.array(z.string()),
    });
    const planSchema = z.object({
      commands: z.array(z.object({ command: z.string(), purpose: z.string(), safe: z.boolean() })),
      estimatedRisk: z.enum(["low", "medium", "high"]), manualStepsRequired: z.array(z.string()),
    });
    const executionSchema = z.object({
      executedCommands: z.array(z.object({ command: z.string(), exitCode: z.number(), output: z.string() })),
      skippedUnsafe: z.array(z.string()), success: z.boolean(),
    });
    const outputSchema = z.object({
      rootCause: z.string(), recoveryCommands: z.array(z.string()), executed: z.boolean(), summary: z.string(),
    });

    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      inspection: inspectionSchema,
      diagnosis: diagnosisSchema,
      plan: planSchema,
      execution: executionSchema,
      output: outputSchema,
    });

    const workflow = smithers((ctx) => {
      const diagnosis = ctx.outputMaybe("diagnosis", { nodeId: "diagnose" });
      const plan = ctx.outputMaybe("plan", { nodeId: "plan" });

      return (
        <Workflow name="branch-doctor">
          <Sequence>
            <Task id="inspect" output={outputs.inspection}>
              {{
                branch: "feature/broken", conflictedFiles: ["src/app.ts"], divergedCommits: 5,
                unresolvedCherryPicks: [], staleGeneratedFiles: [], statusSummary: "rebase in progress",
              }}
            </Task>
            <Task id="diagnose" output={outputs.diagnosis}>
              {{
                rootCause: "bad-rebase" as const, details: "Rebase left conflicts",
                severity: "medium" as const, affectedPaths: ["src/app.ts"],
              }}
            </Task>
            <Task id="plan" output={outputs.plan}>
              {{
                commands: [
                  { command: "git rebase --abort", purpose: "Abort the broken rebase", safe: true },
                  { command: "git rebase main", purpose: "Redo the rebase cleanly", safe: false },
                ],
                estimatedRisk: "medium" as const,
                manualStepsRequired: ["Resolve merge conflicts manually"],
              }}
            </Task>
            <Branch if={false} then={
              <Task id="execute" output={outputs.execution}>
                {{ executedCommands: [], skippedUnsafe: [], success: true }}
              </Task>
            } />
            <Task id="summary" output={outputs.output}>
              {{
                rootCause: diagnosis?.rootCause ?? "unknown",
                recoveryCommands: (plan?.commands ?? []).map((c) => c.command),
                executed: false,
                summary: "BranchDoctor diagnosed bad-rebase. Dry-run only.",
              }}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: { repoPath: ".", autoExecute: false } });
    expect(r.status).toBe("finished");
    const outputRows = (db as any).select().from(tables.output).all();
    expect(outputRows.length).toBe(1);
    expect(outputRows[0].rootCause).toBe("bad-rebase");
    expect(outputRows[0].executed).toBe(false);
    cleanup();
  });
});

// ============================================================
// 7. canary-judge
// ============================================================
describe("canary-judge", () => {
  test("collect stable + canary in parallel → compare → judge → deploy", async () => {
    const telemetrySchema = z.object({
      stream: z.enum(["stable", "canary"]),
      latencyP50Ms: z.number(), latencyP99Ms: z.number(), errorRate: z.number(),
      throughputRps: z.number(), logAnomalies: z.array(z.string()), traceWarnings: z.array(z.string()),
    });
    const comparisonSchema = z.object({
      latencyDelta: z.object({ p50Pct: z.number(), p99Pct: z.number() }),
      errorRateDelta: z.number(), throughputDelta: z.number(),
      newAnomalies: z.array(z.string()),
      riskSignals: z.array(z.object({ signal: z.string(), severity: z.enum(["critical", "high", "medium", "low"]) })),
      summary: z.string(),
    });
    const verdictSchema = z.object({
      decision: z.enum(["promote", "hold", "rollback"]),
      confidence: z.number(), reasons: z.array(z.string()),
      conditions: z.array(z.string()), summary: z.string(),
    });
    const deployActionSchema = z.object({
      action: z.enum(["promote", "hold", "rollback"]),
      commands: z.array(z.string()), notifyChannels: z.array(z.string()), summary: z.string(),
    });

    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      telemetry: telemetrySchema,
      comparison: comparisonSchema,
      verdict: verdictSchema,
      deployAction: deployActionSchema,
    });

    const workflow = smithers(() => (
      <Workflow name="canary-judge">
        <Sequence>
          <Parallel>
            <Task id="collect-stable" output={outputs.telemetry}>
              {{
                stream: "stable" as const, latencyP50Ms: 45, latencyP99Ms: 120,
                errorRate: 1, throughputRps: 1000, logAnomalies: [], traceWarnings: [],
              }}
            </Task>
            <Task id="collect-canary" output={outputs.telemetry}>
              {{
                stream: "canary" as const, latencyP50Ms: 47, latencyP99Ms: 125,
                errorRate: 2, throughputRps: 980, logAnomalies: [], traceWarnings: [],
              }}
            </Task>
          </Parallel>
          <Task id="compare" output={outputs.comparison}>
            {{
              latencyDelta: { p50Pct: 4, p99Pct: 4 },
              errorRateDelta: 1, throughputDelta: -2,
              newAnomalies: [], riskSignals: [],
              summary: "Minor latency increase, within thresholds",
            }}
          </Task>
          <Task id="judge" output={outputs.verdict}>
            {{
              decision: "promote" as const, confidence: 85,
              reasons: ["All metrics within thresholds"],
              conditions: ["Error rate stays below 0.5%"],
              summary: "Safe to promote",
            }}
          </Task>
          <Task id="deploy" output={outputs.deployAction}>
            {{
              action: "promote" as const, commands: ["kubectl promote canary"],
              notifyChannels: ["#deploys"], summary: "Promoting canary",
            }}
          </Task>
        </Sequence>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    const verdictRows = (db as any).select().from(tables.verdict).all();
    expect(verdictRows.length).toBe(1);
    expect(verdictRows[0].decision).toBe("promote");
    const telemetryRows = (db as any).select().from(tables.telemetry).all();
    expect(telemetryRows.length).toBe(2);
    cleanup();
  });
});

// ============================================================
// 8. change-blast-radius
// ============================================================
describe("change-blast-radius", () => {
  test("parse → gather → blast-radius sequence", async () => {
    const parsedDiffSchema = z.object({
      files: z.array(z.object({ path: z.string(), changeType: z.enum(["added", "modified", "deleted", "renamed"]), hunks: z.number(), linesChanged: z.number() })),
      totalFiles: z.number(), summary: z.string(),
    });
    const dependencyContextSchema = z.object({
      dependencies: z.array(z.object({ source: z.string(), dependsOn: z.array(z.string()), service: z.string() })),
      relatedTests: z.array(z.string()), relatedDocs: z.array(z.string()),
      owners: z.array(z.object({ team: z.string(), files: z.array(z.string()) })),
      summary: z.string(),
    });
    const blastRadiusSchema = z.object({
      impactedServices: z.array(z.object({ name: z.string(), risk: z.enum(["low", "medium", "high", "critical"]), reason: z.string() })),
      impactedTests: z.array(z.string()), impactedDocs: z.array(z.string()),
      owners: z.array(z.string()),
      overallRisk: z.enum(["low", "medium", "high", "critical"]),
      summary: z.string(),
    });

    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      parsedDiff: parsedDiffSchema,
      dependencyContext: dependencyContextSchema,
      blastRadius: blastRadiusSchema,
    });

    const workflow = smithers(() => (
      <Workflow name="change-blast-radius">
        <Sequence>
          <Task id="parse-diff" output={outputs.parsedDiff}>
            {{
              files: [
                { path: "src/auth.ts", changeType: "modified" as const, hunks: 2, linesChanged: 45 },
                { path: "src/middleware.ts", changeType: "modified" as const, hunks: 1, linesChanged: 10 },
              ],
              totalFiles: 2,
              summary: "Auth and middleware changes",
            }}
          </Task>
          <Task id="gather-context" output={outputs.dependencyContext}>
            {{
              dependencies: [{ source: "src/auth.ts", dependsOn: ["src/db.ts"], service: "auth-service" }],
              relatedTests: ["tests/auth.test.ts"],
              relatedDocs: ["docs/auth.md"],
              owners: [{ team: "platform", files: ["src/auth.ts"] }],
              summary: "Auth module impacts auth-service",
            }}
          </Task>
          <Task id="blast-radius" output={outputs.blastRadius}>
            {{
              impactedServices: [{ name: "auth-service", risk: "high" as const, reason: "Core auth logic changed" }],
              impactedTests: ["tests/auth.test.ts"],
              impactedDocs: ["docs/auth.md"],
              owners: ["platform"],
              overallRisk: "high" as const,
              summary: "High risk: core auth changed",
            }}
          </Task>
        </Sequence>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: { diff: "..." } });
    expect(r.status).toBe("finished");
    const brRows = (db as any).select().from(tables.blastRadius).all();
    expect(brRows.length).toBe(1);
    expect(brRows[0].overallRisk).toBe("high");
    cleanup();
  });
});

// ============================================================
// 9. changelog
// ============================================================
describe("changelog", () => {
  test("analyze → generate sequence", async () => {
    const commitAnalysisSchema = z.object({
      commits: z.array(z.object({
        sha: z.string(), message: z.string(), author: z.string(),
        category: z.enum(["feature", "fix", "refactor", "docs", "test", "chore", "breaking"]),
        scope: z.string().optional(), summary: z.string(),
      })),
      totalCommits: z.number(), dateRange: z.string(),
    });
    const changelogSchema = z.object({
      version: z.string(), date: z.string(),
      sections: z.array(z.object({ category: z.string(), emoji: z.string(), items: z.array(z.string()) })),
      highlights: z.array(z.string()), breakingChanges: z.array(z.string()),
      contributors: z.array(z.string()), markdown: z.string(),
    });

    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      commitAnalysis: commitAnalysisSchema,
      changelog: changelogSchema,
    });

    const workflow = smithers(() => (
      <Workflow name="changelog">
        <Sequence>
          <Task id="analyze" output={outputs.commitAnalysis}>
            {{
              commits: [
                { sha: "abc123", message: "feat: add dark mode", author: "Alice", category: "feature" as const, summary: "Added dark mode support" },
                { sha: "def456", message: "fix: login bug", author: "Bob", category: "fix" as const, summary: "Fixed login race condition" },
              ],
              totalCommits: 2,
              dateRange: "2026-03-20 to 2026-03-28",
            }}
          </Task>
          <Task id="generate" output={outputs.changelog}>
            {{
              version: "1.2.0",
              date: "2026-03-28",
              sections: [
                { category: "Features", emoji: "sparkles", items: ["Added dark mode support"] },
                { category: "Bug Fixes", emoji: "bug", items: ["Fixed login race condition"] },
              ],
              highlights: ["Dark mode is here!"],
              breakingChanges: [],
              contributors: ["Alice", "Bob"],
              markdown: "# 1.2.0\n\n## Features\n- Added dark mode\n\n## Bug Fixes\n- Fixed login bug",
            }}
          </Task>
        </Sequence>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: { version: "1.2.0" } });
    expect(r.status).toBe("finished");
    const clRows = (db as any).select().from(tables.changelog).all();
    expect(clRows.length).toBe(1);
    expect(clRows[0].version).toBe("1.2.0");
    expect(clRows[0].contributors).toContain("Alice");
    cleanup();
  });
});

// ============================================================
// 10. classifier-switchboard
// ============================================================
describe("classifier-switchboard", () => {
  test("intake → classify → fan-out handlers → summary", async () => {
    const intakeSchema = z.object({
      items: z.array(z.object({ id: z.string(), content: z.string(), source: z.enum(["email", "chat", "ticket", "file"]), metadata: z.record(z.string(), z.string()).optional() })),
    });
    const classificationSchema = z.object({
      classifications: z.array(z.object({
        itemId: z.string(), domain: z.enum(["support", "sales", "security", "billing"]),
        confidence: z.number(), reasoning: z.string(), priority: z.enum(["critical", "high", "normal", "low"]),
      })),
    });
    const handlerResultSchema = z.object({
      itemId: z.string(), domain: z.enum(["support", "sales", "security", "billing"]),
      action: z.string(), status: z.enum(["resolved", "escalated", "pending"]), response: z.string(),
    });
    const summarySchema = z.object({
      totalProcessed: z.number(),
      byDomain: z.record(z.string(), z.number()),
      byStatus: z.record(z.string(), z.number()),
      escalations: z.array(z.object({ itemId: z.string(), domain: z.string(), reason: z.string() })),
      summary: z.string(),
    });

    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      intake: intakeSchema,
      classification: classificationSchema,
      handlerResult: handlerResultSchema,
      summary: summarySchema,
    });

    const workflow = smithers((ctx) => {
      const intake = ctx.outputMaybe("intake", { nodeId: "intake" });
      const classification = ctx.outputMaybe("classification", { nodeId: "classify" });
      const classified = classification?.classifications ?? [];

      return (
        <Workflow name="classifier-switchboard">
          <Sequence>
            <Task id="intake" output={outputs.intake}>
              {{
                items: [
                  { id: "t1", content: "My payment failed", source: "email" as const, metadata: { from: "user@example.com" } },
                  { id: "t2", content: "Unauthorized access attempt detected", source: "ticket" as const },
                ],
              }}
            </Task>

            {intake && (
              <Task id="classify" output={outputs.classification}>
                {{
                  classifications: [
                    { itemId: "t1", domain: "billing" as const, confidence: 0.95, reasoning: "Payment issue", priority: "high" as const },
                    { itemId: "t2", domain: "security" as const, confidence: 0.99, reasoning: "Security alert", priority: "critical" as const },
                  ],
                }}
              </Task>
            )}

            {classified.length > 0 && (
              <Parallel>
                {classified.map((c) => (
                  <Task key={c.itemId} id={`handle-${c.domain}-${c.itemId}`} output={outputs.handlerResult}>
                    {{
                      itemId: c.itemId,
                      domain: c.domain,
                      action: `Processed ${c.domain} item`,
                      status: "resolved" as const,
                      response: `Handled ${c.itemId} for ${c.domain}`,
                    }}
                  </Task>
                ))}
              </Parallel>
            )}

            <Task id="summary" output={outputs.summary}>
              {{
                totalProcessed: 2,
                byDomain: { billing: 1, security: 1 },
                byStatus: { resolved: 2 },
                escalations: [],
                summary: "Processed 2 items: 1 billing, 1 security",
              }}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    const handlerRows = (db as any).select().from(tables.handlerResult).all();
    expect(handlerRows.length).toBe(2);
    const summaryRows = (db as any).select().from(tables.summary).all();
    expect(summaryRows.length).toBe(1);
    expect(summaryRows[0].totalProcessed).toBe(2);
    cleanup();
  });
});
