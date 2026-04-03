/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import {
  Workflow,
  Task,
  Sequence,
  Parallel,
  runWorkflow,
} from "../src/index";
import { createTestSmithers } from "./helpers";
import { z } from "zod";

// ─── trace-explainer ───────────────────────────────────────────────────────────
describe("trace-explainer", () => {
  test("ingests spans, analyzes bottlenecks, and produces optimization report", async () => {
    const ingestSchema = z.object({
      spans: z.array(z.object({
        name: z.string(),
        durationMs: z.number(),
        tokenCount: z.number().optional(),
        failed: z.boolean(),
        error: z.string().optional(),
        children: z.array(z.string()).optional(),
      })),
      totalDurationMs: z.number(),
      totalTokens: z.number(),
      failedSpanCount: z.number(),
    });

    const analysisSchema = z.object({
      bottleneck: z.object({
        spanName: z.string(),
        reason: z.enum(["latency", "tokens", "failure", "retry-storm"]),
        impact: z.string(),
      }),
      hotPath: z.array(z.string()),
      failureSummary: z.string().nullable(),
      tokenHogs: z.array(z.object({
        spanName: z.string(),
        tokenCount: z.number(),
        percentOfTotal: z.number(),
      })),
    });

    const reportSchema = z.object({
      title: z.string(),
      bottleneckExplanation: z.string(),
      optimizations: z.array(z.object({
        target: z.string(),
        suggestion: z.string(),
        estimatedSaving: z.string(),
      })),
      summary: z.string(),
    });

    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      ingest: ingestSchema,
      analysis: analysisSchema,
      report: reportSchema,
    });

    const workflow = smithers((ctx) => {
      const ingest = ctx.outputMaybe("ingest", { nodeId: "ingest" });
      const analysis = ctx.outputMaybe("analysis", { nodeId: "analyze" });

      return (
        <Workflow name="trace-explainer">
          <Sequence>
            <Task id="ingest" output={outputs.ingest}>
              {() => ({
                spans: [
                  { name: "llm-call", durationMs: 3200, tokenCount: 8000, failed: false },
                  { name: "tool-exec", durationMs: 500, tokenCount: 0, failed: true, error: "timeout" },
                ],
                totalDurationMs: 3700,
                totalTokens: 8000,
                failedSpanCount: 1,
              })}
            </Task>

            {ingest && (
              <Task id="analyze" output={outputs.analysis}>
                {() => ({
                  bottleneck: { spanName: "llm-call", reason: "latency" as const, impact: "86% of total duration" },
                  hotPath: ["llm-call"],
                  failureSummary: "1 span failed: tool-exec (timeout)",
                  tokenHogs: [{ spanName: "llm-call", tokenCount: 8000, percentOfTotal: 100 }],
                })}
              </Task>
            )}

            {analysis && ingest && (
              <Task id="report" output={outputs.report}>
                {() => ({
                  title: "Trace Analysis Report",
                  bottleneckExplanation: "llm-call accounts for 86% of wall time",
                  optimizations: [
                    { target: "llm-call", suggestion: "Use streaming or smaller model", estimatedSaving: "40%" },
                  ],
                  summary: "1 bottleneck, 1 failure found",
                })}
              </Task>
            )}
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: { traceFile: "trace.json" } });
    expect(r.status).toBe("finished");

    const ingestRows = (db as any).select().from(tables.ingest).all();
    expect(ingestRows.length).toBe(1);
    expect(ingestRows[0].totalDurationMs).toBe(3700);

    const analysisRows = (db as any).select().from(tables.analysis).all();
    expect(analysisRows.length).toBe(1);
    expect(analysisRows[0].bottleneck.spanName).toBe("llm-call");

    const reportRows = (db as any).select().from(tables.report).all();
    expect(reportRows.length).toBe(1);
    expect(reportRows[0].optimizations.length).toBe(1);

    cleanup();
  });
});

// ─── triage ────────────────────────────────────────────────────────────────────
describe("triage", () => {
  test("classifies items and routes to handlers in parallel, then reports", async () => {
    const classificationSchema = z.object({
      items: z.array(z.object({
        id: z.string(),
        title: z.string(),
        category: z.string(),
        priority: z.enum(["urgent", "high", "medium", "low"]),
        assignTo: z.enum(["security", "bug-fix", "feature", "docs", "infra", "ignore"]),
        reasoning: z.string(),
      })),
    });

    const handlerResultSchema = z.object({
      itemId: z.string(),
      action: z.string(),
      status: z.enum(["handled", "escalated", "deferred"]),
      summary: z.string(),
    });

    const triageReportSchema = z.object({
      totalItems: z.number(),
      handled: z.number(),
      escalated: z.number(),
      deferred: z.number(),
      byCategory: z.record(z.string(), z.number()),
      summary: z.string(),
    });

    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      classification: classificationSchema,
      handlerResult: handlerResultSchema,
      triageReport: triageReportSchema,
    });

    const workflow = smithers((ctx) => {
      const classification = ctx.outputMaybe("classification", { nodeId: "classify" });
      const results = ctx.outputs.handlerResult ?? [];

      const actionableItems = classification?.items?.filter((i: any) => i.assignTo !== "ignore") ?? [];

      return (
        <Workflow name="triage">
          <Sequence>
            <Task id="classify" output={outputs.classification}>
              {() => ({
                items: [
                  { id: "1", title: "XSS in login", category: "security", priority: "urgent" as const, assignTo: "security" as const, reasoning: "Active vulnerability" },
                  { id: "2", title: "Typo in README", category: "docs", priority: "low" as const, assignTo: "docs" as const, reasoning: "Minor docs fix" },
                  { id: "3", title: "Stale bot comment", category: "noise", priority: "low" as const, assignTo: "ignore" as const, reasoning: "Not actionable" },
                ],
              })}
            </Task>

            {actionableItems.length > 0 && (
              <Parallel>
                {actionableItems.map((item: any) => (
                  <Task key={item.id} id={`handle-${item.id}`} output={outputs.handlerResult}>
                    {() => ({
                      itemId: item.id,
                      action: `Handled ${item.title}`,
                      status: "handled" as const,
                      summary: `Resolved ${item.category} item`,
                    })}
                  </Task>
                ))}
              </Parallel>
            )}

            <Task id="report" output={outputs.triageReport}>
              {() => ({
                totalItems: classification?.items?.length ?? 0,
                handled: (results as any[]).filter((r: any) => r.status === "handled").length,
                escalated: (results as any[]).filter((r: any) => r.status === "escalated").length,
                deferred: (results as any[]).filter((r: any) => r.status === "deferred").length,
                byCategory: { security: 1, docs: 1, ignore: 1 },
                summary: "Triaged 3 items",
              })}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: {}, maxConcurrency: 4 });
    expect(r.status).toBe("finished");

    const classRows = (db as any).select().from(tables.classification).all();
    expect(classRows.length).toBe(1);
    expect(classRows[0].items.length).toBe(3);

    const handlerRows = (db as any).select().from(tables.handlerResult).all();
    expect(handlerRows.length).toBe(2); // ignore item excluded

    const reportRows = (db as any).select().from(tables.triageReport).all();
    expect(reportRows.length).toBe(1);

    cleanup();
  });
});

// ─── trust-safety-moderator ────────────────────────────────────────────────────
describe("trust-safety-moderator", () => {
  test("intakes content, moderates for policy, and takes action", async () => {
    const intakeSchema = z.object({
      contentId: z.string(),
      contentType: z.enum(["text", "image_url", "structured", "mixed"]),
      rawText: z.string(),
      metadata: z.object({
        source: z.string(),
        authorId: z.string().optional(),
        timestamp: z.string().optional(),
      }),
    });

    const moderationSchema = z.object({
      contentId: z.string(),
      riskLevel: z.enum(["allow", "low", "medium", "high", "block"]),
      policyClass: z.enum([
        "safe", "harassment", "hate_speech", "violence", "sexual_content",
        "self_harm", "pii_leak", "misinformation", "spam", "copyright", "other",
      ]),
      confidence: z.number(),
      reasoning: z.string(),
      flaggedSegments: z.array(z.object({
        text: z.string(),
        policy: z.string(),
        severity: z.enum(["low", "medium", "high"]),
      })),
      needsHumanReview: z.boolean(),
    });

    const actionSchema = z.object({
      contentId: z.string(),
      decision: z.enum(["approved", "modified", "rejected", "escalated"]),
      action: z.string(),
      moderatedContent: z.string().optional(),
      escalationReason: z.string().optional(),
      summary: z.string(),
    });

    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      intake: intakeSchema,
      moderation: moderationSchema,
      action: actionSchema,
    });

    const workflow = smithers((ctx) => {
      const intake = ctx.outputMaybe("intake", { nodeId: "intake" });
      const moderation = ctx.outputMaybe("moderation", { nodeId: "moderate" });

      return (
        <Workflow name="trust-safety-moderator">
          <Sequence>
            <Task id="intake" output={outputs.intake}>
              {() => ({
                contentId: "content-123",
                contentType: "text" as const,
                rawText: "This is a test post with some concerning language",
                metadata: { source: "user_submission", authorId: "user-42" },
              })}
            </Task>

            <Task id="moderate" output={outputs.moderation}>
              {() => ({
                contentId: intake?.contentId ?? "content-123",
                riskLevel: "medium" as const,
                policyClass: "harassment" as const,
                confidence: 72,
                reasoning: "Contains potentially hostile language",
                flaggedSegments: [
                  { text: "concerning language", policy: "harassment", severity: "medium" as const },
                ],
                needsHumanReview: true,
              })}
            </Task>

            <Task id="action" output={outputs.action}>
              {() => ({
                contentId: moderation?.contentId ?? "content-123",
                decision: "escalated" as const,
                action: "Flagged for human review",
                escalationReason: "Low confidence (72) on harassment classification",
                summary: "Content escalated for human review due to ambiguous harassment signals",
              })}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: { content: "test" } });
    expect(r.status).toBe("finished");

    const intakeRows = (db as any).select().from(tables.intake).all();
    expect(intakeRows.length).toBe(1);
    expect(intakeRows[0].contentId).toBe("content-123");

    const modRows = (db as any).select().from(tables.moderation).all();
    expect(modRows.length).toBe(1);
    expect(modRows[0].needsHumanReview).toBe(true);

    const actionRows = (db as any).select().from(tables.action).all();
    expect(actionRows.length).toBe(1);
    expect(actionRows[0].decision).toBe("escalated");

    cleanup();
  });
});

// ─── typed-extractor-stage ─────────────────────────────────────────────────────
describe("typed-extractor-stage", () => {
  test("extracts fields, validates them, and forwards typed output", async () => {
    const extractedSchema = z.object({
      entityName: z.string(),
      entityType: z.enum(["person", "company", "product", "event", "document", "other"]),
      fields: z.array(z.object({
        key: z.string(),
        value: z.string(),
        confidence: z.number(),
      })),
      rawSnippets: z.array(z.string()),
      summary: z.string(),
    });

    const validatedSchema = z.object({
      entityName: z.string(),
      entityType: z.enum(["person", "company", "product", "event", "document", "other"]),
      fields: z.array(z.object({
        key: z.string(),
        value: z.string(),
        confidence: z.number(),
        valid: z.boolean(),
        correctedValue: z.string().optional(),
      })),
      overallConfidence: z.number(),
      issues: z.array(z.string()),
      summary: z.string(),
    });

    const forwardSchema = z.object({
      entityName: z.string(),
      entityType: z.enum(["person", "company", "product", "event", "document", "other"]),
      structuredOutput: z.record(z.string(), z.string()),
      overallConfidence: z.number(),
      nextStep: z.string(),
      summary: z.string(),
    });

    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      extracted: extractedSchema,
      validated: validatedSchema,
      forward: forwardSchema,
    });

    const workflow = smithers((ctx) => {
      const extracted = ctx.outputMaybe("extracted", { nodeId: "extract" });
      const validated = ctx.outputMaybe("validated", { nodeId: "validate" });

      return (
        <Workflow name="typed-extractor-stage">
          <Sequence>
            <Task id="extract" output={outputs.extracted}>
              {() => ({
                entityName: "Acme Corp",
                entityType: "company" as const,
                fields: [
                  { key: "name", value: "Acme Corp", confidence: 99 },
                  { key: "founded", value: "2015", confidence: 85 },
                  { key: "ceo", value: "Jane Doe", confidence: 60 },
                ],
                rawSnippets: ["Acme Corp, founded in 2015 by Jane Doe"],
                summary: "Extracted 3 fields for Acme Corp",
              })}
            </Task>

            <Task id="validate" output={outputs.validated}>
              {() => ({
                entityName: extracted?.entityName ?? "Acme Corp",
                entityType: "company" as const,
                fields: [
                  { key: "name", value: "Acme Corp", confidence: 99, valid: true },
                  { key: "founded", value: "2015", confidence: 85, valid: true },
                  { key: "ceo", value: "Jane Doe", confidence: 60, valid: false, correctedValue: "Jane A. Doe" },
                ],
                overallConfidence: 81,
                issues: ["CEO name may be incomplete"],
                summary: "2 of 3 fields valid",
              })}
            </Task>

            <Task id="forward" output={outputs.forward}>
              {() => ({
                entityName: validated?.entityName ?? "Acme Corp",
                entityType: "company" as const,
                structuredOutput: { name: "Acme Corp", founded: "2015" },
                overallConfidence: validated?.overallConfidence ?? 81,
                nextStep: "downstream-processor",
                summary: "Forwarding 2 valid fields",
              })}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: { rawInput: "Acme Corp info" } });
    expect(r.status).toBe("finished");

    const extractedRows = (db as any).select().from(tables.extracted).all();
    expect(extractedRows.length).toBe(1);
    expect(extractedRows[0].fields.length).toBe(3);

    const validatedRows = (db as any).select().from(tables.validated).all();
    expect(validatedRows.length).toBe(1);
    expect(validatedRows[0].issues.length).toBe(1);

    const forwardRows = (db as any).select().from(tables.forward).all();
    expect(forwardRows.length).toBe(1);
    expect(forwardRows[0].nextStep).toBe("downstream-processor");

    cleanup();
  });
});

// ─── visual-diff-explainer ─────────────────────────────────────────────────────
describe("visual-diff-explainer", () => {
  test("runs tests, collects pairs, analyzes diffs, and generates report", async () => {
    const failedTestSchema = z.object({
      tests: z.array(z.object({
        name: z.string(),
        suite: z.string(),
        baselinePath: z.string(),
        currentPath: z.string(),
        diffPercentage: z.number(),
      })),
      totalFailed: z.number(),
      runner: z.string(),
    });

    const imagePairSchema = z.object({
      pairs: z.array(z.object({
        testName: z.string(),
        suite: z.string(),
        baselineImage: z.string(),
        currentImage: z.string(),
        diffPercentage: z.number(),
        viewport: z.string().optional(),
      })),
    });

    const analysisSchema = z.object({
      findings: z.array(z.object({
        testName: z.string(),
        changedRegion: z.string(),
        changeType: z.enum(["layout-shift", "color-change", "content-change", "visibility-toggle", "spacing", "typography", "z-index", "other"]),
        likelyCause: z.string(),
        severity: z.enum(["critical", "major", "minor", "cosmetic"]),
        affectedComponents: z.array(z.string()),
        summary: z.string(),
      })),
    });

    const reportSchema = z.object({
      title: z.string(),
      totalRegressions: z.number(),
      criticalCount: z.number(),
      findings: z.array(z.object({
        testName: z.string(),
        changedRegion: z.string(),
        changeType: z.string(),
        likelyCause: z.string(),
        severity: z.string(),
        summary: z.string(),
      })),
      recommendation: z.string(),
      markdown: z.string(),
    });

    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      failedTests: failedTestSchema,
      imagePairs: imagePairSchema,
      analysis: analysisSchema,
      report: reportSchema,
    });

    const workflow = smithers((ctx) => {
      const failedTests = ctx.outputMaybe("failedTests", { nodeId: "run-tests" });
      const imagePairs = ctx.outputMaybe("imagePairs", { nodeId: "collect-pairs" });
      const analysis = ctx.outputMaybe("analysis", { nodeId: "analyze-diff" });

      return (
        <Workflow name="visual-diff-explainer">
          <Sequence>
            <Task id="run-tests" output={outputs.failedTests}>
              {() => ({
                tests: [
                  { name: "homepage-hero", suite: "landing", baselinePath: "/base/hero.png", currentPath: "/curr/hero.png", diffPercentage: 12.5 },
                  { name: "nav-bar", suite: "shell", baselinePath: "/base/nav.png", currentPath: "/curr/nav.png", diffPercentage: 3.1 },
                ],
                totalFailed: 2,
                runner: "playwright",
              })}
            </Task>

            <Task id="collect-pairs" output={outputs.imagePairs}>
              {() => ({
                pairs: (failedTests?.tests ?? []).map((t: any) => ({
                  testName: t.name,
                  suite: t.suite,
                  baselineImage: "base64-baseline-stub",
                  currentImage: "base64-current-stub",
                  diffPercentage: t.diffPercentage,
                  viewport: "1280x720",
                })),
              })}
            </Task>

            <Task id="analyze-diff" output={outputs.analysis}>
              {() => ({
                findings: [
                  {
                    testName: "homepage-hero",
                    changedRegion: "Hero banner image area",
                    changeType: "content-change" as const,
                    likelyCause: "New hero image deployed",
                    severity: "major" as const,
                    affectedComponents: ["HeroBanner"],
                    summary: "Hero image changed significantly",
                  },
                  {
                    testName: "nav-bar",
                    changedRegion: "Navigation spacing",
                    changeType: "spacing" as const,
                    likelyCause: "CSS padding change in nav component",
                    severity: "minor" as const,
                    affectedComponents: ["NavBar"],
                    summary: "Minor spacing adjustment in nav",
                  },
                ],
              })}
            </Task>

            <Task id="report" output={outputs.report}>
              {() => ({
                title: "Visual Regression Report",
                totalRegressions: analysis?.findings?.length ?? 2,
                criticalCount: 0,
                findings: (analysis?.findings ?? []).map((f: any) => ({
                  testName: f.testName,
                  changedRegion: f.changedRegion,
                  changeType: f.changeType,
                  likelyCause: f.likelyCause,
                  severity: f.severity,
                  summary: f.summary,
                })),
                recommendation: "Update hero baseline; investigate nav spacing",
                markdown: "# Visual Regression Report\n\n2 regressions found.",
              })}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: { testCommand: "npx playwright test" } });
    expect(r.status).toBe("finished");

    const testRows = (db as any).select().from(tables.failedTests).all();
    expect(testRows.length).toBe(1);
    expect(testRows[0].totalFailed).toBe(2);

    const analysisRows = (db as any).select().from(tables.analysis).all();
    expect(analysisRows.length).toBe(1);
    expect(analysisRows[0].findings.length).toBe(2);

    const reportRows = (db as any).select().from(tables.report).all();
    expect(reportRows.length).toBe(1);
    expect(reportRows[0].totalRegressions).toBe(2);

    cleanup();
  });
});

// ─── waterfall ─────────────────────────────────────────────────────────────────
describe("waterfall", () => {
  test("outline -> draft -> edit -> publish in strict sequence", async () => {
    const outlineSchema = z.object({
      sections: z.array(z.object({
        title: z.string(),
        keyPoints: z.array(z.string()),
        estimatedLength: z.number(),
      })),
      totalSections: z.number(),
      targetAudience: z.string(),
    });

    const draftSchema = z.object({
      content: z.string(),
      wordCount: z.number(),
      sectionsCompleted: z.number(),
    });

    const editSchema = z.object({
      content: z.string(),
      wordCount: z.number(),
      changesApplied: z.array(z.string()),
      readabilityScore: z.number(),
    });

    const publishSchema = z.object({
      outputFile: z.string(),
      format: z.string(),
      wordCount: z.number(),
      summary: z.string(),
    });

    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      outline: outlineSchema,
      draft: draftSchema,
      edit: editSchema,
      publish: publishSchema,
    });

    const order: string[] = [];

    const workflow = smithers((ctx) => {
      const outline = ctx.outputMaybe("outline", { nodeId: "outline" });
      const draft = ctx.outputMaybe("draft", { nodeId: "draft" });
      const edited = ctx.outputMaybe("edit", { nodeId: "edit" });

      return (
        <Workflow name="waterfall">
          <Sequence>
            <Task id="outline" output={outputs.outline}>
              {() => {
                order.push("outline");
                return {
                  sections: [
                    { title: "Introduction", keyPoints: ["What is X", "Why it matters"], estimatedLength: 500 },
                    { title: "Deep Dive", keyPoints: ["Architecture", "Trade-offs"], estimatedLength: 1000 },
                  ],
                  totalSections: 2,
                  targetAudience: "developers",
                };
              }}
            </Task>

            <Task id="draft" output={outputs.draft}>
              {() => {
                order.push("draft");
                return {
                  content: `# ${outline?.sections?.[0]?.title ?? "Intro"}\nDraft content here.`,
                  wordCount: 1500,
                  sectionsCompleted: outline?.totalSections ?? 2,
                };
              }}
            </Task>

            <Task id="edit" output={outputs.edit}>
              {() => {
                order.push("edit");
                return {
                  content: draft?.content?.replace("Draft content", "Polished content") ?? "Polished content",
                  wordCount: 1480,
                  changesApplied: ["Tightened intro", "Fixed passive voice"],
                  readabilityScore: 72,
                };
              }}
            </Task>

            <Task id="publish" output={outputs.publish}>
              {() => {
                order.push("publish");
                return {
                  outputFile: "output.md",
                  format: "markdown",
                  wordCount: edited?.wordCount ?? 1480,
                  summary: "Published 2-section article",
                };
              }}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const r = await runWorkflow(workflow, { input: { topic: "Testing Workflows", audience: "developers" } });
    expect(r.status).toBe("finished");

    // Verify strict sequential order
    expect(order).toEqual(["outline", "draft", "edit", "publish"]);

    const outlineRows = (db as any).select().from(tables.outline).all();
    expect(outlineRows.length).toBe(1);
    expect(outlineRows[0].totalSections).toBe(2);

    const draftRows = (db as any).select().from(tables.draft).all();
    expect(draftRows.length).toBe(1);
    expect(draftRows[0].wordCount).toBe(1500);

    const editRows = (db as any).select().from(tables.edit).all();
    expect(editRows.length).toBe(1);
    expect(editRows[0].readabilityScore).toBe(72);

    const publishRows = (db as any).select().from(tables.publish).all();
    expect(publishRows.length).toBe(1);
    expect(publishRows[0].format).toBe("markdown");

    cleanup();
  });
});
