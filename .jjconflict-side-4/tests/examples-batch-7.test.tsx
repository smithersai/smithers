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

// ── 1. repo-janitor ──────────────────────────────────────────────────────────
describe("repo-janitor", () => {
  test("scans then fixes categories in parallel, produces PR summary", async () => {
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
      skipped: z.array(z.object({ file: z.string(), reason: z.string() })),
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

    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      scanResult: scanResultSchema,
      fixResult: fixResultSchema,
      prSummary: prSummarySchema,
    });

    const workflow = smithers((ctx) => {
      const scanResults = ctx.outputs.scanResult ?? [];
      const fixResults = ctx.outputs.fixResult ?? [];
      const totalFixes = fixResults.reduce((sum, r) => sum + r.fixCount, 0);

      return (
        <Workflow name="repo-janitor">
          <Sequence>
            <Task id="scan" output={outputs.scanResult}>
              {() => ({
                category: "warnings" as const,
                items: [{ file: "src/foo.ts", description: "unused import", severity: "low" as const }],
                count: 1,
              })}
            </Task>

            <Parallel maxConcurrency={3}>
              <Task
                id="fix-warnings"
                output={outputs.fixResult}
                skipIf={!scanResults.some((r) => r.category === "warnings" && r.count > 0)}
              >
                {() => ({
                  category: "warnings",
                  filesChanged: ["src/foo.ts"],
                  fixCount: 1,
                  skipped: [],
                  summary: "Removed unused import",
                })}
              </Task>
              <Task
                id="fix-todos"
                output={outputs.fixResult}
                skipIf={!scanResults.some((r) => r.category === "stale-todos" && r.count > 0)}
              >
                {() => ({
                  category: "stale-todos",
                  filesChanged: [],
                  fixCount: 0,
                  skipped: [],
                  summary: "No stale TODOs",
                })}
              </Task>
            </Parallel>

            <Task id="pr-summary" output={outputs.prSummary} skipIf={totalFixes === 0}>
              {() => ({
                title: "chore: repo janitor fixes",
                body: "Fixed 1 warning",
                totalFixes: 1,
                categories: ["warnings"],
                filesChanged: ["src/foo.ts"],
                riskLevel: "low" as const,
              })}
            </Task>

            <Task id="pr-summary-empty" output={outputs.prSummary} skipIf={totalFixes > 0}>
              {{
                title: "chore: repo janitor — no fixes needed",
                body: "No actionable items.",
                totalFixes: 0,
                categories: [],
                filesChanged: [],
                riskLevel: "low" as const,
              }}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: { repoRoot: "." } });
    expect(r.status).toBe("finished");

    const fixRows = (db as any).select().from(tables.fixResult).all();
    // fix-warnings ran, fix-todos skipped
    expect(fixRows.length).toBe(1);
    expect(fixRows[0].category).toBe("warnings");

    const prRows = (db as any).select().from(tables.prSummary).all();
    expect(prRows.length).toBe(1);
    expect(prRows[0].totalFixes).toBe(1);
    cleanup();
  });
});

// ── 2. repro-harness-builder ─────────────────────────────────────────────────
describe("repro-harness-builder", () => {
  test("analyze → build → validate sequence", async () => {
    const analysisSchema = z.object({
      title: z.string(),
      language: z.string(),
      dependencies: z.array(z.string()),
      errorSignature: z.string(),
      minimalSteps: z.array(z.string()),
      summary: z.string(),
    });
    const environmentSchema = z.object({
      baseImage: z.string(),
      dockerfile: z.string(),
      reproScript: z.string(),
      reproFiles: z.array(z.object({ path: z.string(), content: z.string() })),
      runCommand: z.string(),
      summary: z.string(),
    });
    const validationSchema = z.object({
      reproduced: z.boolean(),
      exitCode: z.number(),
      stdout: z.string(),
      stderr: z.string(),
      artifact: z.string(),
      summary: z.string(),
    });

    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      analysis: analysisSchema,
      environment: environmentSchema,
      validation: validationSchema,
    });

    const workflow = smithers((ctx) => {
      const analysis = ctx.outputMaybe("analysis", { nodeId: "analyze" });
      const environment = ctx.outputMaybe("environment", { nodeId: "build" });

      return (
        <Workflow name="repro-harness-builder">
          <Sequence>
            <Task id="analyze" output={outputs.analysis}>
              {() => ({
                title: "NPE on startup",
                language: "node",
                dependencies: ["express"],
                errorSignature: "TypeError: Cannot read properties of undefined",
                minimalSteps: ["npm install", "node index.js"],
                summary: "Null pointer in startup path",
              })}
            </Task>
            <Task id="build" output={outputs.environment}>
              {() => ({
                baseImage: "node:20-alpine",
                dockerfile: "FROM node:20-alpine\nCOPY . .\nRUN npm install",
                reproScript: "node index.js",
                reproFiles: [{ path: "index.js", content: "require('express')()" }],
                runCommand: "docker run --rm repro",
                summary: "Minimal node container",
              })}
            </Task>
            <Task id="validate" output={outputs.validation}>
              {() => ({
                reproduced: true,
                exitCode: 1,
                stdout: "",
                stderr: "TypeError: Cannot read properties of undefined",
                artifact: "repro:latest",
                summary: "Bug reproduced successfully",
              })}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: { issue: "NPE on startup" } });
    expect(r.status).toBe("finished");

    const validationRows = (db as any).select().from(tables.validation).all();
    expect(validationRows.length).toBe(1);
    expect(validationRows[0].reproduced).toBe(true);
    cleanup();
  });
});

// ── 3. retry-budget-manager ──────────────────────────────────────────────────
describe("retry-budget-manager", () => {
  test("retries until success within budget, produces report", async () => {
    const stepResultSchema = z.object({
      stepName: z.string(),
      success: z.boolean(),
      failureClass: z.enum(["transient", "persistent", "quota", "timeout", "unknown"]).optional(),
      errorMessage: z.string().optional(),
      latencyMs: z.number(),
      attempt: z.number(),
    });
    const policySchema = z.object({
      shouldRetry: z.boolean(),
      backoffMs: z.number(),
      budgetRemaining: z.number(),
      budgetSpent: z.number(),
      reasoning: z.string(),
      routeOverride: z.string().optional(),
      escalate: z.boolean(),
    });
    const escalationSchema = z.object({
      severity: z.enum(["low", "medium", "high", "critical"]),
      recommendation: z.enum(["retry-with-approval", "skip-step", "abort-workflow", "fallback-route"]),
      summary: z.string(),
      budgetAnalysis: z.string(),
      failureBreakdown: z.array(z.object({
        failureClass: z.enum(["transient", "persistent", "quota", "timeout", "unknown"]),
        count: z.number(),
        percentage: z.number(),
      })),
    });
    const reportSchema = z.object({
      totalAttempts: z.number(),
      successfulSteps: z.number(),
      failedSteps: z.number(),
      budgetUsed: z.number(),
      budgetTotal: z.number(),
      escalated: z.boolean(),
      summary: z.string(),
    });

    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      stepResult: stepResultSchema,
      policy: policySchema,
      escalation: escalationSchema,
      report: reportSchema,
    });

    let attempt = 0;
    const workflow = smithers((ctx) => {
      const stepResults = ctx.outputs.stepResult ?? [];
      const policies = ctx.outputs.policy ?? [];
      const latestPolicy = policies[policies.length - 1];
      const budget = 5;

      const budgetExhausted = (latestPolicy?.budgetRemaining ?? budget) <= 0;
      const shouldEscalate = latestPolicy?.escalate ?? false;
      const allSucceeded = stepResults.length > 0 && stepResults[stepResults.length - 1]?.success === true;
      const stopLoop = allSucceeded || budgetExhausted || shouldEscalate;

      return (
        <Workflow name="retry-budget-manager">
          <Sequence>
            <Loop until={stopLoop} maxIterations={budget} onMaxReached="return-last">
              <Sequence>
                <Task id="step" output={outputs.stepResult}>
                  {() => {
                    attempt++;
                    // Succeed on third attempt
                    if (attempt >= 3) {
                      return { stepName: "api-call", success: true, latencyMs: 50, attempt };
                    }
                    return {
                      stepName: "api-call",
                      success: false,
                      failureClass: "transient" as const,
                      errorMessage: "Connection reset",
                      latencyMs: 200,
                      attempt,
                    };
                  }}
                </Task>
                <Task
                  id="policy"
                  output={outputs.policy}
                  skipIf={stepResults[stepResults.length - 1]?.success ?? false}
                >
                  {() => ({
                    shouldRetry: true,
                    backoffMs: 100,
                    budgetRemaining: budget - attempt,
                    budgetSpent: attempt,
                    reasoning: "Transient failure, retrying",
                    escalate: false,
                  })}
                </Task>
              </Sequence>
            </Loop>

            <Task id="escalation" output={outputs.escalation} skipIf={allSucceeded}>
              {() => ({
                severity: "medium" as const,
                recommendation: "abort-workflow" as const,
                summary: "Escalated",
                budgetAnalysis: "n/a",
                failureBreakdown: [],
              })}
            </Task>

            <Task id="report" output={outputs.report}>
              {{
                totalAttempts: stepResults.length,
                successfulSteps: stepResults.filter((r) => r.success).length,
                failedSteps: stepResults.filter((r) => !r.success).length,
                budgetUsed: stepResults.length,
                budgetTotal: budget,
                escalated: !allSucceeded,
                summary: allSucceeded
                  ? `Succeeded after ${stepResults.length} attempt(s)`
                  : `Failed after ${stepResults.length} attempt(s)`,
              }}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: { stepName: "api-call", budget: 5 } });
    expect(r.status).toBe("finished");

    const stepRows = (db as any).select().from(tables.stepResult).all();
    expect(stepRows.length).toBe(3); // 2 failures + 1 success

    const reportRows = (db as any).select().from(tables.report).all();
    expect(reportRows.length).toBe(1);
    cleanup();
  });
});

// ── 4. revenue-scout ─────────────────────────────────────────────────────────
describe("revenue-scout", () => {
  test("classifies conversations, extracts opportunities, hands off to CRM", async () => {
    const opportunitySchema = z.object({
      conversations: z.array(z.object({
        id: z.string(),
        source: z.enum(["support", "form", "email"]),
        hasSignal: z.boolean(),
        signalType: z.enum(["upsell", "expansion", "cross-sell", "renewal", "none"]),
        confidence: z.number(),
        reasoning: z.string(),
      })),
    });
    const extractionSchema = z.object({
      opportunities: z.array(z.object({
        conversationId: z.string(),
        signalType: z.enum(["upsell", "expansion", "cross-sell", "renewal"]),
        product: z.string(),
        customerName: z.string(),
        accountId: z.string().optional(),
        estimatedValue: z.string().optional(),
        keyQuotes: z.array(z.string()),
        urgency: z.enum(["immediate", "near-term", "exploratory"]),
        summary: z.string(),
      })),
    });
    const handoffSchema = z.object({
      totalScanned: z.number(),
      opportunitiesFound: z.number(),
      routedToCrm: z.number(),
      bySignalType: z.record(z.string(), z.number()),
      handoffs: z.array(z.object({
        conversationId: z.string(),
        assignedRep: z.string(),
        priority: z.enum(["hot", "warm", "cool"]),
        nextStep: z.string(),
      })),
      summary: z.string(),
    });

    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      opportunity: opportunitySchema,
      extraction: extractionSchema,
      handoff: handoffSchema,
    });

    const workflow = smithers((ctx) => {
      const classified = ctx.outputMaybe("opportunity", { nodeId: "classify" });
      const flagged = classified?.conversations?.filter((c) => c.hasSignal) ?? [];

      return (
        <Workflow name="revenue-scout">
          <Sequence>
            <Task id="classify" output={outputs.opportunity}>
              {() => ({
                conversations: [
                  { id: "c1", source: "support" as const, hasSignal: true, signalType: "upsell" as const, confidence: 0.9, reasoning: "Asked about enterprise plan" },
                  { id: "c2", source: "email" as const, hasSignal: false, signalType: "none" as const, confidence: 0.1, reasoning: "General inquiry" },
                ],
              })}
            </Task>

            {flagged.length > 0 && (
              <Task id="extract" output={outputs.extraction}>
                {() => ({
                  opportunities: [{
                    conversationId: "c1",
                    signalType: "upsell" as const,
                    product: "Enterprise Plan",
                    customerName: "Acme Corp",
                    keyQuotes: ["We need more seats"],
                    urgency: "immediate" as const,
                    summary: "Upsell to enterprise",
                  }],
                })}
              </Task>
            )}

            <Task id="handoff" output={outputs.handoff}>
              {() => ({
                totalScanned: 2,
                opportunitiesFound: 1,
                routedToCrm: 1,
                bySignalType: { upsell: 1 },
                handoffs: [{ conversationId: "c1", assignedRep: "Alice", priority: "hot" as const, nextStep: "Schedule demo" }],
                summary: "1 opportunity routed",
              })}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: { source: "support" } });
    expect(r.status).toBe("finished");

    const handoffRows = (db as any).select().from(tables.handoff).all();
    expect(handoffRows.length).toBe(1);
    expect(handoffRows[0].opportunitiesFound).toBe(1);
    cleanup();
  });
});

// ── 5. review-cycle ──────────────────────────────────────────────────────────
describe("review-cycle", () => {
  test("loops implement/review until approved, produces result", async () => {
    const implementSchema = z.object({
      filesChanged: z.array(z.string()),
      approach: z.string(),
      summary: z.string(),
    });
    const reviewSchema = z.object({
      approved: z.boolean(),
      score: z.number(),
      issues: z.array(z.object({
        severity: z.enum(["blocker", "major", "minor", "nit"]),
        file: z.string(),
        description: z.string(),
        suggestion: z.string(),
      })),
      summary: z.string(),
    });
    const resultSchema = z.object({
      approved: z.boolean(),
      iterations: z.number(),
      finalScore: z.number(),
      summary: z.string(),
    });

    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      implement: implementSchema,
      review: reviewSchema,
      result: resultSchema,
    });

    let reviewCount = 0;
    const workflow = smithers((ctx) => {
      const reviews = ctx.outputs.review ?? [];
      const latestReview = reviews[reviews.length - 1];
      const isApproved = latestReview?.approved ?? false;

      return (
        <Workflow name="review-cycle">
          <Sequence>
            <Loop until={isApproved} maxIterations={5} onMaxReached="return-last">
              <Sequence>
                <Task id="implement" output={outputs.implement}>
                  {() => ({
                    filesChanged: ["src/feature.ts"],
                    approach: "Implemented feature",
                    summary: "Done",
                  })}
                </Task>
                <Task id="review" output={outputs.review}>
                  {() => {
                    reviewCount++;
                    if (reviewCount >= 2) {
                      return { approved: true, score: 9, issues: [], summary: "LGTM" };
                    }
                    return {
                      approved: false,
                      score: 5,
                      issues: [{ severity: "major" as const, file: "src/feature.ts", description: "Missing error handling", suggestion: "Add try/catch" }],
                      summary: "Needs work",
                    };
                  }}
                </Task>
              </Sequence>
            </Loop>

            <Task id="result" output={outputs.result}>
              {{
                approved: isApproved,
                iterations: reviews.length,
                finalScore: latestReview?.score ?? 0,
                summary: isApproved
                  ? `Approved after ${reviews.length} iteration(s)`
                  : `Not approved after ${reviews.length} iteration(s)`,
              }}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: { task: "Add feature" } });
    expect(r.status).toBe("finished");

    const reviewRows = (db as any).select().from(tables.review).all();
    expect(reviewRows.length).toBe(2); // 1 reject + 1 approve

    const resultRows = (db as any).select().from(tables.result).all();
    expect(resultRows.length).toBe(1);
    expect(resultRows[0].approved).toBe(true);
    cleanup();
  });
});

// ── 6. rollback-advisor ──────────────────────────────────────────────────────
describe("rollback-advisor", () => {
  test("gathers evidence, advises, branches on rollback decision", async () => {
    const evidenceSchema = z.object({
      deployment: z.string(),
      errorRate: z.number().int(),
      affectedEndpoints: z.array(z.string()),
      timeline: z.string(),
      severity: z.enum(["critical", "high", "medium", "low"]),
      rawFindings: z.string(),
    });
    const adviceSchema = z.object({
      shouldRollback: z.boolean(),
      reason: z.string(),
      mitigation: z.string(),
      rollbackSafe: z.boolean(),
      risks: z.array(z.string()),
    });
    const actionSchema = z.object({
      action: z.enum(["rollback", "mitigate", "observe"]),
      summary: z.string(),
      steps: z.array(z.string()),
    });

    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      evidence: evidenceSchema,
      advice: adviceSchema,
      action: actionSchema,
    });

    const workflow = smithers((ctx) => {
      const advice = ctx.outputMaybe("advice", { nodeId: "advise" });

      return (
        <Workflow name="rollback-advisor">
          <Sequence>
            <Task id="gather" output={outputs.evidence}>
              {() => ({
                deployment: "v2.3.1",
                errorRate: 45,
                affectedEndpoints: ["/api/users", "/api/payments"],
                timeline: "Errors started 10min after deploy",
                severity: "critical" as const,
                rawFindings: "500 errors on user and payment endpoints",
              })}
            </Task>

            <Task id="advise" output={outputs.advice}>
              {() => ({
                shouldRollback: false,
                reason: "Error rate is high but mitigation possible",
                mitigation: "Disable new feature flag. Monitor for 15min.",
                rollbackSafe: true,
                risks: ["Partial data migration"],
              })}
            </Task>

            <Task id="act" output={outputs.action}>
              {{
                action: (advice?.shouldRollback ? "rollback" : "mitigate") as "rollback" | "mitigate" | "observe",
                summary: advice?.shouldRollback
                  ? `Rollback: ${advice?.reason ?? ""}`
                  : `Mitigation plan: ${advice?.mitigation ?? "observe"}`,
                steps: advice?.shouldRollback
                  ? ["Initiate rollback", "Verify health", "Notify"]
                  : (advice?.mitigation ?? "observe").split(". ").filter(Boolean),
              }}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: { deployment: "v2.3.1" } });
    expect(r.status).toBe("finished");

    const actionRows = (db as any).select().from(tables.action).all();
    expect(actionRows.length).toBe(1);
    expect(actionRows[0].action).toBe("mitigate");
    cleanup();
  });
});

// ── 7. runbook-executor ──────────────────────────────────────────────────────
describe("runbook-executor", () => {
  test("classifies steps, executes safe ones in loop, produces review", async () => {
    const classifySchema = z.object({
      steps: z.array(z.object({
        name: z.string(),
        risk: z.enum(["safe", "risky"]),
        command: z.string(),
        reason: z.string(),
      })),
      totalSafe: z.number(),
      totalRisky: z.number(),
      summary: z.string(),
    });
    const executeSchema = z.object({
      stepName: z.string(),
      success: z.boolean(),
      output: z.string(),
      durationMs: z.number(),
      notes: z.string(),
    });
    const reviewSchema = z.object({
      allPassed: z.boolean(),
      stepsExecuted: z.number(),
      stepsFailed: z.number(),
      stepsSkipped: z.number(),
      operatorNotes: z.array(z.string()),
      summary: z.string(),
    });

    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      classify: classifySchema,
      execute: executeSchema,
      review: reviewSchema,
    });

    let execIndex = 0;
    const safeStepNames = ["check-disk", "verify-config"];

    const workflow = smithers((ctx) => {
      const classification = ctx.outputMaybe("classify", { nodeId: "classify" });
      const executions = ctx.outputs.execute ?? [];
      const safeSteps = classification?.steps.filter((s) => s.risk === "safe") ?? [];
      const allSafeDone = safeSteps.length > 0 && executions.length >= safeSteps.length;

      return (
        <Workflow name="runbook-executor">
          <Sequence>
            <Task id="classify" output={outputs.classify}>
              {() => ({
                steps: [
                  { name: "check-disk", risk: "safe" as const, command: "df -h", reason: "Read-only" },
                  { name: "verify-config", risk: "safe" as const, command: "cat /etc/app.conf", reason: "Read-only" },
                  { name: "restart-service", risk: "risky" as const, command: "systemctl restart app", reason: "Causes downtime" },
                ],
                totalSafe: 2,
                totalRisky: 1,
                summary: "3 steps classified",
              })}
            </Task>

            <Loop until={allSafeDone} maxIterations={3} onMaxReached="return-last">
              <Task id="execute" output={outputs.execute}>
                {() => {
                  const name = safeStepNames[execIndex] ?? "unknown";
                  execIndex++;
                  return {
                    stepName: name,
                    success: true,
                    output: "OK",
                    durationMs: 100,
                    notes: `Executed ${name}`,
                  };
                }}
              </Task>
            </Loop>

            <Task id="review" output={outputs.review}>
              {() => ({
                allPassed: true,
                stepsExecuted: executions.length,
                stepsFailed: 0,
                stepsSkipped: 1,
                operatorNotes: ["All safe steps passed"],
                summary: "Runbook executed successfully",
              })}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: { runbook: "deploy-checklist" } });
    expect(r.status).toBe("finished");

    const execRows = (db as any).select().from(tables.execute).all();
    // Loop runs up to maxIterations; each iteration sees outputs from previous iterations
    expect(execRows.length).toBeGreaterThanOrEqual(2);
    expect(execRows[0].stepName).toBe("check-disk");
    expect(execRows[1].stepName).toBe("verify-config");

    const reviewRows = (db as any).select().from(tables.review).all();
    expect(reviewRows.length).toBe(1);
    cleanup();
  });
});

// ── 8. scaffold ──────────────────────────────────────────────────────────────
describe("scaffold", () => {
  test("blueprints files, generates them in parallel, verifies", async () => {
    const blueprintSchema = z.object({
      files: z.array(z.object({
        path: z.string(),
        type: z.enum(["component", "test", "config", "types", "util", "route", "style"]),
        description: z.string(),
        template: z.string().optional(),
      })),
      directories: z.array(z.string()),
      totalFiles: z.number(),
    });
    const fileGenSchema = z.object({
      path: z.string(),
      created: z.boolean(),
      linesOfCode: z.number(),
      summary: z.string(),
    });
    const verifySchema = z.object({
      typecheck: z.boolean(),
      compiles: z.boolean(),
      errors: z.array(z.string()),
    });

    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      blueprint: blueprintSchema,
      fileGen: fileGenSchema,
      verify: verifySchema,
    });

    const workflow = smithers((ctx) => {
      const blueprint = ctx.outputMaybe("blueprint", { nodeId: "blueprint" });
      const generated = ctx.outputs.fileGen ?? [];

      return (
        <Workflow name="scaffold">
          <Sequence>
            <Task id="blueprint" output={outputs.blueprint}>
              {() => ({
                files: [
                  { path: "src/Button.tsx", type: "component" as const, description: "Button component" },
                  { path: "src/Button.test.tsx", type: "test" as const, description: "Button tests" },
                ],
                directories: ["src"],
                totalFiles: 2,
              })}
            </Task>

            {blueprint && (
              <Parallel maxConcurrency={5}>
                {blueprint.files.map((file) => (
                  <Task
                    key={file.path}
                    id={`gen-${file.path.replace(/\//g, "-")}`}
                    output={outputs.fileGen}
                    continueOnFail
                  >
                    {() => ({
                      path: file.path,
                      created: true,
                      linesOfCode: 25,
                      summary: `Generated ${file.path}`,
                    })}
                  </Task>
                ))}
              </Parallel>
            )}

            {generated.length > 0 && (
              <Task id="verify" output={outputs.verify}>
                {() => ({
                  typecheck: true,
                  compiles: true,
                  errors: [],
                })}
              </Task>
            )}
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: { feature: "Button", directory: "src" } });
    expect(r.status).toBe("finished");

    const genRows = (db as any).select().from(tables.fileGen).all();
    expect(genRows.length).toBe(2);

    const verifyRows = (db as any).select().from(tables.verify).all();
    expect(verifyRows.length).toBe(1);
    expect(verifyRows[0].typecheck).toBe(true);
    cleanup();
  });
});

// ── 9. schema-conformance-gate ───────────────────────────────────────────────
describe("schema-conformance-gate", () => {
  test("validates data, branches on errors vs pass", async () => {
    const validationSchema = z.object({
      passed: z.boolean(),
      violations: z.array(z.object({
        field: z.string(),
        rule: z.string(),
        message: z.string(),
        severity: z.enum(["error", "warning"]),
      })),
      checkedFields: z.number(),
    });
    const diagnosisSchema = z.object({
      rootCause: z.string(),
      suggestedFixes: z.array(z.string()),
      canAutoFix: z.boolean(),
    });
    const resultSchema = z.object({
      status: z.enum(["passed", "failed", "warning"]),
      errorCount: z.number(),
      warningCount: z.number(),
      diagnosis: z.string().optional(),
      summary: z.string(),
    });

    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      validation: validationSchema,
      diagnosis: diagnosisSchema,
      result: resultSchema,
    });

    // Test the passing path
    const workflow = smithers((ctx) => {
      const validation = ctx.outputMaybe("validation", { nodeId: "validate" });
      const diagnosis = ctx.outputMaybe("diagnosis", { nodeId: "diagnose" });

      const errors = (validation?.violations ?? []).filter((v) => v.severity === "error");
      const warnings = (validation?.violations ?? []).filter((v) => v.severity === "warning");
      const hasErrors = errors.length > 0;
      const hasWarnings = warnings.length > 0;

      return (
        <Workflow name="schema-conformance-gate">
          <Sequence>
            <Task id="validate" output={outputs.validation}>
              {() => ({
                passed: true,
                violations: [
                  { field: "email", rule: "format", message: "Consider validating TLD", severity: "warning" as const },
                ],
                checkedFields: 5,
              })}
            </Task>

            <Branch
              if={hasErrors}
              then={
                <Sequence>
                  <Task id="diagnose" output={outputs.diagnosis}>
                    {() => ({
                      rootCause: "Type mismatch",
                      suggestedFixes: ["Cast to string"],
                      canAutoFix: true,
                    })}
                  </Task>
                  <Task id="fail-result" output={outputs.result}>
                    {{
                      status: "failed" as const,
                      errorCount: errors.length,
                      warningCount: warnings.length,
                      diagnosis: diagnosis?.rootCause ?? "Unknown",
                      summary: "Failed",
                    }}
                  </Task>
                </Sequence>
              }
              else={
                <Task id="pass-result" output={outputs.result}>
                  {{
                    status: hasWarnings ? ("warning" as const) : ("passed" as const),
                    errorCount: 0,
                    warningCount: warnings.length,
                    summary: hasWarnings
                      ? `Passed with ${warnings.length} warning(s)`
                      : `All ${validation?.checkedFields ?? 0} fields conform`,
                  }}
                </Task>
              }
            />
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: { data: { name: "test" } } });
    expect(r.status).toBe("finished");

    const resultRows = (db as any).select().from(tables.result).all();
    expect(resultRows.length).toBe(1);
    expect(resultRows[0].status).toBe("warning");
    expect(resultRows[0].warningCount).toBe(1);

    // Diagnose should NOT have been called (no errors)
    const diagRows = (db as any).select().from(tables.diagnosis).all();
    expect(diagRows.length).toBe(0);
    cleanup();
  });
});

// ── 10. service-desk-dispatcher ──────────────────────────────────────────────
describe("service-desk-dispatcher", () => {
  test("intakes tickets, classifies, dispatches handlers, produces report", async () => {
    const intakeSchema = z.object({
      tickets: z.array(z.object({
        id: z.string(),
        title: z.string(),
        description: z.string(),
        submitter: z.string(),
      })),
      totalReceived: z.number(),
    });
    const classificationSchema = z.object({
      classified: z.array(z.object({
        id: z.string(),
        title: z.string(),
        category: z.enum(["incident", "request", "policy"]),
        urgency: z.enum(["critical", "high", "medium", "low"]),
        reasoning: z.string(),
      })),
    });
    const handlerResultSchema = z.object({
      ticketId: z.string(),
      action: z.string(),
      status: z.enum(["resolved", "escalated", "pending"]),
      resolution: z.string(),
    });
    const dispatchReportSchema = z.object({
      totalTickets: z.number(),
      incidents: z.number(),
      requests: z.number(),
      policyQuestions: z.number(),
      resolved: z.number(),
      escalated: z.number(),
      pending: z.number(),
      summary: z.string(),
    });

    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      intake: intakeSchema,
      classification: classificationSchema,
      handlerResult: handlerResultSchema,
      dispatchReport: dispatchReportSchema,
    });

    const workflow = smithers((ctx) => {
      const classification = ctx.outputMaybe("classification", { nodeId: "classify" });
      const classifiedTickets = classification?.classified ?? [];
      const results = ctx.outputs.handlerResult ?? [];

      return (
        <Workflow name="service-desk-dispatcher">
          <Sequence>
            <Task id="intake" output={outputs.intake}>
              {() => ({
                tickets: [
                  { id: "T-1", title: "API down", description: "500 errors", submitter: "alice" },
                  { id: "T-2", title: "Need VPN access", description: "New hire", submitter: "bob" },
                ],
                totalReceived: 2,
              })}
            </Task>

            <Task id="classify" output={outputs.classification}>
              {() => ({
                classified: [
                  { id: "T-1", title: "API down", category: "incident" as const, urgency: "critical" as const, reasoning: "Production outage" },
                  { id: "T-2", title: "Need VPN access", category: "request" as const, urgency: "medium" as const, reasoning: "Standard provisioning" },
                ],
              })}
            </Task>

            {classifiedTickets.length > 0 && (
              <Parallel maxConcurrency={5}>
                {classifiedTickets.map((ticket) => (
                  <Task
                    key={ticket.id}
                    id={`handle-${ticket.id}`}
                    output={outputs.handlerResult}
                    continueOnFail
                  >
                    {() => ({
                      ticketId: ticket.id,
                      action: ticket.category === "incident" ? "Investigated and mitigated" : "Provisioned access",
                      status: "resolved" as const,
                      resolution: `Handled ${ticket.category} ticket ${ticket.id}`,
                    })}
                  </Task>
                ))}
              </Parallel>
            )}

            <Task id="report" output={outputs.dispatchReport}>
              {{
                totalTickets: classifiedTickets.length,
                incidents: classifiedTickets.filter((t) => t.category === "incident").length,
                requests: classifiedTickets.filter((t) => t.category === "request").length,
                policyQuestions: classifiedTickets.filter((t) => t.category === "policy").length,
                resolved: results.filter((r) => r.status === "resolved").length,
                escalated: results.filter((r) => r.status === "escalated").length,
                pending: results.filter((r) => r.status === "pending").length,
                summary: `Dispatched ${classifiedTickets.length} tickets`,
              }}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: { source: "queue" } });
    expect(r.status).toBe("finished");

    const handlerRows = (db as any).select().from(tables.handlerResult).all();
    expect(handlerRows.length).toBe(2);

    const reportRows = (db as any).select().from(tables.dispatchReport).all();
    expect(reportRows.length).toBe(1);
    expect(reportRows[0].totalTickets).toBe(2);
    expect(reportRows[0].incidents).toBe(1);
    expect(reportRows[0].requests).toBe(1);
    cleanup();
  });
});
