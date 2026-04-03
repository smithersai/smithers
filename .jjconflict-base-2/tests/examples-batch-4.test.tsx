/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import {
  Workflow,
  Task,
  Sequence,
  Parallel,
  Loop,
  Branch,
  Ralph,
  runWorkflow,
} from "../src/index";
import { createTestSmithers } from "./helpers";
import { z } from "zod";

// ============================================================================
// 1. feedback-pulse — 3-step sequence: intake → extract → notify
// ============================================================================
describe("feedback-pulse", () => {
  test("runs intake → extraction → notification sequence", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      intake: z.object({
        items: z.array(z.object({ id: z.string(), text: z.string() })),
        totalCount: z.number(),
        summary: z.string(),
      }),
      extraction: z.object({
        themes: z.array(z.object({ name: z.string(), count: z.number() })),
        painPoints: z.array(z.object({ description: z.string(), severity: z.string() })),
        summary: z.string(),
      }),
      notification: z.object({
        slackMessages: z.array(z.object({ channel: z.string(), message: z.string() })),
        summary: z.string(),
      }),
    });

    const order: string[] = [];
    const workflow = smithers((ctx) => {
      const intake = ctx.outputMaybe("intake", { nodeId: "intake" });
      const extraction = ctx.outputMaybe("extraction", { nodeId: "extract" });
      return (
        <Workflow name="feedback-pulse">
          <Sequence>
            <Task id="intake" output={outputs.intake}>
              {() => {
                order.push("intake");
                return {
                  items: [{ id: "f1", text: "Login is slow" }, { id: "f2", text: "Love the new UI" }],
                  totalCount: 2,
                  summary: "2 feedback items",
                };
              }}
            </Task>
            <Task id="extract" output={outputs.extraction}>
              {() => {
                order.push("extract");
                return {
                  themes: [{ name: "performance", count: 1 }, { name: "ui", count: 1 }],
                  painPoints: [{ description: "Slow login", severity: "high" }],
                  summary: "1 pain point found",
                };
              }}
            </Task>
            <Task id="notify" output={outputs.notification}>
              {() => {
                order.push("notify");
                return {
                  slackMessages: [{ channel: "#product", message: "Slow login reported" }],
                  summary: "1 Slack message sent",
                };
              }}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: { feedback: [] } });
    expect(r.status).toBe("finished");
    expect(order).toEqual(["intake", "extract", "notify"]);
    const notifRows = (db as any).select().from(tables.notification).all();
    expect(notifRows.length).toBe(1);
    cleanup();
  });
});

// ============================================================================
// 2. financial-inbox-guard — sequence with parallel classify + risk detect
// ============================================================================
describe("financial-inbox-guard", () => {
  test("ingests email then classifies and detects risk in parallel", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      email: z.object({ messageId: z.string(), from: z.string(), subject: z.string() }),
      classification: z.object({ messageId: z.string(), category: z.string(), confidence: z.number() }),
      risk: z.object({ messageId: z.string(), riskLevel: z.string() }),
      routing: z.object({ messageId: z.string(), action: z.string(), summary: z.string() }),
    });

    const order: string[] = [];
    const workflow = smithers((ctx) => {
      const email = ctx.outputMaybe("email", { nodeId: "ingest" });
      return (
        <Workflow name="financial-inbox-guard">
          <Sequence>
            <Task id="ingest" output={outputs.email}>
              {() => { order.push("ingest"); return { messageId: "msg-1", from: "vendor@co.com", subject: "Invoice #123" }; }}
            </Task>
            <Parallel>
              <Task id="classify" output={outputs.classification}>
                {() => { order.push("classify"); return { messageId: "msg-1", category: "invoice", confidence: 95 }; }}
              </Task>
              <Task id="detect-risk" output={outputs.risk}>
                {() => { order.push("detect-risk"); return { messageId: "msg-1", riskLevel: "low" }; }}
              </Task>
            </Parallel>
            <Task id="route" output={outputs.routing}>
              {() => { order.push("route"); return { messageId: "msg-1", action: "auto-process", summary: "Low risk invoice" }; }}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    // ingest must come first, route must come last
    expect(order[0]).toBe("ingest");
    expect(order[order.length - 1]).toBe("route");
    // classify and detect-risk both happen before route
    expect(order.indexOf("classify")).toBeLessThan(order.indexOf("route"));
    expect(order.indexOf("detect-risk")).toBeLessThan(order.indexOf("route"));
    cleanup();
  });
});

// ============================================================================
// 3. flake-hunter — loop N runs → evidence pack → conditional analyst
// ============================================================================
describe("flake-hunter", () => {
  test("loops through test runs then packs evidence for consistent pass", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      runResult: z.object({ attempt: z.number(), outcome: z.string(), signature: z.string(), durationMs: z.number() }),
      evidence: z.object({ totalRuns: z.number(), passes: z.number(), failures: z.number(), divergent: z.boolean() }),
      report: z.object({ classification: z.string(), flakeRate: z.number(), summary: z.string() }),
    });

    let attempt = 0;
    const workflow = smithers((ctx) => {
      const results = ctx.outputs("runResult");
      const finished = results.length >= 3;
      const passes = results.filter((r: any) => r.outcome === "pass").length;
      const failures = results.filter((r: any) => r.outcome === "fail").length;
      const divergent = passes > 0 && failures > 0;

      return (
        <Workflow name="flake-hunter">
          <Sequence>
            <Loop until={finished} maxIterations={3} onMaxReached="return-last">
              <Task id="run" output={outputs.runResult}>
                {() => {
                  attempt++;
                  return { attempt, outcome: "pass", signature: "ok", durationMs: 100 };
                }}
              </Task>
            </Loop>
            <Task id="evidence" output={outputs.evidence}>
              {() => ({
                totalRuns: results.length,
                passes: results.filter((r: any) => r.outcome === "pass").length,
                failures: results.filter((r: any) => r.outcome === "fail").length,
                divergent: false,
              })}
            </Task>
            <Task id="report-static" output={outputs.report} skipIf={divergent}>
              {() => ({
                classification: "consistent-pass",
                flakeRate: 0,
                summary: "3 runs, all passed",
              })}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: { runs: 3 } });
    expect(r.status).toBe("finished");
    const reportRows = (db as any).select().from(tables.report).all();
    expect(reportRows.length).toBe(1);
    expect(reportRows[0].classification).toBe("consistent-pass");
    cleanup();
  });
});

// ============================================================================
// 4. form-filler-assistant — extract → clarification loop → validate → submit
// ============================================================================
describe("form-filler-assistant", () => {
  test("extracts fields, skips loop when no missing required, validates and submits", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      extraction: z.object({
        knownFields: z.array(z.object({ name: z.string(), value: z.string() })),
        missingFields: z.array(z.object({ name: z.string(), required: z.boolean() })),
        summary: z.string(),
      }),
      validation: z.object({
        valid: z.boolean(),
        normalizedPayload: z.record(z.string(), z.string()),
        summary: z.string(),
      }),
      submission: z.object({
        target: z.string(),
        status: z.string(),
        fieldCount: z.number(),
        summary: z.string(),
      }),
    });

    const order: string[] = [];
    const workflow = smithers((ctx) => {
      const extraction = ctx.outputMaybe("extraction", { nodeId: "extract" });
      const noMissingRequired = (extraction?.missingFields ?? []).filter((f: any) => f.required).length === 0;
      const validation = ctx.outputMaybe("validation", { nodeId: "validate" });

      return (
        <Workflow name="form-filler-assistant">
          <Sequence>
            <Task id="extract" output={outputs.extraction}>
              {() => {
                order.push("extract");
                return {
                  knownFields: [{ name: "firstName", value: "John" }, { name: "lastName", value: "Doe" }],
                  missingFields: [],
                  summary: "All fields extracted",
                };
              }}
            </Task>
            <Task id="validate" output={outputs.validation}>
              {() => {
                order.push("validate");
                return {
                  valid: true,
                  normalizedPayload: { firstName: "John", lastName: "Doe" },
                  summary: "All fields valid",
                };
              }}
            </Task>
            <Task id="submit" output={outputs.submission} skipIf={!validation?.valid}>
              {() => {
                order.push("submit");
                return { target: "stdout", status: "dry-run", fieldCount: 2, summary: "Submitted 2 fields" };
              }}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    expect(order).toEqual(["extract", "validate", "submit"]);
    const subRows = (db as any).select().from(tables.submission).all();
    expect(subRows.length).toBe(1);
    expect(subRows[0].status).toBe("dry-run");
    cleanup();
  });
});

// ============================================================================
// 5. friday-bot — schedule → parallel collectors → summarize → publish
// ============================================================================
describe("friday-bot", () => {
  test("collects from multiple sources in parallel then summarizes", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      scheduleContext: z.object({ periodLabel: z.string(), isWeekly: z.boolean() }),
      githubDigest: z.object({ mergedPRs: z.number(), openPRs: z.number() }),
      linearDigest: z.object({ completedIssues: z.number(), inProgressIssues: z.number() }),
      slackDigest: z.object({ activeThreads: z.number(), topTopics: z.array(z.string()) }),
      summary: z.object({ headline: z.string(), highlights: z.array(z.string()) }),
      publishResult: z.object({ destination: z.string(), success: z.boolean() }),
    });

    const order: string[] = [];
    const workflow = smithers(() => (
      <Workflow name="friday-bot">
        <Sequence>
          <Task id="schedule" output={outputs.scheduleContext}>
            {() => { order.push("schedule"); return { periodLabel: "Week of 2026-03-23", isWeekly: true }; }}
          </Task>
          <Parallel>
            <Task id="collect-github" output={outputs.githubDigest}>
              {() => { order.push("github"); return { mergedPRs: 12, openPRs: 3 }; }}
            </Task>
            <Task id="collect-linear" output={outputs.linearDigest}>
              {() => { order.push("linear"); return { completedIssues: 8, inProgressIssues: 5 }; }}
            </Task>
            <Task id="collect-slack" output={outputs.slackDigest}>
              {() => { order.push("slack"); return { activeThreads: 15, topTopics: ["deploy", "bugs"] }; }}
            </Task>
          </Parallel>
          <Task id="summarize" output={outputs.summary}>
            {() => { order.push("summarize"); return { headline: "Strong week", highlights: ["12 PRs shipped"] }; }}
          </Task>
          <Task id="publish" output={outputs.publishResult}>
            {() => { order.push("publish"); return { destination: "slack", success: true }; }}
          </Task>
        </Sequence>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    expect(order[0]).toBe("schedule");
    expect(order.indexOf("summarize")).toBeGreaterThan(order.indexOf("github"));
    expect(order.indexOf("summarize")).toBeGreaterThan(order.indexOf("linear"));
    expect(order.indexOf("summarize")).toBeGreaterThan(order.indexOf("slack"));
    expect(order[order.length - 1]).toBe("publish");
    cleanup();
  });
});

// ============================================================================
// 6. gastown — mayor plans beads → parallel polecats → report
// ============================================================================
describe("gastown", () => {
  test("mayor creates plan, polecats work in parallel, then report", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      plan: z.object({
        convoyId: z.string(),
        beads: z.array(z.object({ id: z.string(), title: z.string(), priority: z.number() })),
      }),
      polecatResult: z.object({
        beadId: z.string(),
        branch: z.string(),
        state: z.string(),
        summary: z.string(),
        exitType: z.string(),
      }),
      report: z.object({
        convoyId: z.string(),
        totalBeads: z.number(),
        merged: z.number(),
        summary: z.string(),
      }),
    });

    const order: string[] = [];
    const workflow = smithers((ctx) => {
      const plan = ctx.outputMaybe("plan", { nodeId: "mayor" });
      const polecatResults = ctx.outputs("polecatResult");

      return (
        <Workflow name="gastown">
          <Sequence>
            <Task id="mayor" output={outputs.plan}>
              {() => {
                order.push("mayor");
                return {
                  convoyId: "cv-001",
                  beads: [
                    { id: "gt-aaa", title: "Fix typo", priority: 2 },
                    { id: "gt-bbb", title: "Add test", priority: 3 },
                  ],
                };
              }}
            </Task>
            {plan && (
              <Parallel>
                {plan.beads.map((bead) => (
                  <Task key={bead.id} id={`polecat-${bead.id}`} output={outputs.polecatResult}>
                    {() => {
                      order.push(`polecat-${bead.id}`);
                      return {
                        beadId: bead.id,
                        branch: `polecat/${bead.id}`,
                        state: "done",
                        summary: `Completed ${bead.title}`,
                        exitType: "completed",
                      };
                    }}
                  </Task>
                ))}
              </Parallel>
            )}
            <Task id="report" output={outputs.report}>
              {() => {
                order.push("report");
                return {
                  convoyId: plan?.convoyId ?? "unknown",
                  totalBeads: plan?.beads.length ?? 0,
                  merged: polecatResults.length,
                  summary: `Completed ${polecatResults.length} beads`,
                };
              }}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: { goal: "Fix stuff", directory: "." } });
    expect(r.status).toBe("finished");
    expect(order[0]).toBe("mayor");
    expect(order[order.length - 1]).toBe("report");
    const polecatRows = (db as any).select().from(tables.polecatResult).all();
    expect(polecatRows.length).toBe(2);
    cleanup();
  });
});

// ============================================================================
// 7. gate — loop checking condition until satisfied, then final gate result
// ============================================================================
describe("gate", () => {
  test("polls condition until satisfied then produces gate result", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      check: z.object({ satisfied: z.boolean(), status: z.string(), checkedAt: z.string() }),
      gate: z.object({ passed: z.boolean(), totalChecks: z.number(), finalStatus: z.string(), summary: z.string() }),
    });

    let checkCount = 0;
    const workflow = smithers((ctx) => {
      const checks = ctx.outputs("check");
      const latestCheck = checks[checks.length - 1];
      const satisfied = latestCheck?.satisfied ?? false;

      return (
        <Workflow name="gate">
          <Sequence>
            <Loop until={satisfied} maxIterations={5} onMaxReached="return-last">
              <Task id="check" output={outputs.check}>
                {() => {
                  checkCount++;
                  return {
                    satisfied: checkCount >= 3,
                    status: checkCount >= 3 ? "ready" : "pending",
                    checkedAt: new Date().toISOString(),
                  };
                }}
              </Task>
            </Loop>
            <Task id="gate" output={outputs.gate}>
              {() => ({
                passed: satisfied,
                totalChecks: checks.length,
                finalStatus: latestCheck?.status ?? "never checked",
                summary: `Gate passed after ${checks.length} checks`,
              })}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    const checkRows = (db as any).select().from(tables.check).all();
    expect(checkRows.length).toBe(3);
    const gateRows = (db as any).select().from(tables.gate).all();
    expect(gateRows.length).toBe(1);
    expect(gateRows[0].passed).toBe(true);
    cleanup();
  });
});

// ============================================================================
// 8. invoice-approval-watch — extract → validate → route sequence
// ============================================================================
describe("invoice-approval-watch", () => {
  test("extracts invoices, validates, and routes to approval queue", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      invoiceData: z.object({
        invoices: z.array(z.object({ id: z.string(), vendorName: z.string(), amount: z.number() })),
      }),
      validation: z.object({
        results: z.array(z.object({
          invoiceId: z.string(),
          amount: z.number(),
          needsApproval: z.boolean(),
          riskScore: z.number(),
        })),
      }),
      approvalQueue: z.object({
        totalProcessed: z.number(),
        autoApproved: z.number(),
        queuedForApproval: z.number(),
        summary: z.string(),
      }),
    });

    const order: string[] = [];
    const workflow = smithers(() => (
      <Workflow name="invoice-approval-watch">
        <Sequence>
          <Task id="extract" output={outputs.invoiceData}>
            {() => {
              order.push("extract");
              return {
                invoices: [
                  { id: "inv-1", vendorName: "Acme", amount: 500 },
                  { id: "inv-2", vendorName: "Unknown Corp", amount: 50000 },
                ],
              };
            }}
          </Task>
          <Task id="validate" output={outputs.validation}>
            {() => {
              order.push("validate");
              return {
                results: [
                  { invoiceId: "inv-1", amount: 500, needsApproval: false, riskScore: 0.1 },
                  { invoiceId: "inv-2", amount: 50000, needsApproval: true, riskScore: 0.8 },
                ],
              };
            }}
          </Task>
          <Task id="route" output={outputs.approvalQueue}>
            {() => {
              order.push("route");
              return {
                totalProcessed: 2,
                autoApproved: 1,
                queuedForApproval: 1,
                summary: "1 invoice auto-approved, 1 queued for review",
              };
            }}
          </Task>
        </Sequence>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    expect(order).toEqual(["extract", "validate", "route"]);
    const queueRows = (db as any).select().from(tables.approvalQueue).all();
    expect(queueRows[0].queuedForApproval).toBe(1);
    cleanup();
  });
});

// ============================================================================
// 9. kanban — triage → loop(work parallel + review parallel) → board
// ============================================================================
describe("kanban", () => {
  test("triages items, works and reviews them, produces final board", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      triage: z.object({
        items: z.array(z.object({ id: z.string(), title: z.string(), column: z.string() })),
        totalItems: z.number(),
      }),
      work: z.object({ itemId: z.string(), column: z.string(), summary: z.string() }),
      review: z.object({ itemId: z.string(), approved: z.boolean(), column: z.string() }),
      board: z.object({ done: z.array(z.string()), blocked: z.array(z.string()), summary: z.string() }),
    });

    const workflow = smithers((ctx) => {
      const triage = ctx.outputMaybe("triage", { nodeId: "triage" });
      const workResults = ctx.outputs("work");
      const reviewResults = ctx.outputs("review");
      const doneIds = new Set(reviewResults.filter((r: any) => r.column === "done").map((r: any) => r.itemId));
      const allDone = triage ? triage.items.every((item: any) => doneIds.has(item.id)) : false;

      return (
        <Workflow name="kanban">
          <Sequence>
            <Task id="triage" output={outputs.triage}>
              {() => ({
                items: [
                  { id: "t1", title: "Fix button", column: "backlog" },
                  { id: "t2", title: "Add tooltip", column: "backlog" },
                ],
                totalItems: 2,
              })}
            </Task>
            {triage && (
              <Loop until={allDone} maxIterations={2} onMaxReached="return-last">
                <Sequence>
                  <Parallel>
                    {triage.items
                      .filter((item: any) => !doneIds.has(item.id))
                      .map((item: any) => (
                        <Task key={item.id} id={`work-${item.id}`} output={outputs.work}>
                          {() => ({ itemId: item.id, column: "review", summary: `Done ${item.title}` })}
                        </Task>
                      ))}
                  </Parallel>
                  <Parallel>
                    {workResults
                      .filter((r: any) => r.column === "review")
                      .map((result: any) => (
                        <Task key={result.itemId} id={`review-${result.itemId}`} output={outputs.review}>
                          {() => ({ itemId: result.itemId, approved: true, column: "done" })}
                        </Task>
                      ))}
                  </Parallel>
                </Sequence>
              </Loop>
            )}
            <Task id="board" output={outputs.board}>
              {() => ({
                done: reviewResults.filter((r: any) => r.column === "done").map((r: any) => r.itemId),
                blocked: workResults.filter((r: any) => r.column === "blocked").map((r: any) => r.itemId),
                summary: `Processed ${triage?.totalItems ?? 0} items`,
              })}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: { goal: "Fix UI", directory: "." } });
    expect(r.status).toBe("finished");
    const boardRows = (db as any).select().from(tables.board).all();
    expect(boardRows.length).toBe(1);
    const workRows = (db as any).select().from(tables.work).all();
    expect(workRows.length).toBeGreaterThanOrEqual(2);
    cleanup();
  });
});

// ============================================================================
// 10. kimi-example — simple 2-step sequence: analysis → report
// ============================================================================
describe("kimi-example", () => {
  test("runs analysis then generates report in sequence", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      analysis: z.object({
        summary: z.string(),
        keyPoints: z.array(z.string()),
        complexity: z.string(),
      }),
      output: z.object({
        report: z.string(),
        recommendations: z.array(z.string()),
      }),
    });

    const order: string[] = [];
    const workflow = smithers((ctx) => {
      const analysis = ctx.outputMaybe("analysis", { nodeId: "analysis" });
      return (
        <Workflow name="kimi-analysis">
          <Sequence>
            <Task id="analysis" output={outputs.analysis}>
              {() => {
                order.push("analysis");
                return {
                  summary: "The topic is moderately complex",
                  keyPoints: ["Point A", "Point B"],
                  complexity: "medium",
                };
              }}
            </Task>
            <Task id="report" output={outputs.output}>
              {() => {
                order.push("report");
                return {
                  report: `Analysis of topic: ${analysis?.summary ?? "unknown"}`,
                  recommendations: ["Do X", "Consider Y"],
                };
              }}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: { topic: "AI safety" } });
    expect(r.status).toBe("finished");
    expect(order).toEqual(["analysis", "report"]);
    const reportRows = (db as any).select().from(tables.output).all();
    expect(reportRows.length).toBe(1);
    expect(reportRows[0].recommendations).toBeDefined();
    cleanup();
  });
});
