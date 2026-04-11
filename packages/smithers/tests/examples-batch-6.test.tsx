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
  Approval,
  runWorkflow,
} from "../src/index";
import { createTestSmithers } from "./helpers";
import { z } from "zod";

// ─── 1. panel.tsx ──────────────────────────────────────────────────────────────
describe("panel", () => {
  test("fan-out specialist reviews then fan-in synthesis", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      specialistReview: z.object({
        role: z.string(),
        verdict: z.enum(["approve", "request-changes", "comment"]),
        findings: z.array(z.object({
          severity: z.enum(["critical", "warning", "info"]),
          description: z.string(),
        })),
        summary: z.string(),
      }),
      synthesis: z.object({
        overallVerdict: z.enum(["approve", "request-changes", "comment"]),
        criticalIssues: z.array(z.string()),
        suggestions: z.array(z.string()),
        summary: z.string(),
      }),
    });

    const order: string[] = [];
    const workflow = smithers(() => (
      <Workflow name="panel">
        <Sequence>
          <Parallel>
            <Task id="review-security" output={outputs.specialistReview}>
              {() => {
                order.push("security");
                return { role: "Security", verdict: "approve" as const, findings: [], summary: "No issues" };
              }}
            </Task>
            <Task id="review-quality" output={outputs.specialistReview}>
              {() => {
                order.push("quality");
                return { role: "Quality", verdict: "comment" as const, findings: [{ severity: "warning" as const, description: "naming" }], summary: "Minor nit" };
              }}
            </Task>
          </Parallel>
          <Task id="synthesis" output={outputs.synthesis}>
            {() => {
              order.push("synthesis");
              return { overallVerdict: "approve" as const, criticalIssues: [], suggestions: ["fix naming"], summary: "Good" };
            }}
          </Task>
        </Sequence>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {}, maxConcurrency: 4 });
    expect(r.status).toBe("finished");
    // synthesis must come after both reviews
    expect(order.indexOf("synthesis")).toBeGreaterThan(order.indexOf("security"));
    expect(order.indexOf("synthesis")).toBeGreaterThan(order.indexOf("quality"));
    const synthRows = (db as any).select().from(tables.synthesis).all();
    expect(synthRows.length).toBe(1);
    expect(synthRows[0].overallVerdict).toBe("approve");
    cleanup();
  });
});

// ─── 2. patch-plausibility-gate.tsx ────────────────────────────────────────────
describe("patch-plausibility-gate", () => {
  test("patch → parallel verify → gate → finalize", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      patch: z.object({
        patchDescription: z.string(),
        filesChanged: z.array(z.string()),
        diffSummary: z.string(),
      }),
      verify: z.object({
        check: z.enum(["lint", "test", "build"]),
        passed: z.boolean(),
        output: z.string(),
        errorCount: z.number(),
        details: z.string(),
      }),
      gate: z.object({
        promoted: z.boolean(),
        passedChecks: z.array(z.string()),
        failedChecks: z.array(z.string()),
        plausibilityScore: z.number().int(),
        reasoning: z.string(),
      }),
      finalize: z.object({
        action: z.enum(["merge", "comment", "update"]),
        message: z.string(),
        summary: z.string(),
      }),
    });

    const workflow = smithers((ctx) => {
      const patch = ctx.outputMaybe("patch", { nodeId: "patch" });
      const verifyResults = ctx.outputs.verify ?? [];
      const gateResult = ctx.outputMaybe("gate", { nodeId: "gate" });

      return (
        <Workflow name="patch-plausibility-gate">
          <Sequence>
            <Task id="patch" output={outputs.patch}>
              {() => ({ patchDescription: "fix bug", filesChanged: ["a.ts"], diffSummary: "+1 -1" })}
            </Task>

            {patch && (
              <Parallel>
                <Task id="lint" output={outputs.verify} continueOnFail>
                  {() => ({ check: "lint" as const, passed: true, output: "ok", errorCount: 0, details: "clean" })}
                </Task>
                <Task id="test" output={outputs.verify} continueOnFail>
                  {() => ({ check: "test" as const, passed: true, output: "ok", errorCount: 0, details: "all pass" })}
                </Task>
                <Task id="build" output={outputs.verify} continueOnFail>
                  {() => ({ check: "build" as const, passed: false, output: "err", errorCount: 1, details: "type error" })}
                </Task>
              </Parallel>
            )}

            <Task id="gate" output={outputs.gate}>
              {() => ({
                promoted: false,
                passedChecks: ["lint", "test"],
                failedChecks: ["build"],
                plausibilityScore: 1,
                reasoning: "build failed",
              })}
            </Task>

            <Task id="finalize" output={outputs.finalize}>
              {() => ({
                action: "comment" as const,
                message: "Build failed — please fix",
                summary: "Blocked by build failure",
              })}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    const gateRows = (db as any).select().from(tables.gate).all();
    expect(gateRows[0].promoted).toBe(false);
    const finalRows = (db as any).select().from(tables.finalize).all();
    expect(finalRows[0].action).toBe("comment");
    cleanup();
  });
});

// ─── 3. plan.tsx ───────────────────────────────────────────────────────────────
describe("plan", () => {
  test("single planning task produces structured plan", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      plan: z.object({
        goal: z.string(),
        tasks: z.array(z.object({
          id: z.string(),
          title: z.string(),
          description: z.string(),
          priority: z.enum(["p0", "p1", "p2"]),
          estimatedComplexity: z.enum(["trivial", "small", "medium", "large"]),
          dependencies: z.array(z.string()),
          files: z.array(z.string()),
        })),
        criticalPath: z.array(z.string()),
        risks: z.array(z.string()),
      }),
    });

    const workflow = smithers(() => (
      <Workflow name="plan">
        <Task id="plan" output={outputs.plan}>
          {() => ({
            goal: "migrate to ESM",
            tasks: [
              { id: "t1", title: "Update tsconfig", description: "Set module to esnext", priority: "p0" as const, estimatedComplexity: "small" as const, dependencies: [], files: ["tsconfig.json"] },
              { id: "t2", title: "Fix imports", description: "Add .js extensions", priority: "p0" as const, estimatedComplexity: "large" as const, dependencies: ["t1"], files: ["src/**"] },
            ],
            criticalPath: ["t1", "t2"],
            risks: ["breaking changes"],
          })}
        </Task>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    const rows = (db as any).select().from(tables.plan).all();
    expect(rows.length).toBe(1);
    expect(rows[0].goal).toBe("migrate to ESM");
    cleanup();
  });
});

// ─── 4. pr-lifecycle.tsx ───────────────────────────────────────────────────────
describe("pr-lifecycle", () => {
  test("rebase → review → push → poll-ci loop → merge", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      rebase: z.object({
        conflicts: z.boolean(),
        conflictFiles: z.array(z.string()),
        summary: z.string(),
      }),
      review: z.object({
        issues: z.array(z.object({
          file: z.string(),
          severity: z.enum(["critical", "warning", "nit"]),
          description: z.string(),
        })),
        approved: z.boolean(),
        summary: z.string(),
      }),
      ci: z.object({
        status: z.enum(["pass", "fail", "pending"]),
        checks: z.array(z.object({ name: z.string(), status: z.enum(["pass", "fail", "pending"]) })),
        mergeable: z.boolean(),
      }),
      merge: z.object({
        merged: z.boolean(),
        sha: z.string().optional(),
        error: z.string().optional(),
      }),
    });

    let pollCount = 0;
    const workflow = smithers((ctx) => {
      const rebase = ctx.outputMaybe("rebase", { nodeId: "rebase" });
      const review = ctx.outputMaybe("review", { nodeId: "review" });
      const ci = ctx.outputMaybe("ci", { nodeId: "poll-ci" });

      return (
        <Workflow name="pr-lifecycle">
          <Sequence>
            <Task id="rebase" output={outputs.rebase}>
              {() => ({ conflicts: false, conflictFiles: [], summary: "clean rebase" })}
            </Task>
            <Task id="review" output={outputs.review} skipIf={rebase?.conflicts ?? false}>
              {() => ({ issues: [], approved: true, summary: "LGTM" })}
            </Task>
            <Task id="push" output={outputs.rebase} skipIf={!(review?.approved)}>
              {() => ({ conflicts: false, conflictFiles: [], summary: "pushed" })}
            </Task>
            <Loop until={ci?.status === "pass"} maxIterations={5} onMaxReached="return-last">
              <Task id="poll-ci" output={outputs.ci}>
                {() => {
                  pollCount++;
                  if (pollCount < 2) return { status: "pending" as const, checks: [{ name: "ci", status: "pending" as const }], mergeable: false };
                  return { status: "pass" as const, checks: [{ name: "ci", status: "pass" as const }], mergeable: true };
                }}
              </Task>
            </Loop>
            <Task id="merge" output={outputs.merge} skipIf={!ci?.mergeable}>
              {() => ({ merged: true, sha: "abc123" })}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    expect(pollCount).toBeGreaterThanOrEqual(2);
    const mergeRows = (db as any).select().from(tables.merge).all();
    expect(mergeRows.length).toBe(1);
    expect(mergeRows[0].merged).toBe(true);
    cleanup();
  });
});

// ─── 5. pr-shepherd.tsx ────────────────────────────────────────────────────────
describe("pr-shepherd", () => {
  test("parallel gather → review → report", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      diff: z.object({
        changedFiles: z.array(z.string()),
        additions: z.number(),
        deletions: z.number(),
        riskAreas: z.array(z.string()),
      }),
      testResults: z.object({
        passed: z.number(),
        failed: z.number(),
        skipped: z.number(),
        failingSuites: z.array(z.string()),
      }),
      prContext: z.object({
        title: z.string(),
        author: z.string(),
        labels: z.array(z.string()),
        baseBranch: z.string(),
      }),
      review: z.object({
        disposition: z.enum(["approve", "request-changes", "comment"]),
        comments: z.array(z.object({
          file: z.string(),
          line: z.number(),
          severity: z.enum(["critical", "warning", "suggestion", "nit"]),
          body: z.string(),
        })),
        summary: z.string(),
      }),
      report: z.object({
        prNumber: z.number(),
        disposition: z.enum(["approve", "request-changes", "comment"]),
        criticalCount: z.number(),
        warningCount: z.number(),
        testStatus: z.enum(["passing", "failing", "unknown"]),
        needsRerun: z.boolean(),
        summary: z.string(),
      }),
    });

    const order: string[] = [];
    const workflow = smithers((ctx) => {
      const review = ctx.outputMaybe("review", { nodeId: "reviewer" });
      return (
        <Workflow name="pr-shepherd">
          <Sequence>
            <Parallel>
              <Task id="gather-diff" output={outputs.diff}>
                {() => { order.push("diff"); return { changedFiles: ["a.ts"], additions: 10, deletions: 2, riskAreas: [] }; }}
              </Task>
              <Task id="gather-tests" output={outputs.testResults} continueOnFail>
                {() => { order.push("tests"); return { passed: 5, failed: 0, skipped: 0, failingSuites: [] }; }}
              </Task>
              <Task id="gather-context" output={outputs.prContext}>
                {() => { order.push("ctx"); return { title: "Fix bug", author: "dev", labels: [], baseBranch: "main" }; }}
              </Task>
            </Parallel>
            <Task id="reviewer" output={outputs.review}>
              {() => {
                order.push("review");
                return {
                  disposition: "approve" as const,
                  comments: [{ file: "a.ts", line: 1, severity: "nit" as const, body: "consider renaming" }],
                  summary: "Looks good",
                };
              }}
            </Task>
            {review && (
              <Task id="report" output={outputs.report}>
                {() => {
                  order.push("report");
                  return {
                    prNumber: 42,
                    disposition: review.disposition,
                    criticalCount: 0,
                    warningCount: 0,
                    testStatus: "passing" as const,
                    needsRerun: false,
                    summary: "All clear",
                  };
                }}
              </Task>
            )}
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: {}, maxConcurrency: 3 });
    expect(r.status).toBe("finished");
    expect(order.indexOf("review")).toBeGreaterThan(order.indexOf("diff"));
    expect(order.indexOf("report")).toBeGreaterThan(order.indexOf("review"));
    const reportRows = (db as any).select().from(tables.report).all();
    expect(reportRows[0].disposition).toBe("approve");
    cleanup();
  });
});

// ─── 6. prompt-optimizer-harness.tsx ───────────────────────────────────────────
describe("prompt-optimizer-harness", () => {
  test("loop generates candidate, evaluates, optimizes until target hit", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      candidate: z.object({
        name: z.string(),
        promptText: z.string(),
        iter: z.number(),
      }),
      evalResult: z.object({
        candidateName: z.string(),
        passed: z.number(),
        failed: z.number(),
        totalScore: z.number(),
        maxScore: z.number(),
        failures: z.array(z.object({
          testCase: z.string(),
          expected: z.string(),
          actual: z.string(),
          reason: z.string(),
        })),
      }),
      optimize: z.object({
        revisedPromptText: z.string(),
        changesApplied: z.array(z.string()),
        targetedFailures: z.number(),
        summary: z.string(),
      }),
      report: z.object({
        bestCandidate: z.string(),
        bestScore: z.number(),
        totalIterations: z.number(),
        finalPromptText: z.string(),
        summary: z.string(),
      }),
    });

    let iteration = 0;
    const workflow = smithers((ctx) => {
      const evals = ctx.outputs.evalResult ?? [];
      const latestEval = evals[evals.length - 1];
      const latestScore = latestEval ? Math.round((latestEval.totalScore / latestEval.maxScore) * 100) : 0;
      const hitTarget = latestScore >= 90;

      return (
        <Workflow name="prompt-optimizer-harness">
          <Sequence>
            <Loop until={hitTarget} maxIterations={3} onMaxReached="return-last">
              <Sequence>
                <Task id="candidate" output={outputs.candidate}>
                  {() => {
                    iteration++;
                    return { name: `v${iteration}`, promptText: `prompt v${iteration}`, iter: iteration };
                  }}
                </Task>
                <Task id="evalResult" output={outputs.evalResult}>
                  {() => ({
                    candidateName: `v${iteration}`,
                    passed: iteration >= 2 ? 9 : 5,
                    failed: iteration >= 2 ? 1 : 5,
                    totalScore: iteration >= 2 ? 90 : 50,
                    maxScore: 100,
                    failures: iteration >= 2 ? [] : [{ testCase: "t1", expected: "a", actual: "b", reason: "mismatch" }],
                  })}
                </Task>
                <Task id="optimize" output={outputs.optimize} skipIf={hitTarget}>
                  {() => ({
                    revisedPromptText: `optimized v${iteration}`,
                    changesApplied: ["clarity"],
                    targetedFailures: 1,
                    summary: "improved",
                  })}
                </Task>
              </Sequence>
            </Loop>
            <Task id="report" output={outputs.report}>
              {() => ({
                bestCandidate: `v${iteration}`,
                bestScore: 90,
                totalIterations: iteration,
                finalPromptText: `optimized v${iteration}`,
                summary: "done",
              })}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    expect(iteration).toBeGreaterThanOrEqual(2);
    const reportRows = (db as any).select().from(tables.report).all();
    expect(reportRows.length).toBe(1);
    expect(reportRows[0].bestScore).toBe(90);
    cleanup();
  });
});

// ─── 7. ralph-loop.tsx ─────────────────────────────────────────────────────────
describe("ralph-loop", () => {
  test("ralph loops with until=false up to maxIterations", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      check: z.object({ status: z.string() }),
    });

    let count = 0;
    const workflow = smithers(() => (
      <Workflow name="ralph-loop">
        <Ralph until={false} maxIterations={3}>
          <Task id="check" output={outputs.check}>
            {() => { count++; return { status: "ok" }; }}
          </Task>
        </Ralph>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    expect(count).toBe(3);
    const rows = (db as any).select().from(tables.check).all();
    expect(rows.length).toBe(3);
    cleanup();
  });
});

// ─── 8. ransomware-isolation-coordinator.tsx ───────────────────────────────────
describe("ransomware-isolation-coordinator", () => {
  test("detect → branch on isolate → report (no isolation path)", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      detection: z.object({
        hostId: z.string(),
        indicators: z.array(z.string()),
        severity: z.enum(["low", "medium", "high", "critical"]),
        isolateRecommended: z.boolean(),
      }),
      containment: z.object({
        hostId: z.string(),
        networkIsolated: z.boolean(),
        evidenceSnapshotUrl: z.string(),
        notifiedChannels: z.array(z.string()),
      }),
      approval: z.object({
        approved: z.boolean(),
        approvedBy: z.string(),
        note: z.string(),
      }),
      report: z.object({
        incidentId: z.string(),
        timeline: z.array(z.string()),
        containmentStatus: z.enum(["contained", "monitoring", "escalated"]),
        summary: z.string(),
      }),
    });

    const workflow = smithers((ctx) => {
      const detection = ctx.outputMaybe("detection", { nodeId: "detect" });
      return (
        <Workflow name="ransomware-isolation-coordinator">
          <Sequence>
            <Task id="detect" output={outputs.detection}>
              {() => ({
                hostId: "host-1",
                indicators: ["suspicious file rename"],
                severity: "low" as const,
                isolateRecommended: false,
              })}
            </Task>
            <Branch
              if={detection?.isolateRecommended ?? false}
              then={
                <Task id="contain" output={outputs.containment}>
                  {() => ({ hostId: "host-1", networkIsolated: true, evidenceSnapshotUrl: "s3://snap", notifiedChannels: ["#ir"] })}
                </Task>
              }
              else={null}
            />
            <Task id="report" output={outputs.report}>
              {() => ({
                incidentId: "INC-001",
                timeline: ["detected"],
                containmentStatus: "monitoring" as const,
                summary: "Low severity, no isolation needed",
              })}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    const containRows = (db as any).select().from(tables.containment).all();
    expect(containRows.length).toBe(0); // branch not taken
    const reportRows = (db as any).select().from(tables.report).all();
    expect(reportRows[0].containmentStatus).toBe("monitoring");
    cleanup();
  });

  test("detect → branch taken → containment → report", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      detection: z.object({
        hostId: z.string(),
        indicators: z.array(z.string()),
        severity: z.enum(["low", "medium", "high", "critical"]),
        isolateRecommended: z.boolean(),
      }),
      containment: z.object({
        hostId: z.string(),
        networkIsolated: z.boolean(),
        evidenceSnapshotUrl: z.string(),
        notifiedChannels: z.array(z.string()),
      }),
      report: z.object({
        incidentId: z.string(),
        timeline: z.array(z.string()),
        containmentStatus: z.enum(["contained", "monitoring", "escalated"]),
        summary: z.string(),
      }),
    });

    const workflow = smithers((ctx) => {
      const detection = ctx.outputMaybe("detection", { nodeId: "detect" });
      return (
        <Workflow name="ransomware-isolation-coordinator-2">
          <Sequence>
            <Task id="detect" output={outputs.detection}>
              {() => ({
                hostId: "host-2",
                indicators: ["encryption detected"],
                severity: "critical" as const,
                isolateRecommended: true,
              })}
            </Task>
            <Branch
              if={detection?.isolateRecommended ?? false}
              then={
                <Task id="contain" output={outputs.containment}>
                  {() => ({
                    hostId: "host-2",
                    networkIsolated: true,
                    evidenceSnapshotUrl: "s3://snap-2",
                    notifiedChannels: ["#ir", "#sec"],
                  })}
                </Task>
              }
              else={null}
            />
            <Task id="report" output={outputs.report}>
              {() => ({
                incidentId: "INC-002",
                timeline: ["detected", "contained"],
                containmentStatus: "contained" as const,
                summary: "Critical — host isolated",
              })}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    const containRows = (db as any).select().from(tables.containment).all();
    expect(containRows.length).toBe(1);
    expect(containRows[0].networkIsolated).toBe(true);
    cleanup();
  });
});

// ─── 9. receipt-stream-watcher.tsx ─────────────────────────────────────────────
describe("receipt-stream-watcher", () => {
  test("extract → consume → conditional route when confident", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      extraction: z.object({
        merchant: z.object({ value: z.string().nullable(), confidence: z.number() }),
        total: z.object({ value: z.string().nullable(), confidence: z.number() }),
        date: z.object({ value: z.string().nullable(), confidence: z.number() }),
        currency: z.object({ value: z.string().nullable(), confidence: z.number() }),
        iterationsUsed: z.number(),
        complete: z.boolean(),
      }),
      consumed: z.object({
        merchant: z.string().nullable(),
        totalCents: z.number().nullable(),
        date: z.string().nullable(),
        currency: z.string().nullable(),
        highConfidenceCount: z.number(),
        readyForRouting: z.boolean(),
        summary: z.string(),
      }),
      routing: z.object({
        destination: z.enum(["expense-report", "reimbursement", "audit-review", "manual-review"]),
        merchant: z.string(),
        totalCents: z.number(),
        currency: z.string(),
        date: z.string(),
        reasoning: z.string(),
        summary: z.string(),
      }),
    });

    const workflow = smithers((ctx) => {
      const consumed = ctx.outputMaybe("consumed", { nodeId: "consume" });
      return (
        <Workflow name="receipt-stream-watcher">
          <Sequence>
            <Task id="extract" output={outputs.extraction}>
              {() => ({
                merchant: { value: "Acme Corp", confidence: 0.95 },
                total: { value: "42.50", confidence: 0.92 },
                date: { value: "2025-01-15", confidence: 0.88 },
                currency: { value: "USD", confidence: 0.99 },
                iterationsUsed: 1,
                complete: true,
              })}
            </Task>
            <Task id="consume" output={outputs.consumed}>
              {() => ({
                merchant: "Acme Corp",
                totalCents: 4250,
                date: "2025-01-15",
                currency: "USD",
                highConfidenceCount: 4,
                readyForRouting: true,
                summary: "All fields high confidence",
              })}
            </Task>
            {(consumed?.readyForRouting ?? false) && (
              <Task id="route" output={outputs.routing}>
                {() => ({
                  destination: "expense-report" as const,
                  merchant: "Acme Corp",
                  totalCents: 4250,
                  currency: "USD",
                  date: "2025-01-15",
                  reasoning: "Standard business expense",
                  summary: "Routed to expense-report",
                })}
              </Task>
            )}
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    const routeRows = (db as any).select().from(tables.routing).all();
    expect(routeRows.length).toBe(1);
    expect(routeRows[0].destination).toBe("expense-report");
    cleanup();
  });

  test("skips routing when not ready", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      extraction: z.object({
        merchant: z.object({ value: z.string().nullable(), confidence: z.number() }),
        total: z.object({ value: z.string().nullable(), confidence: z.number() }),
        date: z.object({ value: z.string().nullable(), confidence: z.number() }),
        currency: z.object({ value: z.string().nullable(), confidence: z.number() }),
        iterationsUsed: z.number(),
        complete: z.boolean(),
      }),
      consumed: z.object({
        highConfidenceCount: z.number(),
        readyForRouting: z.boolean(),
        summary: z.string(),
      }),
      routing: z.object({
        destination: z.enum(["expense-report", "reimbursement", "audit-review", "manual-review"]),
        merchant: z.string(),
        totalCents: z.number(),
        currency: z.string(),
        date: z.string(),
        reasoning: z.string(),
        summary: z.string(),
      }),
    });

    const workflow = smithers((ctx) => {
      const consumed = ctx.outputMaybe("consumed", { nodeId: "consume" });
      return (
        <Workflow name="receipt-stream-watcher-no-route">
          <Sequence>
            <Task id="extract" output={outputs.extraction}>
              {() => ({
                merchant: { value: null, confidence: 0.2 },
                total: { value: "10", confidence: 0.5 },
                date: { value: null, confidence: 0.1 },
                currency: { value: "USD", confidence: 0.9 },
                iterationsUsed: 1,
                complete: false,
              })}
            </Task>
            <Task id="consume" output={outputs.consumed}>
              {() => ({ highConfidenceCount: 1, readyForRouting: false, summary: "Insufficient data" })}
            </Task>
            {(consumed?.readyForRouting ?? false) && (
              <Task id="route" output={outputs.routing}>
                {() => ({
                  destination: "manual-review" as const,
                  merchant: "unknown",
                  totalCents: 0,
                  currency: "USD",
                  date: "unknown",
                  reasoning: "fallback",
                  summary: "manual",
                })}
              </Task>
            )}
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    const routeRows = (db as any).select().from(tables.routing).all();
    expect(routeRows.length).toBe(0);
    cleanup();
  });
});

// ─── 10. refactor.tsx ──────────────────────────────────────────────────────────
describe("refactor", () => {
  test("analyze → parallel refactor → verify → summary", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      analysis: z.object({
        targets: z.array(z.object({
          file: z.string(),
          pattern: z.string(),
          occurrences: z.number(),
          complexity: z.enum(["simple", "moderate", "complex"]),
        })),
        totalOccurrences: z.number(),
        estimatedImpact: z.string(),
      }),
      change: z.object({
        file: z.string(),
        status: z.enum(["refactored", "skipped", "failed"]),
        changes: z.string(),
        linesChanged: z.number(),
      }),
      verify: z.object({
        typecheck: z.boolean(),
        tests: z.boolean(),
        lint: z.boolean(),
        errors: z.array(z.string()),
        passed: z.boolean(),
      }),
      summary: z.object({
        totalTargets: z.number(),
        refactored: z.number(),
        skipped: z.number(),
        failed: z.number(),
        verified: z.boolean(),
        summary: z.string(),
      }),
    });

    const workflow = smithers((ctx) => {
      const analysis = ctx.outputMaybe("analysis", { nodeId: "analyze" });
      const changes = ctx.outputs.change ?? [];
      const verification = ctx.outputMaybe("verify", { nodeId: "verify" });

      return (
        <Workflow name="refactor">
          <Sequence>
            <Task id="analyze" output={outputs.analysis}>
              {() => ({
                targets: [
                  { file: "src/a.ts", pattern: "var ", occurrences: 3, complexity: "simple" as const },
                  { file: "src/b.ts", pattern: "var ", occurrences: 1, complexity: "simple" as const },
                ],
                totalOccurrences: 4,
                estimatedImpact: "low risk",
              })}
            </Task>

            {analysis && (
              <Parallel>
                {analysis.targets.map((target) => (
                  <Task
                    key={target.file}
                    id={`refactor-${target.file.replace(/\//g, "-")}`}
                    output={outputs.change}
                    continueOnFail
                  >
                    {() => ({
                      file: target.file,
                      status: "refactored" as const,
                      changes: `replaced ${target.occurrences} var with const`,
                      linesChanged: target.occurrences,
                    })}
                  </Task>
                ))}
              </Parallel>
            )}

            {changes.length > 0 && (
              <Task id="verify" output={outputs.verify}>
                {() => ({ typecheck: true, tests: true, lint: true, errors: [], passed: true })}
              </Task>
            )}

            <Task id="summary" output={outputs.summary}>
              {() => ({
                totalTargets: analysis?.targets.length ?? 0,
                refactored: changes.filter((c) => c.status === "refactored").length,
                skipped: changes.filter((c) => c.status === "skipped").length,
                failed: changes.filter((c) => c.status === "failed").length,
                verified: verification?.passed ?? false,
                summary: `Refactored ${changes.filter((c) => c.status === "refactored").length} files`,
              })}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    const changeRows = (db as any).select().from(tables.change).all();
    expect(changeRows.length).toBe(2);
    const summaryRows = (db as any).select().from(tables.summary).all();
    expect(summaryRows[0].refactored).toBe(2);
    expect(summaryRows[0].verified).toBe(true);
    cleanup();
  });
});
