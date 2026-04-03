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

/* ------------------------------------------------------------------ */
/*  1. lead-enricher                                                   */
/* ------------------------------------------------------------------ */
describe("lead-enricher", () => {
  test("sequence: intake -> enrich -> profile -> crm-output", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      intake: z.object({
        leadId: z.string(),
        company: z.string(),
        contactName: z.string(),
        contactEmail: z.string(),
        source: z.string(),
        rawNotes: z.string(),
        summary: z.string(),
      }),
      enrichment: z.object({
        industry: z.string(),
        techStack: z.array(z.string()),
        summary: z.string(),
      }),
      profile: z.object({
        segment: z.string(),
        icpFit: z.number(),
        summary: z.string(),
      }),
      crmRecord: z.object({
        leadId: z.string(),
        status: z.string(),
        summary: z.string(),
      }),
    });

    const order: string[] = [];
    const workflow = smithers(() => (
      <Workflow name="lead-enricher">
        <Sequence>
          <Task id="intake" output={outputs.intake}>
            {() => { order.push("intake"); return { leadId: "L1", company: "Acme", contactName: "Jane", contactEmail: "jane@acme.com", source: "inbound-form", rawNotes: "Interested in enterprise", summary: "Acme lead" }; }}
          </Task>
          <Task id="enrich" output={outputs.enrichment}>
            {() => { order.push("enrich"); return { industry: "SaaS", techStack: ["React", "Node"], summary: "SaaS company" }; }}
          </Task>
          <Task id="profiler" output={outputs.profile}>
            {() => { order.push("profiler"); return { segment: "mid-market", icpFit: 85, summary: "Good fit" }; }}
          </Task>
          <Task id="crm-output" output={outputs.crmRecord}>
            {() => { order.push("crm-output"); return { leadId: "L1", status: "enriched", summary: "Lead enriched and profiled" }; }}
          </Task>
        </Sequence>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    expect(order).toEqual(["intake", "enrich", "profiler", "crm-output"]);
    const rows = (db as any).select().from(tables.crmRecord).all();
    expect(rows.length).toBe(1);
    expect(rows[0].leadId).toBe("L1");
    cleanup();
  });
});

/* ------------------------------------------------------------------ */
/*  2. lead-router-with-approval                                       */
/* ------------------------------------------------------------------ */
describe("lead-router-with-approval", () => {
  test("sequence with branch: intake -> score -> conditional approval -> sink", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      lead: z.object({ company: z.string(), source: z.string() }),
      score: z.object({ score: z.number(), tier: z.string(), needsApproval: z.boolean(), reasoning: z.string() }),
      sink: z.object({ status: z.string(), assignedTo: z.string(), summary: z.string() }),
    });

    const order: string[] = [];
    const workflow = smithers(() => (
      <Workflow name="lead-router-with-approval">
        <Sequence>
          <Task id="intake" output={outputs.lead}>
            {() => { order.push("intake"); return { company: "BigCo", source: "referral" }; }}
          </Task>
          <Task id="score" output={outputs.score}>
            {() => { order.push("score"); return { score: 85, tier: "enterprise", needsApproval: false, reasoning: "High score" }; }}
          </Task>
          {/* No approval needed for high-score leads */}
          <Task id="sink" output={outputs.sink}>
            {() => { order.push("sink"); return { status: "routed", assignedTo: "sales-team-a", summary: "Enterprise lead routed" }; }}
          </Task>
        </Sequence>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    expect(order).toEqual(["intake", "score", "sink"]);
    const sinkRows = (db as any).select().from(tables.sink).all();
    expect(sinkRows[0].status).toBe("routed");
    cleanup();
  });

  test("borderline lead includes branch for approval", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      lead: z.object({ company: z.string() }),
      score: z.object({ score: z.number(), needsApproval: z.boolean() }),
      approval: z.object({ approved: z.boolean(), reviewer: z.string(), note: z.string() }),
      sink: z.object({ status: z.string(), summary: z.string() }),
    });

    const workflow = smithers(() => (
      <Workflow name="lead-router-borderline">
        <Sequence>
          <Task id="intake" output={outputs.lead}>
            {() => ({ company: "MaybeCo" })}
          </Task>
          <Task id="score" output={outputs.score}>
            {() => ({ score: 55, needsApproval: true })}
          </Task>
          <Branch
            if={true}
            then={
              <Task id="approve-route" output={outputs.approval}>
                {() => ({ approved: true, reviewer: "manager@co.com", note: "Looks good" })}
              </Task>
            }
          />
          <Task id="sink" output={outputs.sink}>
            {() => ({ status: "routed", summary: "Approved and routed" })}
          </Task>
        </Sequence>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    const approvalRows = (db as any).select().from(tables.approval).all();
    expect(approvalRows.length).toBe(1);
    expect(approvalRows[0].approved).toBe(true);
    cleanup();
  });
});

/* ------------------------------------------------------------------ */
/*  3. log-digest                                                      */
/* ------------------------------------------------------------------ */
describe("log-digest", () => {
  test("sequence: collect logs -> summarize into digest", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      collectedLogs: z.object({
        source: z.string(),
        lineCount: z.number(),
        errorLines: z.array(z.string()),
        warningLines: z.array(z.string()),
        rawTail: z.string(),
      }),
      digest: z.object({
        summary: z.string(),
        likelyOwnerTeam: z.string(),
      }),
    });

    const order: string[] = [];
    const workflow = smithers(() => (
      <Workflow name="log-digest">
        <Sequence>
          <Task id="collect" output={outputs.collectedLogs}>
            {() => { order.push("collect"); return { source: "ci-build", lineCount: 500, errorLines: ["ERROR: OOM at line 42"], warningLines: ["WARN: deprecated API"], rawTail: "...build failed" }; }}
          </Task>
          <Task id="summarize" output={outputs.digest}>
            {() => { order.push("summarize"); return { summary: "OOM in build step, likely memory leak in tests", likelyOwnerTeam: "platform" }; }}
          </Task>
        </Sequence>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    expect(order).toEqual(["collect", "summarize"]);
    const digestRows = (db as any).select().from(tables.digest).all();
    expect(digestRows[0].likelyOwnerTeam).toBe("platform");
    cleanup();
  });
});

/* ------------------------------------------------------------------ */
/*  4. mcp-health-probe                                                */
/* ------------------------------------------------------------------ */
describe("mcp-health-probe", () => {
  test("loop with parallel probes, check, and conditional report", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      schedule: z.object({ shouldProbe: z.boolean(), reason: z.string() }),
      probe: z.object({ server: z.string(), healthy: z.boolean(), latencyMs: z.number() }),
      check: z.object({ materialChange: z.boolean(), unhealthyServers: z.array(z.string()) }),
      report: z.object({ reported: z.boolean(), summary: z.string() }),
    });

    let iteration = 0;
    const workflow = smithers((ctx) => {
      const noChange = iteration >= 1;
      return (
        <Workflow name="mcp-health-probe">
          <Loop until={noChange} maxIterations={3} onMaxReached="return-last">
            <Sequence>
              <Task id="schedule" output={outputs.schedule}>
                {() => ({ shouldProbe: true, reason: "interval elapsed" })}
              </Task>
              <Parallel>
                <Task id="probe-server-a" output={outputs.probe}>
                  {() => ({ server: "server-a", healthy: true, latencyMs: 120 })}
                </Task>
                <Task id="probe-server-b" output={outputs.probe}>
                  {() => ({ server: "server-b", healthy: true, latencyMs: 80 })}
                </Task>
              </Parallel>
              <Task id="check" output={outputs.check}>
                {() => { iteration++; return { materialChange: false, unhealthyServers: [] }; }}
              </Task>
              <Task id="report" output={outputs.report} skipIf={noChange}>
                {() => ({ reported: true, summary: "All servers healthy" })}
              </Task>
            </Sequence>
          </Loop>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    const probeRows = (db as any).select().from(tables.probe).all();
    expect(probeRows.length).toBeGreaterThanOrEqual(2);
    cleanup();
  });
});

/* ------------------------------------------------------------------ */
/*  5. meeting-briefer                                                 */
/* ------------------------------------------------------------------ */
describe("meeting-briefer", () => {
  test("sequence with parallel context gathering: trigger -> classify -> parallel(crm, attendee, history) -> brief", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      meetingEvent: z.object({ meetingId: z.string(), title: z.string(), attendees: z.array(z.string()), summary: z.string() }),
      classification: z.object({ intent: z.string(), priority: z.string(), summary: z.string() }),
      crmContext: z.object({ accountName: z.string(), summary: z.string() }),
      attendeeContext: z.object({ summary: z.string() }),
      historyContext: z.object({ summary: z.string() }),
      brief: z.object({ meetingId: z.string(), headline: z.string(), summary: z.string() }),
    });

    const order: string[] = [];
    const workflow = smithers(() => (
      <Workflow name="meeting-briefer">
        <Sequence>
          <Task id="trigger" output={outputs.meetingEvent}>
            {() => { order.push("trigger"); return { meetingId: "M1", title: "Q4 Review", attendees: ["alice", "bob"], summary: "Quarterly review" }; }}
          </Task>
          <Task id="classify" output={outputs.classification}>
            {() => { order.push("classify"); return { intent: "renewal", priority: "high", summary: "Renewal discussion" }; }}
          </Task>
          <Parallel>
            <Task id="crm-context" output={outputs.crmContext}>
              {() => { order.push("crm"); return { accountName: "Acme Corp", summary: "Enterprise account" }; }}
            </Task>
            <Task id="attendee-context" output={outputs.attendeeContext}>
              {() => { order.push("attendee"); return { summary: "2 attendees, 1 decision-maker" }; }}
            </Task>
            <Task id="history-context" output={outputs.historyContext}>
              {() => { order.push("history"); return { summary: "3 previous meetings" }; }}
            </Task>
          </Parallel>
          <Task id="brief" output={outputs.brief}>
            {() => { order.push("brief"); return { meetingId: "M1", headline: "Renewal review with Acme", summary: "Prep brief ready" }; }}
          </Task>
        </Sequence>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {}, maxConcurrency: 4 });
    expect(r.status).toBe("finished");
    // trigger and classify must come before parallel tasks
    expect(order.indexOf("trigger")).toBeLessThan(order.indexOf("crm"));
    expect(order.indexOf("classify")).toBeLessThan(order.indexOf("crm"));
    // brief must come after all parallel tasks
    expect(order.indexOf("brief")).toBeGreaterThan(order.indexOf("crm"));
    expect(order.indexOf("brief")).toBeGreaterThan(order.indexOf("attendee"));
    expect(order.indexOf("brief")).toBeGreaterThan(order.indexOf("history"));
    const briefRows = (db as any).select().from(tables.brief).all();
    expect(briefRows[0].meetingId).toBe("M1");
    cleanup();
  });
});

/* ------------------------------------------------------------------ */
/*  6. memory-support-agent                                            */
/* ------------------------------------------------------------------ */
describe("memory-support-agent", () => {
  test("sequence with conditional escalation branch", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      recall: z.object({ customerId: z.string(), sentiment: z.string() }),
      response: z.object({ reply: z.string(), confidenceScore: z.number(), needsEscalation: z.boolean() }),
      persist: z.object({ customerId: z.string(), summary: z.string() }),
      escalation: z.object({ escalated: z.boolean(), tier: z.string(), reason: z.string(), summary: z.string() }),
    });

    const workflow = smithers(() => (
      <Workflow name="memory-support-agent">
        <Sequence>
          <Task id="recall" output={outputs.recall}>
            {() => ({ customerId: "C123", sentiment: "frustrated" })}
          </Task>
          <Task id="respond" output={outputs.response}>
            {() => ({ reply: "I understand your concern...", confidenceScore: 30, needsEscalation: true })}
          </Task>
          <Task id="persist" output={outputs.persist}>
            {() => ({ customerId: "C123", summary: "Updated memory with billing issue" })}
          </Task>
          <Branch
            if={true}
            then={
              <Task id="escalate" output={outputs.escalation}>
                {() => ({ escalated: true, tier: "t2", reason: "Low confidence", summary: "Escalated to T2" })}
              </Task>
            }
          />
        </Sequence>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    const escRows = (db as any).select().from(tables.escalation).all();
    expect(escRows.length).toBe(1);
    expect(escRows[0].tier).toBe("t2");
    cleanup();
  });

  test("no escalation when confidence is high", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      recall: z.object({ customerId: z.string() }),
      response: z.object({ reply: z.string(), needsEscalation: z.boolean() }),
      persist: z.object({ customerId: z.string(), summary: z.string() }),
      escalation: z.object({ escalated: z.boolean(), tier: z.string() }),
    });

    const workflow = smithers(() => (
      <Workflow name="memory-support-no-escalation">
        <Sequence>
          <Task id="recall" output={outputs.recall}>
            {() => ({ customerId: "C456" })}
          </Task>
          <Task id="respond" output={outputs.response}>
            {() => ({ reply: "Here is the answer.", needsEscalation: false })}
          </Task>
          <Task id="persist" output={outputs.persist}>
            {() => ({ customerId: "C456", summary: "Resolved" })}
          </Task>
          <Branch
            if={false}
            then={
              <Task id="escalate" output={outputs.escalation}>
                {() => ({ escalated: true, tier: "t2" })}
              </Task>
            }
          />
        </Sequence>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    const escRows = (db as any).select().from(tables.escalation).all();
    expect(escRows.length).toBe(0);
    cleanup();
  });
});

/* ------------------------------------------------------------------ */
/*  7. merge-conflict-mediator                                         */
/* ------------------------------------------------------------------ */
describe("merge-conflict-mediator", () => {
  test("sequence: parse -> mediate -> skip apply (high risk) -> review", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      parseResult: z.object({ conflictCount: z.number(), files: z.array(z.string()), summary: z.string() }),
      mediationResult: z.object({ overallRisk: z.string(), summary: z.string() }),
      applyResult: z.object({ applied: z.boolean(), filesStaged: z.array(z.string()), summary: z.string() }),
      review: z.object({ status: z.string(), summary: z.string() }),
    });

    const order: string[] = [];
    const workflow = smithers(() => (
      <Workflow name="merge-conflict-mediator">
        <Sequence>
          <Task id="parseResult" output={outputs.parseResult}>
            {() => { order.push("parse"); return { conflictCount: 3, files: ["a.ts", "b.ts", "c.ts"], summary: "3 conflicts found" }; }}
          </Task>
          <Task id="mediationResult" output={outputs.mediationResult}>
            {() => { order.push("mediate"); return { overallRisk: "high", summary: "High risk merge" }; }}
          </Task>
          {/* Auto-apply skipped because risk is high */}
          <Task id="apply-result-skipped" output={outputs.applyResult}>
            {() => { order.push("skip-apply"); return { applied: false, filesStaged: [], summary: "Auto-apply skipped: high risk" }; }}
          </Task>
          <Task id="review" output={outputs.review}>
            {() => { order.push("review"); return { status: "needs-manual-intervention", summary: "3 resolutions proposed — manual review required" }; }}
          </Task>
        </Sequence>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    expect(order).toEqual(["parse", "mediate", "skip-apply", "review"]);
    const reviewRows = (db as any).select().from(tables.review).all();
    expect(reviewRows[0].status).toBe("needs-manual-intervention");
    cleanup();
  });
});

/* ------------------------------------------------------------------ */
/*  8. migration                                                       */
/* ------------------------------------------------------------------ */
describe("migration", () => {
  test("sequence: analyze -> parallel migrate -> validate -> report", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      migrationPlan: z.object({ totalFiles: z.number(), files: z.array(z.string()) }),
      fileResult: z.object({ path: z.string(), status: z.string(), changes: z.string() }),
      validation: z.object({ passed: z.boolean(), errors: z.array(z.string()) }),
      report: z.object({ totalFiles: z.number(), migrated: z.number(), failed: z.number(), validationPassed: z.boolean(), summary: z.string() }),
    });

    const order: string[] = [];
    const workflow = smithers(() => (
      <Workflow name="migration">
        <Sequence>
          <Task id="analyze" output={outputs.migrationPlan}>
            {() => { order.push("analyze"); return { totalFiles: 2, files: ["src/a.ts", "src/b.ts"] }; }}
          </Task>
          <Parallel>
            <Task id="migrate-src-a" output={outputs.fileResult}>
              {() => { order.push("migrate-a"); return { path: "src/a.ts", status: "migrated", changes: "Updated imports" }; }}
            </Task>
            <Task id="migrate-src-b" output={outputs.fileResult}>
              {() => { order.push("migrate-b"); return { path: "src/b.ts", status: "migrated", changes: "Updated types" }; }}
            </Task>
          </Parallel>
          <Task id="validate" output={outputs.validation}>
            {() => { order.push("validate"); return { passed: true, errors: [] }; }}
          </Task>
          <Task id="report" output={outputs.report}>
            {() => { order.push("report"); return { totalFiles: 2, migrated: 2, failed: 0, validationPassed: true, summary: "Migration v1 to v2: 2/2 files migrated, validation passed" }; }}
          </Task>
        </Sequence>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    expect(order.indexOf("analyze")).toBeLessThan(order.indexOf("migrate-a"));
    expect(order.indexOf("analyze")).toBeLessThan(order.indexOf("migrate-b"));
    expect(order.indexOf("validate")).toBeGreaterThan(order.indexOf("migrate-a"));
    expect(order.indexOf("validate")).toBeGreaterThan(order.indexOf("migrate-b"));
    expect(order.indexOf("report")).toBeGreaterThan(order.indexOf("validate"));
    const reportRows = (db as any).select().from(tables.report).all();
    expect(reportRows[0].validationPassed).toBe(true);
    cleanup();
  });
});

/* ------------------------------------------------------------------ */
/*  9. milestone                                                       */
/* ------------------------------------------------------------------ */
describe("milestone", () => {
  test("sequential milestone progression with validation gates", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      milestoneResult: z.object({ milestone: z.string(), status: z.string(), summary: z.string() }),
      validation: z.object({ milestone: z.string(), passed: z.boolean() }),
      progress: z.object({ currentMilestone: z.string(), completedMilestones: z.array(z.string()), overallProgress: z.number(), summary: z.string() }),
    });

    const order: string[] = [];
    const workflow = smithers(() => (
      <Workflow name="milestone">
        <Sequence>
          <Task id="implement-m0" output={outputs.milestoneResult}>
            {() => { order.push("impl-m0"); return { milestone: "m0", status: "complete", summary: "Foundation done" }; }}
          </Task>
          <Task id="validate-m0" output={outputs.validation}>
            {() => { order.push("val-m0"); return { milestone: "m0", passed: true }; }}
          </Task>
          <Task id="implement-m1" output={outputs.milestoneResult}>
            {() => { order.push("impl-m1"); return { milestone: "m1", status: "complete", summary: "Core done" }; }}
          </Task>
          <Task id="validate-m1" output={outputs.validation}>
            {() => { order.push("val-m1"); return { milestone: "m1", passed: true }; }}
          </Task>
          <Task id="progress" output={outputs.progress}>
            {() => { order.push("progress"); return { currentMilestone: "complete", completedMilestones: ["m0", "m1"], overallProgress: 100, summary: "2/2 milestones complete" }; }}
          </Task>
        </Sequence>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    expect(order).toEqual(["impl-m0", "val-m0", "impl-m1", "val-m1", "progress"]);
    const progressRows = (db as any).select().from(tables.progress).all();
    expect(progressRows[0].overallProgress).toBe(100);
    cleanup();
  });
});

/* ------------------------------------------------------------------ */
/*  10. openapi-contract-agent                                         */
/* ------------------------------------------------------------------ */
describe("openapi-contract-agent", () => {
  test("sequence: parse-contract -> generate-interfaces -> typed-calls", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      contractSource: z.object({ specFormat: z.string(), endpointCount: z.number(), summary: z.string() }),
      interfaces: z.object({ interfaceCount: z.number(), summary: z.string() }),
      typedCalls: z.object({ totalEndpoints: z.number(), typedEndpoints: z.number(), summary: z.string() }),
    });

    const order: string[] = [];
    const workflow = smithers(() => (
      <Workflow name="openapi-contract-agent">
        <Sequence>
          <Task id="parse-contract" output={outputs.contractSource}>
            {() => { order.push("parse"); return { specFormat: "openapi-3.1", endpointCount: 5, summary: "Parsed 5 endpoints" }; }}
          </Task>
          <Task id="generate-interfaces" output={outputs.interfaces}>
            {() => { order.push("generate"); return { interfaceCount: 10, summary: "Generated 10 interfaces" }; }}
          </Task>
          <Task id="typed-calls" output={outputs.typedCalls}>
            {() => { order.push("typed-calls"); return { totalEndpoints: 5, typedEndpoints: 5, summary: "100% coverage" }; }}
          </Task>
        </Sequence>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    expect(order).toEqual(["parse", "generate", "typed-calls"]);
    const callRows = (db as any).select().from(tables.typedCalls).all();
    expect(callRows[0].typedEndpoints).toBe(5);
    cleanup();
  });
});
