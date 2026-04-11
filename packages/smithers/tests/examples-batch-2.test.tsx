/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import {
  Workflow,
  Task,
  Sequence,
  Parallel,
  Loop,
  Ralph,
  Branch,
  runWorkflow,
} from "../src/index";
import { createTestSmithers } from "./helpers";
import { z } from "zod";

// ─── 1. code-review-loop ────────────────────────────────────────────────────

describe("code-review-loop", () => {
  const reviewSchema = z.object({
    approved: z.boolean(),
    feedback: z.string(),
    issues: z.array(z.string()).optional(),
  });
  const fixSchema = z.object({
    filesChanged: z.array(z.string()),
    changesSummary: z.string(),
  });
  const outputSchema = z.object({
    finalSummary: z.string(),
    totalIterations: z.number(),
  });

  test("approves on first pass and skips fix", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      review: reviewSchema,
      fix: fixSchema,
      output: outputSchema,
    });

    const workflow = smithers((ctx) => {
      const latestReview = ctx.outputs.review?.[ctx.outputs.review.length - 1];
      const isApproved = latestReview?.approved ?? false;
      return (
        <Workflow name="code-review-loop">
          <Ralph until={isApproved} maxIterations={3} onMaxReached="return-last">
            <Sequence>
              <Task id="review" output={outputs.review}>
                {() => ({ approved: true, feedback: "LGTM", issues: [] })}
              </Task>
              <Task id="fix" output={outputs.fix} skipIf={isApproved}>
                {() => ({ filesChanged: [], changesSummary: "no fixes" })}
              </Task>
            </Sequence>
          </Ralph>
          <Task id="summary" output={outputs.output}>
            {{
              finalSummary: isApproved
                ? "Code review passed - LGTM!"
                : `Review completed after ${ctx.outputs.review?.length ?? 0} iterations`,
              totalIterations: ctx.outputs.review?.length ?? 0,
            }}
          </Task>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: { directory: ".", focus: "all" } });
    expect(r.status).toBe("finished");
    const reviews = (db as any).select().from(tables.review).all();
    // Loop always runs at least once; `until` is checked after each iteration
    // so review runs on iteration 0 (approved=true) then loop re-renders and sees until=true
    expect(reviews.length).toBeGreaterThanOrEqual(1);
    expect(reviews.some((r: any) => !!r.approved)).toBe(true);
    cleanup();
  });

  test("loops when review fails then succeeds", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      review: reviewSchema,
      fix: fixSchema,
      output: outputSchema,
    });

    let reviewCount = 0;
    const workflow = smithers((ctx) => {
      const latestReview = ctx.outputs.review?.[ctx.outputs.review.length - 1];
      const isApproved = latestReview?.approved ?? false;
      return (
        <Workflow name="code-review-loop">
          <Ralph until={isApproved} maxIterations={3} onMaxReached="return-last">
            <Sequence>
              <Task id="review" output={outputs.review}>
                {() => {
                  reviewCount++;
                  return reviewCount >= 2
                    ? { approved: true, feedback: "LGTM", issues: [] }
                    : { approved: false, feedback: "needs work", issues: ["fix bug"] };
                }}
              </Task>
              <Task id="fix" output={outputs.fix} skipIf={isApproved}>
                {() => ({ filesChanged: ["src/index.ts"], changesSummary: "fixed bug" })}
              </Task>
            </Sequence>
          </Ralph>
          <Task id="summary" output={outputs.output}>
            {{
              finalSummary: isApproved ? "Code review passed - LGTM!" : "Review completed",
              totalIterations: ctx.outputs.review?.length ?? 0,
            }}
          </Task>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: { directory: ".", focus: "all" } });
    expect(r.status).toBe("finished");
    const reviews = (db as any).select().from(tables.review).all();
    expect(reviews.length).toBe(2);
    cleanup();
  });
});

// ─── 2. collector-probe ─────────────────────────────────────────────────────

describe("collector-probe", () => {
  const invocationSchema = z.object({
    callId: z.string(),
    model: z.string(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    latencyMs: z.number(),
    costUsd: z.number(),
    qualityScore: z.number().min(0).max(1),
    timestamp: z.string(),
    metadata: z.record(z.string(), z.string()).optional(),
  });
  const collectorSchema = z.object({
    samples: z.array(z.object({
      callId: z.string(),
      latencyMs: z.number(),
      costUsd: z.number(),
      qualityScore: z.number(),
    })),
    aggregates: z.object({
      meanLatencyMs: z.number(),
      p95LatencyMs: z.number(),
      meanCostUsd: z.number(),
      meanQuality: z.number(),
      totalInvocations: z.number(),
    }),
    summary: z.string(),
  });
  const anomalySchema = z.object({
    driftDetected: z.boolean(),
    anomalies: z.array(z.object({
      metric: z.enum(["quality", "cost", "latency"]),
      direction: z.enum(["up", "down"]),
      deltaPercent: z.number(),
      baselineValue: z.number(),
      currentValue: z.number(),
      severity: z.enum(["info", "warning", "critical"]),
    })),
    shouldAlert: z.boolean(),
    summary: z.string(),
  });
  const reportSchema = z.object({
    overallStatus: z.enum(["healthy", "degraded", "critical"]),
    totalInvocations: z.number(),
    iterationsRun: z.number(),
    anomaliesDetected: z.number(),
    alerts: z.array(z.object({
      metric: z.string(),
      message: z.string(),
      severity: z.enum(["info", "warning", "critical"]),
    })),
    recommendations: z.array(z.string()),
    summary: z.string(),
  });

  test("runs loop and produces healthy report when no drift", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      invocation: invocationSchema,
      collector: collectorSchema,
      anomaly: anomalySchema,
      report: reportSchema,
    });

    let invocationCount = 0;
    const workflow = smithers((ctx) => {
      const anomalies = ctx.outputs.anomaly ?? [];
      const latestAnomaly = anomalies[anomalies.length - 1];
      const noMoreDrift = anomalies.length > 0 && !(latestAnomaly?.driftDetected);
      const collectors = ctx.outputs.collector ?? [];
      const latestCollector = collectors[collectors.length - 1];

      return (
        <Workflow name="collector-probe">
          <Sequence>
            <Loop until={noMoreDrift} maxIterations={2} onMaxReached="return-last">
              <Sequence>
                <Task id="invocation" output={outputs.invocation}>
                  {() => {
                    invocationCount++;
                    return {
                      callId: `call-${invocationCount}`,
                      model: "claude-sonnet",
                      inputTokens: 100,
                      outputTokens: 200,
                      latencyMs: 450,
                      costUsd: 1,
                      qualityScore: 1,
                      timestamp: new Date().toISOString(),
                    };
                  }}
                </Task>
                <Task id="collector" output={outputs.collector}>
                  {() => ({
                    samples: [{ callId: `call-${invocationCount}`, latencyMs: 450, costUsd: 1, qualityScore: 1 }],
                    aggregates: { meanLatencyMs: 450, p95LatencyMs: 480, meanCostUsd: 1, meanQuality: 1, totalInvocations: invocationCount },
                    summary: "All metrics nominal",
                  })}
                </Task>
                <Task id="anomaly" output={outputs.anomaly}>
                  {() => ({
                    driftDetected: false,
                    anomalies: [],
                    shouldAlert: false,
                    summary: "No drift detected",
                  })}
                </Task>
              </Sequence>
            </Loop>
            <Task id="report" output={outputs.report}>
              {{
                overallStatus: "healthy" as const,
                totalInvocations: (ctx.outputs.invocation ?? []).length,
                iterationsRun: collectors.length,
                anomaliesDetected: 0,
                alerts: [],
                recommendations: ["All metrics within acceptable thresholds"],
                summary: "Collector probe healthy",
              }}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: { endpoint: "test", payload: {} } });
    expect(r.status).toBe("finished");
    const reports = (db as any).select().from(tables.report).all();
    expect(reports.length).toBe(1);
    expect(reports[0].overallStatus).toBe("healthy");
    cleanup();
  });
});

// ─── 3. command-watchdog ────────────────────────────────────────────────────

describe("command-watchdog", () => {
  const runResultSchema = z.object({
    exitCode: z.number(),
    durationMs: z.number(),
    outputSignature: z.string(),
    stdoutTail: z.string(),
    iterationNum: z.number(),
  });
  const notabilitySchema = z.object({
    notable: z.boolean(),
    reasons: z.array(z.string()),
    exitCodeChanged: z.boolean(),
    durationDeltaPercent: z.number(),
    signatureChanged: z.boolean(),
    diffSummary: z.string(),
  });
  const reportSchema = z.object({
    status: z.enum(["steady", "escalated"]),
    anomalies: z.array(z.string()),
    runCount: z.number(),
    summary: z.string(),
  });

  test("steady state when no anomalies detected", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      run: runResultSchema,
      notability: notabilitySchema,
      report: reportSchema,
    });

    let runCount = 0;
    const workflow = smithers((ctx) => {
      const notability = ctx.outputMaybe("notability", { nodeId: "detect" });
      const shouldEscalate = notability?.notable ?? false;
      const runs = ctx.outputs.run ?? [];

      return (
        <Workflow name="command-watchdog">
          <Sequence>
            <Loop until={shouldEscalate} maxIterations={2} onMaxReached="return-last">
              <Sequence>
                <Task id="run" output={outputs.run}>
                  {() => {
                    runCount++;
                    return { exitCode: 0, durationMs: 100, outputSignature: "abc123", stdoutTail: "ok", iterationNum: runCount };
                  }}
                </Task>
                <Task id="detect" output={outputs.notability}>
                  {() => ({
                    notable: false,
                    reasons: [],
                    exitCodeChanged: false,
                    durationDeltaPercent: 0,
                    signatureChanged: false,
                    diffSummary: "",
                  })}
                </Task>
              </Sequence>
            </Loop>
            <Task id="report" output={outputs.report} skipIf={!shouldEscalate}>
              {() => ({ status: "escalated" as const, anomalies: ["test"], runCount: runs.length, summary: "escalated" })}
            </Task>
            <Task id="steady" output={outputs.report} skipIf={shouldEscalate}>
              {{
                status: "steady" as const,
                anomalies: [],
                runCount: runs.length,
                summary: `command ran ${runs.length} times with no notable anomalies`,
              }}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: { command: "echo hi" } });
    expect(r.status).toBe("finished");
    const reports = (db as any).select().from(tables.report).all();
    expect(reports.some((r: any) => r.status === "steady")).toBe(true);
    cleanup();
  });
});

// ─── 4. compliance-evidence-collector ───────────────────────────────────────

describe("compliance-evidence-collector", () => {
  const planSchema = z.object({
    controls: z.array(z.object({
      controlId: z.string(),
      description: z.string(),
      sources: z.array(z.object({
        sourceId: z.string(),
        endpoint: z.string(),
        preferredMethod: z.enum(["api", "mcp", "browser"]),
      })),
    })),
    totalSources: z.number(),
  });
  const evidenceItemSchema = z.object({
    sourceId: z.string(),
    controlId: z.string(),
    title: z.string(),
    rawPayload: z.string(),
    fetchedAt: z.string(),
    method: z.enum(["api", "mcp", "browser"]),
    status: z.enum(["collected", "partial", "failed"]),
  });
  const normalizedSchema = z.object({
    controlId: z.string(),
    sourceId: z.string(),
    finding: z.string(),
    compliant: z.boolean(),
    severity: z.enum(["info", "low", "medium", "high", "critical"]).optional(),
    extractedFields: z.record(z.string(), z.string()).optional(),
  });
  const packetSchema = z.object({
    framework: z.string(),
    generatedAt: z.string(),
    controlCount: z.number(),
    compliantCount: z.number(),
    nonCompliantCount: z.number(),
    findings: z.array(z.object({
      controlId: z.string(),
      status: z.enum(["compliant", "non-compliant", "insufficient-evidence"]),
      evidence: z.array(z.string()),
      recommendation: z.string().optional(),
    })),
    summary: z.string(),
  });

  test("runs full pipeline with plan, fetch, normalize, packet", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      plan: planSchema,
      evidence: evidenceItemSchema,
      normalized: normalizedSchema,
      packet: packetSchema,
    });

    const workflow = smithers((ctx) => {
      const plan = ctx.outputMaybe("plan", { nodeId: "plan" });
      const evidenceItems = ctx.outputs.evidence ?? [];
      const normalized = ctx.outputs.normalized ?? [];

      return (
        <Workflow name="compliance-evidence-collector">
          <Sequence>
            <Task id="plan" output={outputs.plan}>
              {() => ({
                controls: [{
                  controlId: "CC-1.1",
                  description: "Access control",
                  sources: [{ sourceId: "src-1", endpoint: "https://api.example.com/acl", preferredMethod: "api" as const }],
                }],
                totalSources: 1,
              })}
            </Task>
            {plan && (
              <Parallel>
                {plan.controls.flatMap((control) =>
                  control.sources.map((source) => (
                    <Task
                      key={`${control.controlId}-${source.sourceId}`}
                      id={`fetch-${control.controlId}-${source.sourceId}`}
                      output={outputs.evidence}
                    >
                      {() => ({
                        sourceId: source.sourceId,
                        controlId: control.controlId,
                        title: "ACL evidence",
                        rawPayload: '{"access": "restricted"}',
                        fetchedAt: new Date().toISOString(),
                        method: source.preferredMethod,
                        status: "collected" as const,
                      })}
                    </Task>
                  ))
                )}
              </Parallel>
            )}
            {evidenceItems.length > 0 && (
              <Parallel>
                {evidenceItems.map((item) => (
                  <Task
                    key={`norm-${item.controlId}-${item.sourceId}`}
                    id={`normalize-${item.controlId}-${item.sourceId}`}
                    output={outputs.normalized}
                  >
                    {() => ({
                      controlId: item.controlId,
                      sourceId: item.sourceId,
                      finding: "Access is properly restricted",
                      compliant: true,
                      severity: "info" as const,
                    })}
                  </Task>
                ))}
              </Parallel>
            )}
            <Task id="packet" output={outputs.packet}>
              {() => ({
                framework: "SOC2",
                generatedAt: new Date().toISOString(),
                controlCount: 1,
                compliantCount: 1,
                nonCompliantCount: 0,
                findings: [{
                  controlId: "CC-1.1",
                  status: "compliant" as const,
                  evidence: ["ACL evidence"],
                }],
                summary: "All controls compliant",
              })}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: { framework: "SOC2", scope: "test" } });
    expect(r.status).toBe("finished");
    const packets = (db as any).select().from(tables.packet).all();
    expect(packets.length).toBe(1);
    expect(packets[0].framework).toBe("SOC2");
    cleanup();
  });
});

// ─── 5. config-diff-explainer ───────────────────────────────────────────────

describe("config-diff-explainer", () => {
  const fetchedDiffSchema = z.object({
    files: z.array(z.object({
      path: z.string(),
      kind: z.enum(["helm", "terraform", "k8s", "env", "other"]),
      diff: z.string(),
      service: z.string(),
    })),
    totalChanges: z.number(),
    summary: z.string(),
  });
  const explainerSchema = z.object({
    blastRadius: z.array(z.object({
      system: z.string(),
      impact: z.string(),
      severity: z.enum(["low", "medium", "high", "critical"]),
    })),
    riskLevel: z.enum(["low", "medium", "high", "critical"]),
    affectedSystems: z.array(z.string()),
    rollbackNotes: z.string(),
    summary: z.string(),
  });
  const approvalSchema = z.object({
    action: z.enum(["approve", "request-changes", "comment"]),
    comment: z.string(),
    summary: z.string(),
  });

  test("sequence: fetch -> explain -> approve", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      fetchedDiff: fetchedDiffSchema,
      explanation: explainerSchema,
      approval: approvalSchema,
    });

    const workflow = smithers((ctx) => {
      const fetched = ctx.outputMaybe("fetchedDiff", { nodeId: "fetch-diffs" });
      const explanation = ctx.outputMaybe("explanation", { nodeId: "explain" });

      return (
        <Workflow name="config-diff-explainer">
          <Sequence>
            <Task id="fetch-diffs" output={outputs.fetchedDiff}>
              {() => ({
                files: [{ path: "values.yaml", kind: "helm" as const, diff: "+replicas: 3", service: "api" }],
                totalChanges: 1,
                summary: "1 helm change",
              })}
            </Task>
            <Task id="explain" output={outputs.explanation}>
              {() => ({
                blastRadius: [{ system: "api", impact: "replica count increase", severity: "low" as const }],
                riskLevel: "low" as const,
                affectedSystems: ["api"],
                rollbackNotes: "Revert values.yaml",
                summary: "Low risk change",
              })}
            </Task>
            <Task id="approve" output={outputs.approval}>
              {() => ({
                action: "approve" as const,
                comment: "Low risk, auto-approved",
                summary: "Approved",
              })}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: { paths: ["."] } });
    expect(r.status).toBe("finished");
    const approvals = (db as any).select().from(tables.approval).all();
    expect(approvals.length).toBe(1);
    expect(approvals[0].action).toBe("approve");
    cleanup();
  });
});

// ─── 6. contract-drift-sentinel ─────────────────────────────────────────────

describe("contract-drift-sentinel", () => {
  const schemaSnapshotSchema = z.object({
    format: z.enum(["openapi", "jsonschema", "graphql", "protobuf"]),
    version: z.string(),
    baseline: z.string(),
    current: z.string(),
    entities: z.array(z.string()),
  });
  const diffResultSchema = z.object({
    additions: z.array(z.object({ path: z.string(), description: z.string() })),
    removals: z.array(z.object({ path: z.string(), description: z.string() })),
    modifications: z.array(z.object({ path: z.string(), before: z.string(), after: z.string(), description: z.string() })),
    breakingCandidates: z.array(z.string()),
    totalChanges: z.number(),
  });
  const analysisSchema = z.object({
    breakingChanges: z.array(z.object({
      path: z.string(),
      severity: z.enum(["critical", "high", "medium"]),
      reason: z.string(),
      affectedConsumers: z.array(z.string()),
      migrationHint: z.string(),
    })),
    safeChanges: z.array(z.object({
      path: z.string(),
      kind: z.enum(["addition", "deprecation-with-replacement", "documentation", "optional-field"]),
    })),
    riskScore: z.number().min(0).max(100),
    summary: z.string(),
  });
  const outputSchema = z.object({
    status: z.enum(["approve", "block", "warn"]),
    prComment: z.string(),
    breakingCount: z.number(),
    riskScore: z.number(),
    summary: z.string(),
  });

  test("approve when no breaking changes", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      schema: schemaSnapshotSchema,
      diff: diffResultSchema,
      analysis: analysisSchema,
      output: outputSchema,
    });

    const workflow = smithers((ctx) => {
      const analysis = ctx.outputMaybe("analysis", { nodeId: "analyze" });
      const riskScore = analysis?.riskScore ?? 0;
      const breakingCount = analysis?.breakingChanges.length ?? 0;
      const status = riskScore >= 70 ? "block" : riskScore >= 30 ? "warn" : "approve";

      return (
        <Workflow name="contract-drift-sentinel">
          <Sequence>
            <Task id="load" output={outputs.schema}>
              {() => ({
                format: "openapi" as const,
                version: "3.0",
                baseline: '{"paths":{}}',
                current: '{"paths":{"/new":{}}}',
                entities: ["/new"],
              })}
            </Task>
            <Task id="diff" output={outputs.diff}>
              {() => ({
                additions: [{ path: "/new", description: "New endpoint" }],
                removals: [],
                modifications: [],
                breakingCandidates: [],
                totalChanges: 1,
              })}
            </Task>
            <Task id="analyze" output={outputs.analysis}>
              {() => ({
                breakingChanges: [],
                safeChanges: [{ path: "/new", kind: "addition" as const }],
                riskScore: 5,
                summary: "Safe additive change",
              })}
            </Task>
            <Task id="output" output={outputs.output}>
              {{
                status: status as "approve" | "block" | "warn",
                prComment: "Safe to merge",
                breakingCount,
                riskScore,
                summary: "No breaking changes",
              }}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: { baselinePath: "a.yaml", currentPath: "b.yaml" } });
    expect(r.status).toBe("finished");
    const out = (db as any).select().from(tables.output).all();
    expect(out.length).toBe(1);
    expect(out[0].status).toBe("approve");
    cleanup();
  });
});

// ─── 7. coverage-loop ──────────────────────────────────────────────────────

describe("coverage-loop", () => {
  const measureSchema = z.object({
    coverage: z.number(),
    uncoveredFiles: z.array(z.object({
      file: z.string(),
      coverage: z.number(),
      uncoveredLines: z.array(z.number()),
    })),
    totalFiles: z.number(),
  });
  const fixSchema = z.object({
    testsWritten: z.number(),
    filesCreated: z.array(z.string()),
    expectedCoverageGain: z.number(),
    summary: z.string(),
  });
  const reportSchema = z.object({
    initialCoverage: z.number(),
    finalCoverage: z.number(),
    totalTestsWritten: z.number(),
    iterations: z.number(),
    summary: z.string(),
  });

  test("loops until coverage target is met", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      measure: measureSchema,
      fix: fixSchema,
      report: reportSchema,
    });

    let measureCount = 0;
    const workflow = smithers((ctx) => {
      const target = 90;
      const measures = ctx.outputs.measure ?? [];
      const fixes = ctx.outputs.fix ?? [];
      const latestMeasure = measures[measures.length - 1];
      const hitTarget = (latestMeasure?.coverage ?? 0) >= target;

      return (
        <Workflow name="coverage-loop">
          <Sequence>
            <Loop until={hitTarget} maxIterations={5} onMaxReached="return-last">
              <Sequence>
                <Task id="measure" output={outputs.measure}>
                  {() => {
                    measureCount++;
                    const cov = measureCount >= 2 ? 92 : 75;
                    return {
                      coverage: cov,
                      uncoveredFiles: cov < 90 ? [{ file: "src/utils.ts", coverage: 50, uncoveredLines: [10, 20] }] : [],
                      totalFiles: 10,
                    };
                  }}
                </Task>
                <Task id="fix" output={outputs.fix} skipIf={hitTarget}>
                  {() => ({
                    testsWritten: 3,
                    filesCreated: ["tests/utils.test.ts"],
                    expectedCoverageGain: 15,
                    summary: "Added tests for utils",
                  })}
                </Task>
              </Sequence>
            </Loop>
            <Task id="report" output={outputs.report}>
              {{
                initialCoverage: measures[0]?.coverage ?? 0,
                finalCoverage: latestMeasure?.coverage ?? 0,
                totalTestsWritten: fixes.reduce((sum, f) => sum + f.testsWritten, 0),
                iterations: measures.length,
                summary: `Coverage improved over ${measures.length} iterations`,
              }}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: { directory: ".", target: 90 } });
    expect(r.status).toBe("finished");
    const reports = (db as any).select().from(tables.report).all();
    expect(reports.length).toBe(1);
    const measures = (db as any).select().from(tables.measure).all();
    expect(measures.length).toBe(2);
    cleanup();
  });
});

// ─── 8. debate ──────────────────────────────────────────────────────────────

describe("debate", () => {
  const argumentSchema = z.object({
    position: z.enum(["for", "against"]),
    round: z.number(),
    points: z.array(z.object({
      claim: z.string(),
      evidence: z.string(),
      strength: z.enum(["strong", "moderate", "weak"]),
    })),
    rebuttals: z.array(z.string()),
    summary: z.string(),
  });
  const verdictSchema = z.object({
    decision: z.string(),
    winner: z.enum(["for", "against", "draw"]),
    reasoning: z.string(),
    conditions: z.array(z.string()),
    risks: z.array(z.string()),
    recommendation: z.string(),
  });

  test("two rounds of debate then verdict", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      argument: argumentSchema,
      verdict: verdictSchema,
    });

    let taskCount = 0;
    const workflow = smithers((ctx) => {
      const args = ctx.outputs.argument ?? [];
      const rounds = 2;
      const currentRound = Math.floor(args.length / 2) + 1;
      const debateComplete = currentRound > rounds;

      return (
        <Workflow name="debate">
          <Sequence>
            <Loop until={debateComplete} maxIterations={rounds}>
              <Sequence>
                <Parallel>
                  <Task id={`for-round-${currentRound}`} output={outputs.argument}>
                    {() => {
                      taskCount++;
                      return {
                        position: "for" as const,
                        round: currentRound,
                        points: [{ claim: "It scales well", evidence: "Benchmarks", strength: "strong" as const }],
                        rebuttals: [],
                        summary: "For the proposal",
                      };
                    }}
                  </Task>
                  <Task id={`against-round-${currentRound}`} output={outputs.argument}>
                    {() => {
                      taskCount++;
                      return {
                        position: "against" as const,
                        round: currentRound,
                        points: [{ claim: "Too complex", evidence: "Maintenance cost", strength: "moderate" as const }],
                        rebuttals: [],
                        summary: "Against the proposal",
                      };
                    }}
                  </Task>
                </Parallel>
              </Sequence>
            </Loop>
            <Task id="verdict" output={outputs.verdict}>
              {() => ({
                decision: "Proceed with caveats",
                winner: "for" as const,
                reasoning: "Scalability outweighs complexity",
                conditions: ["Add monitoring"],
                risks: ["Maintenance burden"],
                recommendation: "Approve with monitoring plan",
              })}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: { question: "Should we use microservices?", rounds: 2 }, maxConcurrency: 4 });
    expect(r.status).toBe("finished");
    const arguments_ = (db as any).select().from(tables.argument).all();
    expect(arguments_.length).toBe(4); // 2 rounds x 2 sides
    const verdicts = (db as any).select().from(tables.verdict).all();
    expect(verdicts.length).toBe(1);
    expect(verdicts[0].winner).toBe("for");
    cleanup();
  });
});

// ─── 9. dependency-update ───────────────────────────────────────────────────

describe("dependency-update", () => {
  const scanSchema = z.object({
    outdated: z.array(z.object({
      name: z.string(),
      current: z.string(),
      latest: z.string(),
      type: z.enum(["major", "minor", "patch"]),
      breaking: z.boolean(),
      changelog: z.string().optional(),
    })),
    totalOutdated: z.number(),
  });
  const updateSchema = z.object({
    name: z.string(),
    from: z.string(),
    to: z.string(),
    status: z.enum(["updated", "skipped", "failed"]),
    notes: z.string(),
  });
  const verifySchema = z.object({
    passed: z.boolean(),
    typecheck: z.boolean(),
    tests: z.boolean(),
    build: z.boolean(),
    errors: z.array(z.string()),
  });
  const reportSchema = z.object({
    updated: z.number(),
    skipped: z.number(),
    failed: z.number(),
    breaking: z.number(),
    verified: z.boolean(),
    summary: z.string(),
  });

  test("scans, updates non-breaking deps, verifies, and reports", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      scan: scanSchema,
      update: updateSchema,
      verify: verifySchema,
      report: reportSchema,
    });

    const workflow = smithers((ctx) => {
      const scan = ctx.outputMaybe("scan", { nodeId: "scan" });
      const updates = ctx.outputs.update ?? [];
      const autoUpdatable = scan?.outdated?.filter((d) => !d.breaking && d.type !== "major") ?? [];

      return (
        <Workflow name="dependency-update">
          <Sequence>
            <Task id="scan" output={outputs.scan}>
              {() => ({
                outdated: [
                  { name: "lodash", current: "4.17.20", latest: "4.17.21", type: "patch" as const, breaking: false },
                  { name: "react", current: "17.0.0", latest: "18.0.0", type: "major" as const, breaking: true },
                ],
                totalOutdated: 2,
              })}
            </Task>
            {autoUpdatable.length > 0 && (
              <Parallel maxConcurrency={3}>
                {autoUpdatable.map((dep) => (
                  <Task key={dep.name} id={`update-${dep.name}`} output={outputs.update}>
                    {() => ({
                      name: dep.name,
                      from: dep.current,
                      to: dep.latest,
                      status: "updated" as const,
                      notes: `Updated ${dep.name}`,
                    })}
                  </Task>
                ))}
              </Parallel>
            )}
            {updates.length > 0 && (
              <Task id="verify" output={outputs.verify}>
                {() => ({
                  passed: true,
                  typecheck: true,
                  tests: true,
                  build: true,
                  errors: [],
                })}
              </Task>
            )}
            <Task id="report" output={outputs.report}>
              {{
                updated: updates.filter((u) => u.status === "updated").length,
                skipped: updates.filter((u) => u.status === "skipped").length + (scan?.outdated?.filter((d) => d.breaking || d.type === "major").length ?? 0),
                failed: updates.filter((u) => u.status === "failed").length,
                breaking: scan?.outdated?.filter((d) => d.breaking).length ?? 0,
                verified: ctx.outputMaybe("verify", { nodeId: "verify" })?.passed ?? false,
                summary: "Dependency update complete",
              }}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: { directory: "." } });
    expect(r.status).toBe("finished");
    const reports = (db as any).select().from(tables.report).all();
    expect(reports.length).toBe(1);
    // lodash (patch, non-breaking) should be updated; react (major, breaking) skipped
    expect(reports[0].updated).toBe(1);
    expect(reports[0].breaking).toBe(1);
    cleanup();
  });
});

// ─── 10. discovery ──────────────────────────────────────────────────────────

describe("discovery", () => {
  const discoverySchema = z.object({
    findings: z.array(z.object({
      category: z.enum(["bug", "tech-debt", "security", "performance", "style"]),
      severity: z.enum(["critical", "high", "medium", "low"]),
      file: z.string(),
      line: z.number().optional(),
      description: z.string(),
      suggestion: z.string(),
    })),
    summary: z.string(),
    totalFiles: z.number(),
    scannedAt: z.string(),
  });

  test("single scan task produces findings", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      discovery: discoverySchema,
    });

    const workflow = smithers((ctx) => (
      <Workflow name="discovery">
        <Task id="scan" output={outputs.discovery}>
          {() => ({
            findings: [
              {
                category: "bug" as const,
                severity: "high" as const,
                file: "src/index.ts",
                line: 42,
                description: "Null pointer dereference",
                suggestion: "Add null check",
              },
              {
                category: "tech-debt" as const,
                severity: "medium" as const,
                file: "src/utils.ts",
                description: "Duplicated logic",
                suggestion: "Extract to shared function",
              },
            ],
            summary: "Found 2 issues",
            totalFiles: 15,
            scannedAt: new Date().toISOString(),
          })}
        </Task>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: { directory: ".", focus: "bugs" } });
    expect(r.status).toBe("finished");
    const rows = (db as any).select().from(tables.discovery).all();
    expect(rows.length).toBe(1);
    expect(rows[0].totalFiles).toBe(15);
    cleanup();
  });
});
