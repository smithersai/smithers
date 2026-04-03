/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import {
  Workflow,
  Task,
  Sequence,
  Parallel,
  Branch,
  Loop,
  runWorkflow,
} from "../src/index";
import { createTestSmithers } from "./helpers";
import { z } from "zod";

// ─── 1. simple-workflow ────────────────────────────────────────────────────────
describe("simple-workflow", () => {
  test("research then write in sequence", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      research: z.object({
        summary: z.string(),
        keyPoints: z.array(z.string()),
      }),
      output: z.object({
        article: z.string(),
        wordCount: z.number(),
      }),
    });

    const workflow = smithers((ctx) => {
      const research = ctx.outputMaybe("research", { nodeId: "research" });
      return (
        <Workflow name="simple-example">
          <Sequence>
            <Task id="research" output={outputs.research}>
              {() => ({ summary: "AI overview", keyPoints: ["fast", "scalable"] })}
            </Task>
            <Task id="write" output={outputs.output}>
              {() => ({
                article: `Article about: ${research?.summary ?? ""}`,
                wordCount: 42,
              })}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: { topic: "AI" } });
    expect(r.status).toBe("finished");
    const researchRows = (db as any).select().from(tables.research).all();
    expect(researchRows.length).toBe(1);
    expect(researchRows[0].summary).toBe("AI overview");
    const outputRows = (db as any).select().from(tables.output).all();
    expect(outputRows.length).toBe(1);
    expect(outputRows[0].wordCount).toBe(42);
    cleanup();
  });
});

// ─── 2. slo-breach-explainer ───────────────────────────────────────────────────
describe("slo-breach-explainer", () => {
  test("trigger → parallel enrichment → synthesis", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      alarm: z.object({
        service: z.string(),
        sloName: z.string(),
        threshold: z.string(),
        observed: z.string(),
        window: z.string(),
      }),
      traces: z.object({
        topSpans: z.array(z.object({
          traceId: z.string(),
          spanName: z.string(),
          durationMs: z.number(),
          status: z.enum(["ok", "error", "timeout"]),
          attributes: z.string(),
        })),
        bottleneck: z.string(),
        sampleTraceId: z.string(),
      }),
      logs: z.object({
        errorCount: z.number(),
        topErrors: z.array(z.object({
          message: z.string(),
          count: z.number(),
          firstSeen: z.string(),
          lastSeen: z.string(),
        })),
        anomalies: z.array(z.string()),
      }),
      changes: z.object({
        recentDeploys: z.array(z.object({
          version: z.string(),
          deployedAt: z.string(),
          author: z.string(),
          description: z.string(),
        })),
        configChanges: z.array(z.object({
          key: z.string(),
          oldValue: z.string(),
          newValue: z.string(),
          changedAt: z.string(),
        })),
        suspectChange: z.string(),
      }),
      incidentNote: z.object({
        title: z.string(),
        severity: z.enum(["critical", "high", "medium", "low"]),
        causalChain: z.array(z.string()),
        rootCause: z.string(),
        impactSummary: z.string(),
        mitigation: z.string(),
        followUps: z.array(z.string()),
        summary: z.string(),
      }),
    });

    const workflow = smithers((ctx) => (
      <Workflow name="slo-breach-explainer">
        <Sequence>
          <Task id="trigger" output={outputs.alarm}>
            {() => ({
              service: "api-gateway",
              sloName: "p99-latency",
              threshold: "200ms",
              observed: "850ms",
              window: "2026-03-28T14:00Z/PT1H",
            })}
          </Task>
          <Parallel maxConcurrency={3}>
            <Task id="traces" output={outputs.traces}>
              {() => ({
                topSpans: [{ traceId: "t1", spanName: "db.query", durationMs: 780, status: "ok" as const, attributes: "db=postgres" }],
                bottleneck: "db.query",
                sampleTraceId: "t1",
              })}
            </Task>
            <Task id="logs" output={outputs.logs}>
              {() => ({
                errorCount: 12,
                topErrors: [{ message: "timeout", count: 12, firstSeen: "14:05Z", lastSeen: "14:55Z" }],
                anomalies: ["spike in connection pool exhaustion"],
              })}
            </Task>
            <Task id="changes" output={outputs.changes}>
              {() => ({
                recentDeploys: [{ version: "v2.3.1", deployedAt: "13:45Z", author: "alice", description: "bump pool size" }],
                configChanges: [],
                suspectChange: "v2.3.1 deploy",
              })}
            </Task>
          </Parallel>
          <Task id="incidentNote" output={outputs.incidentNote}>
            {() => ({
              title: "API Gateway p99 breach",
              severity: "high" as const,
              causalChain: ["deploy v2.3.1", "pool exhaustion", "latency spike"],
              rootCause: "Connection pool misconfiguration in v2.3.1",
              impactSummary: "p99 latency exceeded SLO for 1 hour",
              mitigation: "Rollback to v2.3.0",
              followUps: ["Review pool sizing", "Add circuit breaker"],
              summary: "v2.3.1 caused pool exhaustion leading to p99 breach",
            })}
          </Task>
        </Sequence>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    const notes = (db as any).select().from(tables.incidentNote).all();
    expect(notes.length).toBe(1);
    expect(notes[0].severity).toBe("high");
    const traceRows = (db as any).select().from(tables.traces).all();
    expect(traceRows.length).toBe(1);
    cleanup();
  });
});

// ─── 3. smoketest ──────────────────────────────────────────────────────────────
describe("smoketest", () => {
  test("setup → parallel checks → report", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      setup: z.object({
        environment: z.string(),
        ready: z.boolean(),
        details: z.string(),
      }),
      check: z.object({
        name: z.string(),
        passed: z.boolean(),
        duration: z.number(),
        error: z.string().optional(),
        output: z.string(),
      }),
      report: z.object({
        totalChecks: z.number(),
        passed: z.number(),
        failed: z.number(),
        duration: z.number(),
        verdict: z.enum(["pass", "fail"]),
        failures: z.array(z.string()),
        summary: z.string(),
      }),
    });

    const workflow = smithers((ctx) => {
      const setup = ctx.outputMaybe("setup", { nodeId: "setup" });
      const checks = ctx.outputs.check ?? [];
      return (
        <Workflow name="smoketest">
          <Sequence>
            <Task id="setup" output={outputs.setup}>
              {() => ({ environment: "test", ready: true, details: "all good" })}
            </Task>
            {setup?.ready && (
              <Parallel>
                <Task id="check-typecheck" output={outputs.check}>
                  {() => ({ name: "typecheck", passed: true, duration: 100, output: "ok" })}
                </Task>
                <Task id="check-lint" output={outputs.check}>
                  {() => ({ name: "lint", passed: false, duration: 50, error: "unused var", output: "fail" })}
                </Task>
              </Parallel>
            )}
            <Task id="report" output={outputs.report}>
              {() => ({
                totalChecks: checks.length,
                passed: checks.filter((c) => c.passed).length,
                failed: checks.filter((c) => !c.passed).length,
                duration: checks.reduce((sum, c) => sum + c.duration, 0),
                verdict: checks.every((c) => c.passed) ? "pass" as const : "fail" as const,
                failures: checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.error ?? "failed"}`),
                summary: `${checks.filter((c) => c.passed).length}/${checks.length} checks passed`,
              })}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    const checkRows = (db as any).select().from(tables.check).all();
    expect(checkRows.length).toBe(2);
    const reportRows = (db as any).select().from(tables.report).all();
    expect(reportRows.length).toBe(1);
    // Report should reflect the 2 checks
    expect(reportRows[0].totalChecks).toBe(2);
    cleanup();
  });
});

// ─── 4. social-inbox-router ────────────────────────────────────────────────────
describe("social-inbox-router", () => {
  test("trigger → classify → parallel actions → summary", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      inboxItem: z.object({
        id: z.string(),
        platform: z.enum(["linkedin", "twitter", "facebook", "instagram", "other"]),
        senderName: z.string(),
        senderTitle: z.string().optional(),
        senderCompany: z.string().optional(),
        messageBody: z.string(),
        receivedAt: z.string(),
        summary: z.string(),
      }),
      classification: z.object({
        items: z.array(z.object({
          id: z.string(),
          category: z.enum(["lead", "noise", "support", "follow-up"]),
          confidence: z.number(),
          reasoning: z.string(),
        })),
        summary: z.string(),
      }),
      leadAction: z.object({
        actions: z.array(z.object({
          itemId: z.string(),
          senderName: z.string(),
          senderCompany: z.string().optional(),
          suggestedReply: z.string(),
          crmAction: z.enum(["create-contact", "update-contact", "create-opportunity"]),
          priority: z.enum(["low", "medium", "high"]),
        })),
        summary: z.string(),
      }),
      supportAction: z.object({
        tickets: z.array(z.object({
          itemId: z.string(),
          subject: z.string(),
          urgency: z.enum(["low", "medium", "high", "critical"]),
          suggestedReply: z.string(),
          escalate: z.boolean(),
        })),
        summary: z.string(),
      }),
      followUpAction: z.object({
        followUps: z.array(z.object({
          itemId: z.string(),
          senderName: z.string(),
          context: z.string(),
          suggestedReply: z.string(),
          dueBy: z.string(),
        })),
        summary: z.string(),
      }),
      routerOutput: z.object({
        totalProcessed: z.number(),
        categoryCounts: z.object({
          lead: z.number(),
          noise: z.number(),
          support: z.number(),
          followUp: z.number(),
        }),
        leadActions: z.array(z.string()),
        supportTickets: z.array(z.string()),
        followUps: z.array(z.string()),
        summary: z.string(),
      }),
    });

    const workflow = smithers((ctx) => (
      <Workflow name="social-inbox-router">
        <Sequence>
          <Task id="trigger" output={outputs.inboxItem}>
            {() => ({
              id: "msg-1",
              platform: "linkedin" as const,
              senderName: "Jane Doe",
              senderTitle: "CTO",
              senderCompany: "Acme",
              messageBody: "Interested in a demo",
              receivedAt: "2026-03-28",
              summary: "Demo request from CTO",
            })}
          </Task>
          <Task id="classify" output={outputs.classification}>
            {() => ({
              items: [{ id: "msg-1", category: "lead" as const, confidence: 0.95, reasoning: "demo request" }],
              summary: "1 lead identified",
            })}
          </Task>
          <Parallel maxConcurrency={3}>
            <Task id="lead-actions" output={outputs.leadAction}>
              {() => ({
                actions: [{ itemId: "msg-1", senderName: "Jane Doe", senderCompany: "Acme", suggestedReply: "Thanks!", crmAction: "create-opportunity" as const, priority: "high" as const }],
                summary: "1 lead action",
              })}
            </Task>
            <Task id="support-actions" output={outputs.supportAction}>
              {() => ({ tickets: [], summary: "no support items" })}
            </Task>
            <Task id="follow-up-actions" output={outputs.followUpAction}>
              {() => ({ followUps: [], summary: "no follow-ups" })}
            </Task>
          </Parallel>
          <Task id="summary" output={outputs.routerOutput}>
            {() => ({
              totalProcessed: 1,
              categoryCounts: { lead: 1, noise: 0, support: 0, followUp: 0 },
              leadActions: ["create-opportunity for Jane Doe"],
              supportTickets: [],
              followUps: [],
              summary: "Processed 1 message, 1 lead",
            })}
          </Task>
        </Sequence>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    const routerRows = (db as any).select().from(tables.routerOutput).all();
    expect(routerRows.length).toBe(1);
    expect(routerRows[0].totalProcessed).toBe(1);
    cleanup();
  });
});

// ─── 5. standards-reviewer ─────────────────────────────────────────────────────
describe("standards-reviewer", () => {
  test("load standards → review diff in sequence", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      standards: z.object({
        files: z.array(z.object({ path: z.string(), content: z.string() })),
        ruleCount: z.number(),
        rules: z.array(z.object({ source: z.string(), rule: z.string() })),
      }),
      review: z.object({
        violations: z.array(z.object({
          rule: z.string(),
          source: z.string(),
          file: z.string(),
          line: z.number().nullable(),
          explanation: z.string(),
          severity: z.enum(["error", "warning"]),
        })),
        clean: z.boolean(),
        summary: z.string(),
      }),
    });

    const workflow = smithers((ctx) => {
      const loaded = ctx.outputMaybe("standards", { nodeId: "load-standards" });
      return (
        <Workflow name="standards-reviewer">
          <Sequence>
            <Task id="load-standards" output={outputs.standards}>
              {() => ({
                files: [{ path: "CLAUDE.md", content: "No console.log in production" }],
                ruleCount: 1,
                rules: [{ source: "CLAUDE.md", rule: "No console.log in production" }],
              })}
            </Task>
            <Task id="review-diff" output={outputs.review}>
              {() => ({
                violations: [{
                  rule: "No console.log in production",
                  source: "CLAUDE.md",
                  file: "src/index.ts",
                  line: 42,
                  explanation: "console.log found in production code",
                  severity: "error" as const,
                }],
                clean: false,
                summary: "1 violation found",
              })}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: { diff: "some diff" } });
    expect(r.status).toBe("finished");
    const reviewRows = (db as any).select().from(tables.review).all();
    expect(reviewRows.length).toBe(1);
    expect(reviewRows[0].clean).toBe(false);
    cleanup();
  });
});

// ─── 6. supervisor ─────────────────────────────────────────────────────────────
describe("supervisor", () => {
  test("delegate → workers → supervise → final summary", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      delegation: z.object({
        tasks: z.array(z.object({
          id: z.string(),
          title: z.string(),
          instructions: z.string(),
          files: z.array(z.string()),
          workerType: z.enum(["coder", "tester", "docs"]),
        })),
        strategy: z.string(),
      }),
      workerResult: z.object({
        taskId: z.string(),
        status: z.enum(["success", "partial", "failed"]),
        summary: z.string(),
        filesChanged: z.array(z.string()),
      }),
      supervision: z.object({
        allDone: z.boolean(),
        retriable: z.array(z.string()),
        summary: z.string(),
        nextActions: z.array(z.string()),
      }),
      final: z.object({
        totalTasks: z.number(),
        succeeded: z.number(),
        failed: z.number(),
        iterations: z.number(),
        summary: z.string(),
      }),
    });

    const workflow = smithers((ctx) => {
      const delegation = ctx.outputMaybe("delegation", { nodeId: "delegate" });
      const results = ctx.outputs.workerResult ?? [];
      const supervision = ctx.outputMaybe("supervision", { nodeId: "supervise" });
      const allDone = supervision?.allDone ?? false;

      return (
        <Workflow name="supervisor">
          <Sequence>
            <Task id="delegate" output={outputs.delegation}>
              {() => ({
                tasks: [
                  { id: "t1", title: "Add feature", instructions: "implement it", files: ["src/feature.ts"], workerType: "coder" as const },
                  { id: "t2", title: "Test feature", instructions: "write tests", files: ["tests/feature.test.ts"], workerType: "tester" as const },
                ],
                strategy: "parallel execution",
              })}
            </Task>

            {delegation && (
              <Loop until={allDone} maxIterations={3} onMaxReached="return-last">
                <Sequence>
                  <Parallel>
                    {delegation.tasks.map((task) => (
                      <Task
                        key={task.id}
                        id={`worker-${task.id}`}
                        output={outputs.workerResult}
                        continueOnFail
                      >
                        {() => ({
                          taskId: task.id,
                          status: "success" as const,
                          summary: `Completed ${task.title}`,
                          filesChanged: task.files,
                        })}
                      </Task>
                    ))}
                  </Parallel>
                  <Task id="supervise" output={outputs.supervision}>
                    {() => ({
                      allDone: true,
                      retriable: [],
                      summary: "All tasks succeeded",
                      nextActions: [],
                    })}
                  </Task>
                </Sequence>
              </Loop>
            )}

            <Task id="final" output={outputs.final}>
              {() => ({
                totalTasks: delegation?.tasks.length ?? 0,
                succeeded: results.filter((r) => r.status === "success").length,
                failed: results.filter((r) => r.status === "failed").length,
                iterations: 1,
                summary: `${results.filter((r) => r.status === "success").length}/${delegation?.tasks.length ?? 0} tasks completed`,
              })}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: { goal: "add feature" } });
    expect(r.status).toBe("finished");
    const finalRows = (db as any).select().from(tables.final).all();
    expect(finalRows.length).toBe(1);
    const workerRows = (db as any).select().from(tables.workerResult).all();
    expect(workerRows.length).toBeGreaterThanOrEqual(2);
    cleanup();
  });
});

// ─── 7. support-deflector ──────────────────────────────────────────────────────
describe("support-deflector", () => {
  test("classify → retrieve → draft → deflect (happy path)", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      classification: z.object({
        category: z.enum(["billing", "bug", "how-to", "account", "feature-request", "outage"]),
        sentiment: z.enum(["positive", "neutral", "frustrated", "angry"]),
        confidence: z.number(),
        riskLevel: z.enum(["low", "medium", "high"]),
        escalate: z.boolean(),
        reasoning: z.string(),
      }),
      knowledge: z.object({
        articles: z.array(z.object({
          title: z.string(),
          relevance: z.number(),
          snippet: z.string(),
          source: z.string(),
        })),
        coverageScore: z.number(),
      }),
      draft: z.object({
        subject: z.string(),
        body: z.string(),
        tone: z.enum(["empathetic", "professional", "technical"]),
        suggestedActions: z.array(z.string()),
        confidenceInDraft: z.number(),
      }),
      escalation: z.object({
        reason: z.string(),
        priority: z.enum(["urgent", "high", "normal"]),
        assignTo: z.string(),
        context: z.string(),
      }),
      outcome: z.object({
        status: z.enum(["deflected", "escalated"]),
        ticketId: z.string(),
        summary: z.string(),
      }),
    });

    const workflow = smithers((ctx) => {
      const classification = ctx.outputMaybe("classification", { nodeId: "classify" });
      const knowledge = ctx.outputMaybe("knowledge", { nodeId: "retrieve" });
      const draft = ctx.outputMaybe("draft", { nodeId: "draft-reply" });

      const shouldEscalate =
        classification?.escalate === true ||
        classification?.riskLevel === "high" ||
        (classification?.confidence !== undefined && classification.confidence < 60) ||
        (knowledge?.coverageScore !== undefined && knowledge.coverageScore < 40) ||
        (draft?.confidenceInDraft !== undefined && draft.confidenceInDraft < 50);

      return (
        <Workflow name="support-deflector">
          <Sequence>
            <Task id="classify" output={outputs.classification}>
              {() => ({
                category: "how-to" as const,
                sentiment: "neutral" as const,
                confidence: 90,
                riskLevel: "low" as const,
                escalate: false,
                reasoning: "Simple how-to question",
              })}
            </Task>
            <Task id="retrieve" output={outputs.knowledge}>
              {() => ({
                articles: [{ title: "Getting Started", relevance: 95, snippet: "Follow these steps...", source: "docs" }],
                coverageScore: 90,
              })}
            </Task>
            <Task id="draft-reply" output={outputs.draft}>
              {() => ({
                subject: "Re: How do I set up?",
                body: "Here is how to get started...",
                tone: "professional" as const,
                suggestedActions: ["Send auto-reply"],
                confidenceInDraft: 85,
              })}
            </Task>
            <Branch
              if={shouldEscalate}
              then={
                <Sequence>
                  <Task id="escalate" output={outputs.escalation}>
                    {() => ({
                      reason: "high risk",
                      priority: "urgent" as const,
                      assignTo: "tier2",
                      context: "needs human",
                    })}
                  </Task>
                  <Task id="outcome-escalated" output={outputs.outcome}>
                    {() => ({
                      status: "escalated" as const,
                      ticketId: "t-1",
                      summary: "Escalated",
                    })}
                  </Task>
                </Sequence>
              }
              else={
                <Task id="outcome-deflected" output={outputs.outcome}>
                  {() => ({
                    status: "deflected" as const,
                    ticketId: "t-1",
                    summary: "Auto-replied",
                  })}
                </Task>
              }
            />
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: { ticket: { id: "t-1", subject: "Help", body: "How do I?" } } });
    expect(r.status).toBe("finished");
    const outcomeRows = (db as any).select().from(tables.outcome).all();
    expect(outcomeRows.length).toBe(1);
    expect(outcomeRows[0].status).toBe("deflected");
    cleanup();
  });

  test("escalates when risk is high", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      classification: z.object({
        category: z.enum(["billing", "bug", "how-to", "account", "feature-request", "outage"]),
        sentiment: z.enum(["positive", "neutral", "frustrated", "angry"]),
        confidence: z.number(),
        riskLevel: z.enum(["low", "medium", "high"]),
        escalate: z.boolean(),
        reasoning: z.string(),
      }),
      knowledge: z.object({
        articles: z.array(z.object({ title: z.string(), relevance: z.number(), snippet: z.string(), source: z.string() })),
        coverageScore: z.number(),
      }),
      draft: z.object({
        subject: z.string(),
        body: z.string(),
        tone: z.enum(["empathetic", "professional", "technical"]),
        suggestedActions: z.array(z.string()),
        confidenceInDraft: z.number(),
      }),
      escalation: z.object({
        reason: z.string(),
        priority: z.enum(["urgent", "high", "normal"]),
        assignTo: z.string(),
        context: z.string(),
      }),
      outcome: z.object({
        status: z.enum(["deflected", "escalated"]),
        ticketId: z.string(),
        summary: z.string(),
      }),
    });

    const workflow = smithers((ctx) => {
      const classification = ctx.outputMaybe("classification", { nodeId: "classify" });
      const knowledge = ctx.outputMaybe("knowledge", { nodeId: "retrieve" });
      const draft = ctx.outputMaybe("draft", { nodeId: "draft-reply" });

      const shouldEscalate =
        classification?.escalate === true ||
        classification?.riskLevel === "high" ||
        (classification?.confidence !== undefined && classification.confidence < 60) ||
        (knowledge?.coverageScore !== undefined && knowledge.coverageScore < 40) ||
        (draft?.confidenceInDraft !== undefined && draft.confidenceInDraft < 50);

      return (
        <Workflow name="support-deflector-escalate">
          <Sequence>
            <Task id="classify" output={outputs.classification}>
              {() => ({
                category: "outage" as const,
                sentiment: "angry" as const,
                confidence: 40,
                riskLevel: "high" as const,
                escalate: true,
                reasoning: "Production outage reported",
              })}
            </Task>
            <Task id="retrieve" output={outputs.knowledge}>
              {() => ({ articles: [], coverageScore: 10 })}
            </Task>
            <Task id="draft-reply" output={outputs.draft}>
              {() => ({
                subject: "Re: Outage",
                body: "We are investigating",
                tone: "empathetic" as const,
                suggestedActions: [],
                confidenceInDraft: 20,
              })}
            </Task>
            <Branch
              if={shouldEscalate}
              then={
                <Sequence>
                  <Task id="escalate" output={outputs.escalation}>
                    {() => ({ reason: "production outage", priority: "urgent" as const, assignTo: "oncall", context: "angry customer" })}
                  </Task>
                  <Task id="outcome-escalated" output={outputs.outcome}>
                    {() => ({ status: "escalated" as const, ticketId: "t-2", summary: "Escalated to oncall" })}
                  </Task>
                </Sequence>
              }
              else={
                <Task id="outcome-deflected" output={outputs.outcome}>
                  {() => ({ status: "deflected" as const, ticketId: "t-2", summary: "Auto-replied" })}
                </Task>
              }
            />
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    const outcomeRows = (db as any).select().from(tables.outcome).all();
    expect(outcomeRows.length).toBe(1);
    expect(outcomeRows[0].status).toBe("escalated");
    cleanup();
  });
});

// ─── 8. survey-answerer-agent ──────────────────────────────────────────────────
describe("survey-answerer-agent", () => {
  test("gather context → generate answers → validate", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      sourceContext: z.object({
        documentSummaries: z.array(z.object({
          sourceId: z.string(),
          title: z.string(),
          relevantExcerpts: z.array(z.string()),
          topics: z.array(z.string()),
        })),
        keyFacts: z.record(z.string(), z.string()),
        summary: z.string(),
      }),
      surveyAnswers: z.object({
        answers: z.array(z.object({
          questionId: z.string(),
          questionText: z.string(),
          answer: z.string(),
          confidence: z.enum(["high", "medium", "low"]),
          sourceRefs: z.array(z.string()),
          reasoning: z.string(),
        })),
        unanswered: z.array(z.object({
          questionId: z.string(),
          questionText: z.string(),
          reason: z.string(),
        })),
        summary: z.string(),
      }),
      validation: z.object({
        overallConsistency: z.enum(["pass", "warn", "fail"]),
        contradictions: z.array(z.object({
          questionIds: z.array(z.string()),
          description: z.string(),
          severity: z.enum(["low", "medium", "high"]),
        })),
        unsupportedClaims: z.array(z.object({
          questionId: z.string(),
          claim: z.string(),
          issue: z.string(),
        })),
        revisedAnswers: z.array(z.object({
          questionId: z.string(),
          originalAnswer: z.string(),
          revisedAnswer: z.string(),
          reason: z.string(),
        })),
        summary: z.string(),
      }),
    });

    const workflow = smithers(() => (
      <Workflow name="survey-answerer-agent">
        <Sequence>
          <Task id="gather-context" output={outputs.sourceContext}>
            {() => ({
              documentSummaries: [{ sourceId: "doc1", title: "Annual Report", relevantExcerpts: ["Revenue grew 20%"], topics: ["finance"] }],
              keyFacts: { revenue: "20% growth" },
              summary: "Annual report analyzed",
            })}
          </Task>
          <Task id="generate-answers" output={outputs.surveyAnswers}>
            {() => ({
              answers: [{ questionId: "q1", questionText: "Revenue growth?", answer: "20%", confidence: "high" as const, sourceRefs: ["doc1"], reasoning: "From annual report" }],
              unanswered: [],
              summary: "1 answer generated",
            })}
          </Task>
          <Task id="validate" output={outputs.validation}>
            {() => ({
              overallConsistency: "pass" as const,
              contradictions: [],
              unsupportedClaims: [],
              revisedAnswers: [],
              summary: "All consistent",
            })}
          </Task>
        </Sequence>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    const validationRows = (db as any).select().from(tables.validation).all();
    expect(validationRows.length).toBe(1);
    expect(validationRows[0].overallConsistency).toBe("pass");
    const answerRows = (db as any).select().from(tables.surveyAnswers).all();
    expect(answerRows.length).toBe(1);
    cleanup();
  });
});

// ─── 9. test-sharder-judge ─────────────────────────────────────────────────────
describe("test-sharder-judge", () => {
  test("analyze → select → parallel run → adjudicate", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      analysis: z.object({
        changedFiles: z.array(z.string()),
        affectedModules: z.array(z.string()),
        riskLevel: z.enum(["low", "medium", "high"]),
      }),
      selection: z.object({
        priorityTests: z.array(z.object({
          file: z.string(),
          reason: z.string(),
          confidence: z.number(),
        })),
        deferredTests: z.array(z.string()),
        totalCandidates: z.number(),
      }),
      runResult: z.object({
        testFile: z.string(),
        status: z.enum(["pass", "fail", "error", "skipped"]),
        durationMs: z.number(),
        errorMessage: z.string().optional(),
      }),
      adjudication: z.object({
        verdict: z.enum(["green", "yellow", "red"]),
        failedTests: z.array(z.string()),
        deferredTests: z.array(z.string()),
        shouldExpandRun: z.boolean(),
        summary: z.string(),
      }),
    });

    const workflow = smithers((ctx) => {
      const analysis = ctx.outputMaybe("analysis", { nodeId: "analyze" });
      const selection = ctx.outputMaybe("selection", { nodeId: "select" });
      const results = ctx.outputs.runResult ?? [];

      return (
        <Workflow name="test-sharder-judge">
          <Sequence>
            <Task id="analyze" output={outputs.analysis}>
              {() => ({
                changedFiles: ["src/auth.ts"],
                affectedModules: ["auth"],
                riskLevel: "medium" as const,
              })}
            </Task>
            {analysis && (
              <Task id="select" output={outputs.selection}>
                {() => ({
                  priorityTests: [
                    { file: "tests/auth.test.ts", reason: "direct coverage", confidence: 0.95 },
                    { file: "tests/session.test.ts", reason: "related module", confidence: 0.7 },
                  ],
                  deferredTests: ["tests/e2e.test.ts"],
                  totalCandidates: 3,
                })}
              </Task>
            )}
            {selection && (
              <Parallel>
                {selection.priorityTests.map((t) => (
                  <Task key={t.file} id={`run-${t.file}`} output={outputs.runResult} continueOnFail>
                    {() => ({
                      testFile: t.file,
                      status: "pass" as const,
                      durationMs: 150,
                    })}
                  </Task>
                ))}
              </Parallel>
            )}
            <Task id="adjudicate" output={outputs.adjudication}>
              {() => ({
                verdict: "green" as const,
                failedTests: [],
                deferredTests: selection?.deferredTests ?? [],
                shouldExpandRun: false,
                summary: `${results.length} tests passed`,
              })}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: { diff: "mock diff" } });
    expect(r.status).toBe("finished");
    const adjRows = (db as any).select().from(tables.adjudication).all();
    expect(adjRows.length).toBe(1);
    expect(adjRows[0].verdict).toBe("green");
    const runRows = (db as any).select().from(tables.runResult).all();
    expect(runRows.length).toBe(2);
    cleanup();
  });
});

// ─── 10. threat-intel-enricher ─────────────────────────────────────────────────
describe("threat-intel-enricher", () => {
  test("ingest → parallel enrichment → analyst → case record", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      ingestedAlert: z.object({
        alertId: z.string(),
        source: z.string(),
        indicators: z.array(z.object({
          type: z.enum(["ip", "domain", "hash", "email", "url", "other"]),
          value: z.string(),
        })),
        rawDescription: z.string(),
        timestamp: z.string(),
        summary: z.string(),
      }),
      externalEnrichment: z.object({
        indicators: z.array(z.object({
          value: z.string(),
          threatFeeds: z.array(z.string()),
          knownMalicious: z.boolean(),
          firstSeen: z.string().optional(),
          tags: z.array(z.string()),
        })),
        cveMatches: z.array(z.object({
          id: z.string(),
          severity: z.string(),
          description: z.string(),
        })),
        summary: z.string(),
      }),
      internalEnrichment: z.object({
        affectedAssets: z.array(z.object({
          hostname: z.string(),
          service: z.string(),
          environment: z.enum(["production", "staging", "development"]),
          owner: z.string(),
        })),
        recentActivity: z.array(z.object({
          timestamp: z.string(),
          event: z.string(),
          relevance: z.enum(["low", "medium", "high"]),
        })),
        priorIncidents: z.array(z.string()),
        summary: z.string(),
      }),
      analystVerdict: z.object({
        severity: z.enum(["low", "medium", "high", "critical"]),
        confidence: z.number(),
        attackVector: z.string(),
        threatActor: z.string().optional(),
        firstActions: z.array(z.string()),
        narrative: z.string(),
        summary: z.string(),
      }),
      caseRecord: z.object({
        caseId: z.string(),
        severity: z.enum(["low", "medium", "high", "critical"]),
        title: z.string(),
        assignee: z.string(),
        firstActions: z.array(z.string()),
        enrichmentSummary: z.string(),
        status: z.enum(["open", "triaged", "investigating", "resolved"]),
        summary: z.string(),
      }),
    });

    const workflow = smithers(() => (
      <Workflow name="threat-intel-enricher">
        <Sequence>
          <Task id="ingest" output={outputs.ingestedAlert}>
            {() => ({
              alertId: "alert-001",
              source: "siem",
              indicators: [{ type: "ip" as const, value: "192.168.1.100" }],
              rawDescription: "Suspicious outbound traffic",
              timestamp: "2026-03-28T10:00:00Z",
              summary: "Suspicious IP traffic detected",
            })}
          </Task>
          <Parallel maxConcurrency={2}>
            <Task id="external-enrich" output={outputs.externalEnrichment}>
              {() => ({
                indicators: [{ value: "192.168.1.100", threatFeeds: ["abuse-ch"], knownMalicious: true, tags: ["c2"] }],
                cveMatches: [],
                summary: "IP flagged as C2 by abuse.ch",
              })}
            </Task>
            <Task id="internal-enrich" output={outputs.internalEnrichment}>
              {() => ({
                affectedAssets: [{ hostname: "web-01", service: "nginx", environment: "production" as const, owner: "platform-team" }],
                recentActivity: [{ timestamp: "2026-03-28T09:50:00Z", event: "outbound connection spike", relevance: "high" as const }],
                priorIncidents: [],
                summary: "Production web server affected",
              })}
            </Task>
          </Parallel>
          <Task id="analyst" output={outputs.analystVerdict}>
            {() => ({
              severity: "critical" as const,
              confidence: 1,
              attackVector: "C2 callback from compromised web server",
              firstActions: ["Isolate web-01", "Block 192.168.1.100 at firewall"],
              narrative: "Web-01 is making C2 callbacks to a known malicious IP.",
              summary: "Critical: C2 traffic from production",
            })}
          </Task>
          <Task id="case" output={outputs.caseRecord}>
            {() => ({
              caseId: "CASE-001",
              severity: "critical" as const,
              title: "C2 Traffic from web-01",
              assignee: "security-oncall",
              firstActions: ["Isolate web-01", "Block IP"],
              enrichmentSummary: "Known C2 IP, production asset affected",
              status: "triaged" as const,
              summary: "Case filed and triaged",
            })}
          </Task>
        </Sequence>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    const caseRows = (db as any).select().from(tables.caseRecord).all();
    expect(caseRows.length).toBe(1);
    expect(caseRows[0].severity).toBe("critical");
    expect(caseRows[0].status).toBe("triaged");
    const extRows = (db as any).select().from(tables.externalEnrichment).all();
    const intRows = (db as any).select().from(tables.internalEnrichment).all();
    expect(extRows.length).toBe(1);
    expect(intRows.length).toBe(1);
    cleanup();
  });
});
