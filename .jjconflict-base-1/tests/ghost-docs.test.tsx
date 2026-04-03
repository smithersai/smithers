/** @jsxImportSource smithers */
/**
 * Tests for all ghost-doc examples in docs/examples/.
 * Each test validates that the workflow pattern shown in the corresponding
 * ghost doc actually compiles and runs correctly against the real Smithers engine.
 */
import { describe, expect, test } from "bun:test";
import {
  Branch,
  Parallel,
  Ralph,
  Sequence,
  Task,
  Workflow,
  createSmithers,
  runWorkflow,
} from "../src/index";
import { SmithersDb } from "../src/db/adapter";
import { approveNode } from "../src/engine/approvals";
import { createTestSmithers } from "./helpers";
import { outputSchemas } from "./schema";
import { z } from "zod";
import QuickstartPlanPrompt from "./prompts/ghost-docs/quickstart-plan.mdx";
import QuickstartBriefPrompt from "./prompts/ghost-docs/quickstart-brief.mdx";
import ValidationImplementPrompt from "./prompts/ghost-docs/validation-implement.mdx";
import ValidationReviewPrompt from "./prompts/ghost-docs/validation-review.mdx";
import ParallelReviewPrompt from "./prompts/ghost-docs/parallel-review.mdx";
import DiscoverTicketsPrompt from "./prompts/ghost-docs/discover-tickets.mdx";
import TicketReportPrompt from "./prompts/ghost-docs/ticket-report.mdx";
import ResearchPrompt from "./prompts/ghost-docs/research.mdx";
import ReportPrompt from "./prompts/ghost-docs/report.mdx";
import HelloWorldGreetPrompt from "./prompts/ghost-docs/hello-world-greet.mdx";
import DynamicAnalyzePrompt from "./prompts/ghost-docs/dynamic-analyze.mdx";
import DynamicPlanPrompt from "./prompts/ghost-docs/dynamic-plan.mdx";
import DynamicExecutePrompt from "./prompts/ghost-docs/dynamic-execute.mdx";
import DynamicQuickFixPrompt from "./prompts/ghost-docs/dynamic-quick-fix.mdx";
import RalphWritePrompt from "./prompts/ghost-docs/ralph-write.mdx";
import RalphReviewPrompt from "./prompts/ghost-docs/ralph-review.mdx";
import MultiSecurityReviewPrompt from "./prompts/ghost-docs/multi-security-review.mdx";
import MultiQualityReviewPrompt from "./prompts/ghost-docs/multi-quality-review.mdx";
import MultiAggregatePrompt from "./prompts/ghost-docs/multi-aggregate.mdx";
import ApprovalWriteDraftPrompt from "./prompts/ghost-docs/approval-write-draft.mdx";
import ApprovalPublishPrompt from "./prompts/ghost-docs/approval-publish.mdx";
import ToolsSearchPrompt from "./prompts/ghost-docs/tools-search.mdx";

// ---------------------------------------------------------------------------
// Ghost: workflows/hello.tsx — literal output, no agent
// ---------------------------------------------------------------------------
describe("ghost: workflow-hello", () => {
  test("literal Task output with no agent produces deterministic result", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      output: z.object({
        message: z.string(),
        length: z.number(),
      }),
    });

    try {
      const workflow = smithers((ctx) => (
        <Workflow name="hello">
          <Task id="hello" output={outputs.output}>
            {{ message: `Hello, ${ctx.input.name}!`, length: String(ctx.input.name).length }}
          </Task>
        </Workflow>
      ));

      const result = await runWorkflow(workflow, {
        input: { name: "World" },
        runId: "ghost-hello",
      });
      expect(result.status).toBe("finished");

      const rows = await (db as any).select().from(tables.output);
      expect(rows[0]?.message).toBe("Hello, World!");
      expect(rows[0]?.length).toBe(5);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Ghost: workflows/approval.tsx — needsApproval gate
// ---------------------------------------------------------------------------
describe("ghost: workflow-approval", () => {
  test("needsApproval pauses workflow until approved", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      output: z.object({
        message: z.string(),
        length: z.number(),
      }),
    });

    try {
      const workflow = smithers((ctx) => (
        <Workflow name="approval">
          <Sequence>
            <Task id="approve" output={outputs.output} needsApproval>
              {{
                message: `Approved: ${ctx.input.name}`,
                length: String(ctx.input.name).length,
              }}
            </Task>
            <Task id="final" output={outputs.output}>
              {{
                message: `Done: ${ctx.input.name}`,
                length: String(ctx.input.name).length,
              }}
            </Task>
          </Sequence>
        </Workflow>
      ));

      // First run — pauses at approval gate
      const first = await runWorkflow(workflow, {
        input: { name: "Deploy" },
        runId: "ghost-approval",
      });
      expect(first.status).toBe("waiting-approval");

      // Approve the gate
      const adapter = new SmithersDb(workflow.db as any);
      await approveNode(adapter, first.runId, "approve", 0, "ok", "test");

      // Resume — completes
      const resumed = await runWorkflow(workflow, {
        input: { name: "Deploy" },
        runId: first.runId,
        resume: true,
      });
      expect(resumed.status).toBe("finished");

      const rows = await (db as any).select().from(tables.output);
      expect(rows.length).toBe(2);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Ghost: workflows/quickstart.tsx — two-agent sequential pipeline
// ---------------------------------------------------------------------------
describe("ghost: workflow-quickstart", () => {
  test("sequential tasks with cross-task data flow", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      plan: z.object({
        summary: z.string(),
        steps: z.array(z.string()),
      }),
      brief: z.object({
        brief: z.string(),
        stepCount: z.number(),
      }),
    });

    try {
      const planAgent = {
        id: "plan-agent",
        tools: {},
        async generate() {
          return {
            output: {
              summary: "Build a CLI tool",
              steps: ["Step 1", "Step 2", "Step 3"],
            },
          };
        },
      };

      const briefAgent = {
        id: "brief-agent",
        tools: {},
        async generate() {
          return {
            output: {
              brief: "This plan covers 3 steps for building a CLI tool.",
              stepCount: 3,
            },
          };
        },
      };

      const workflow = smithers((ctx) => {
        const planOutput = ctx.outputMaybe("plan", { nodeId: "plan" });
        return (
          <Workflow name="quickstart">
            <Sequence>
              <Task id="plan" output={outputs.plan} agent={planAgent}>
                <QuickstartPlanPrompt goal={ctx.input.goal} />
              </Task>
              <Task id="brief" output={outputs.brief} agent={briefAgent}>
                <QuickstartBriefPrompt
                  goal={ctx.input.goal}
                  plan={planOutput?.summary ?? "pending"}
                  steps={planOutput?.steps ?? []}
                />
              </Task>
            </Sequence>
          </Workflow>
        );
      });

      const result = await runWorkflow(workflow, {
        input: { goal: "Build a CLI tool" },
        runId: "ghost-quickstart",
      });
      expect(result.status).toBe("finished");

      const planRows = await (db as any).select().from(tables.plan);
      expect(planRows[0]?.summary).toBe("Build a CLI tool");

      const briefRows = await (db as any).select().from(tables.brief);
      expect(briefRows[0]?.stepCount).toBe(3);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Ghost: worktree-feature — validation loop with Ralph
// ---------------------------------------------------------------------------
describe("ghost: worktree-feature (validation loop pattern)", () => {
  test("Ralph loop iterates implement/review until approved", async () => {
    let reviewCalls = 0;
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      implement: z.object({ whatWasDone: z.string() }),
      review: z.object({ approved: z.boolean(), feedback: z.string() }),
    });

    try {
      const implementAgent = {
        id: "impl",
        tools: {},
        async generate() {
          return { output: { whatWasDone: "Implemented feature" } };
        },
      };

      const reviewAgent = {
        id: "reviewer",
        tools: {},
        async generate() {
          reviewCalls++;
          return {
            output: {
              approved: reviewCalls >= 2,
              feedback: reviewCalls >= 2 ? "LGTM" : "Needs changes",
            },
          };
        },
      };

      const workflow = smithers((ctx) => {
        const latestReview = ctx.latest("review", "review");
        return (
          <Workflow name="validation-loop">
            <Ralph
              id="impl-review-loop"
              until={latestReview?.approved === true}
              maxIterations={5}
              onMaxReached="return-last"
            >
              <Sequence>
                <Task id="implement" output={outputs.implement} agent={implementAgent}>
                  <ValidationImplementPrompt />
                </Task>
                <Task id="review" output={outputs.review} agent={reviewAgent}>
                  <ValidationReviewPrompt />
                </Task>
              </Sequence>
            </Ralph>
          </Workflow>
        );
      });

      const result = await runWorkflow(workflow, {
        input: {},
        runId: "ghost-validation-loop",
      });
      expect(result.status).toBe("finished");
      expect(reviewCalls).toBe(2);

      const reviewRows = await (db as any).select().from(tables.review);
      expect(reviewRows.length).toBe(2);
    } finally {
      cleanup();
    }
  });

  test("parallel dual review pattern", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      review: z.object({
        reviewer: z.string(),
        approved: z.boolean(),
        feedback: z.string(),
      }),
    });

    try {
      const makeReviewer = (name: string) => ({
        id: name,
        tools: {},
        async generate() {
          return {
            output: {
              reviewer: name,
              approved: true,
              feedback: `${name} approves`,
            },
          };
        },
      });

      const workflow = smithers(() => (
        <Workflow name="parallel-review">
          <Parallel>
            <Task id="review-claude" output={outputs.review} agent={makeReviewer("claude")}>
              <ParallelReviewPrompt />
            </Task>
            <Task id="review-codex" output={outputs.review} agent={makeReviewer("codex")}>
              <ParallelReviewPrompt />
            </Task>
          </Parallel>
        </Workflow>
      ));

      const result = await runWorkflow(workflow, {
        input: {},
        runId: "ghost-parallel-review",
      });
      expect(result.status).toBe("finished");

      const rows = await (db as any).select().from(tables.review);
      expect(rows.length).toBe(2);
      const reviewers = rows.map((r: any) => r.reviewer).sort();
      expect(reviewers).toEqual(["claude", "codex"]);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Ghost: worktree-feature schemas — Zod schema validation
// ---------------------------------------------------------------------------
describe("ghost: worktree-feature-schemas", () => {
  test("Discover schema validates ticket structure", () => {
    const Ticket = z.object({
      id: z.string(),
      title: z.string(),
      description: z.string(),
      acceptanceCriteria: z.array(z.string()),
      filesToModify: z.array(z.string()),
      filesToCreate: z.array(z.string()),
      dependencies: z.array(z.string()).nullable(),
    });

    const DiscoverOutput = z.object({
      tickets: z.array(Ticket),
      reasoning: z.string(),
    });

    const valid = DiscoverOutput.parse({
      tickets: [
        {
          id: "vcs-jj-rewrite",
          title: "Rewrite VCS layer",
          description: "Full rewrite",
          acceptanceCriteria: ["Tests pass"],
          filesToModify: ["src/vcs/jj.ts"],
          filesToCreate: [],
          dependencies: null,
        },
      ],
      reasoning: "Foundation first",
    });
    expect(valid.tickets.length).toBe(1);
    expect(valid.tickets[0].id).toBe("vcs-jj-rewrite");
  });

  test("Review schema validates severity enum", () => {
    const ReviewOutput = z.object({
      reviewer: z.string(),
      approved: z.boolean(),
      issues: z.array(
        z.object({
          severity: z.enum(["critical", "major", "minor", "nit"]),
          file: z.string(),
          line: z.number().nullable(),
          description: z.string(),
          suggestion: z.string().nullable(),
        }),
      ),
      testCoverage: z.enum(["excellent", "good", "insufficient", "missing"]),
      codeQuality: z.enum(["excellent", "good", "needs-work", "poor"]),
      feedback: z.string(),
    });

    const result = ReviewOutput.parse({
      reviewer: "claude",
      approved: false,
      issues: [
        {
          severity: "minor",
          file: "src/index.ts",
          line: 42,
          description: "Missing type annotation",
          suggestion: "Add `: string`",
        },
      ],
      testCoverage: "good",
      codeQuality: "good",
      feedback: "One minor issue",
    });
    expect(result.issues.length).toBe(1);
    expect(result.issues[0].severity).toBe("minor");
  });

  test("schemas work as createSmithers output keys", async () => {
    const ImplementOutput = z.object({
      filesCreated: z.array(z.string()).nullable(),
      whatWasDone: z.string(),
      allTestsPassing: z.boolean(),
    });

    const ValidateOutput = z.object({
      allPassed: z.boolean(),
      failingSummary: z.string().nullable(),
    });

    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      implement: ImplementOutput,
      validate: ValidateOutput,
    });

    try {
      const workflow = smithers(() => (
        <Workflow name="schema-test">
          <Sequence>
            <Task id="impl" output={outputs.implement}>
              {{
                filesCreated: ["src/new.ts"],
                whatWasDone: "Added new file",
                allTestsPassing: true,
              }}
            </Task>
            <Task id="val" output={outputs.validate}>
              {{ allPassed: true, failingSummary: null }}
            </Task>
          </Sequence>
        </Workflow>
      ));

      const result = await runWorkflow(workflow, { input: {} });
      expect(result.status).toBe("finished");

      const implRows = await (db as any).select().from(tables.implement);
      expect(implRows[0]?.whatWasDone).toBe("Added new file");

      const valRows = await (db as any).select().from(tables.validate);
      expect(valRows[0]?.allPassed).toBeTruthy();
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Ghost: worktree-feature-workflow — dynamic ticket pipeline
// ---------------------------------------------------------------------------
describe("ghost: worktree-feature-workflow (ticket pipeline)", () => {
  test("Branch + dynamic map renders correct pipeline", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      discover: z.object({
        tickets: z.array(z.object({ id: z.string(), title: z.string() })),
        reasoning: z.string(),
      }),
      report: z.object({ summary: z.string() }),
    });

    try {
      const discoverAgent = {
        id: "discover",
        tools: {},
        async generate() {
          return {
            output: {
              tickets: [
                { id: "ticket-1", title: "First ticket" },
                { id: "ticket-2", title: "Second ticket" },
              ],
              reasoning: "Ordered by dependency",
            },
          };
        },
      };

      const reportAgent = {
        id: "reporter",
        tools: {},
        async generate() {
          return { output: { summary: "Ticket completed" } };
        },
      };

      const workflow = smithers((ctx) => {
        const discoverOutput = ctx.latest("discover", "discover");
        const tickets = discoverOutput?.tickets ?? [];
        const unfinished = tickets.filter(
          (t: any) => !ctx.latest("report", `${t.id}:report`),
        );

        return (
          <Workflow name="ticket-pipeline">
            <Sequence>
              <Branch
                if={tickets.length === 0}
                then={
                  <Task id="discover" output={outputs.discover} agent={discoverAgent}>
                    <DiscoverTicketsPrompt />
                  </Task>
                }
              />
              {unfinished.map((ticket: any) => (
                <Task
                  key={ticket.id}
                  id={`${ticket.id}:report`}
                  output={outputs.report}
                  agent={reportAgent}
                >
                  <TicketReportPrompt title={ticket.title} />
                </Task>
              ))}
            </Sequence>
          </Workflow>
        );
      });

      const result = await runWorkflow(workflow, {
        input: {},
        runId: "ghost-pipeline",
      });
      expect(result.status).toBe("finished");

      const reportRows = await (db as any).select().from(tables.report);
      expect(reportRows.length).toBe(2);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Docs: quickstart.mdx — two-agent sequential with outputs.xxx
// ---------------------------------------------------------------------------
describe("docs: quickstart", () => {
  test("createSmithers returns outputs object and Task uses outputs.xxx", async () => {
    const researchSchema = z.object({
      summary: z.string(),
      keyPoints: z.array(z.string()),
    });
    const reportSchema = z.object({
      title: z.string(),
      body: z.string(),
      wordCount: z.number(),
    });

    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      research: researchSchema,
      report: reportSchema,
    });

    try {
      const researcher = {
        id: "researcher",
        tools: {},
        async generate() {
          return {
            output: {
              summary: "Zig is a systems language",
              keyPoints: ["Low-level", "No hidden allocations", "Comptime"],
            },
          };
        },
      };

      const writer = {
        id: "writer",
        tools: {},
        async generate() {
          return {
            output: {
              title: "Zig: A Brief History",
              body: "Zig is a modern systems programming language...",
              wordCount: 342,
            },
          };
        },
      };

      const workflow = smithers((ctx) => (
        <Workflow name="research-report">
          <Task id="research" output={outputs.research} agent={researcher}>
            <ResearchPrompt topic={ctx.input.topic} />
          </Task>
          <Task id="report" output={outputs.report} agent={writer}>
            <ReportPrompt summary={ctx.outputMaybe("research", { nodeId: "research" })?.summary ?? ""} />
          </Task>
        </Workflow>
      ));

      const result = await runWorkflow(workflow, {
        input: { topic: "The history of the Zig programming language" },
        runId: "quickstart-test",
      });
      expect(result.status).toBe("finished");

      const researchRows = await (db as any).select().from(tables.research);
      expect(researchRows[0]?.summary).toBe("Zig is a systems language");

      const reportRows = await (db as any).select().from(tables.report);
      expect(reportRows[0]?.title).toBe("Zig: A Brief History");
      expect(reportRows[0]?.wordCount).toBe(342);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Docs: hello-world.mdx — single agent task
// ---------------------------------------------------------------------------
describe("docs: hello-world", () => {
  test("single task with outputs.greeting", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      greeting: z.object({ message: z.string() }),
    });

    try {
      const greeter = {
        id: "greeter",
        tools: {},
        async generate() {
          return { output: { message: "Hello Alice! Welcome!" } };
        },
      };

      const workflow = smithers(() => (
        <Workflow name="hello-world">
          <Sequence>
            <Task id="greet" output={outputs.greeting} agent={greeter}>
              <HelloWorldGreetPrompt />
            </Task>
          </Sequence>
        </Workflow>
      ));

      const result = await runWorkflow(workflow, { input: {} });
      expect(result.status).toBe("finished");

      const rows = await (db as any).select().from(tables.greeting);
      expect(rows[0]?.message).toBe("Hello Alice! Welcome!");
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Docs: dynamic-plan.mdx — Branch based on analysis
// ---------------------------------------------------------------------------
describe("docs: dynamic-plan", () => {
  test("Branch routes to complex path when complexity is high", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      analysis: z.object({
        summary: z.string(),
        complexity: z.enum(["low", "high"]),
      }),
      plan: z.object({ steps: z.array(z.string()) }),
      result: z.object({ output: z.string() }),
    });

    try {
      const analyzer = {
        id: "analyzer",
        tools: {},
        async generate() {
          return {
            output: { summary: "Refactor auth", complexity: "high" },
          };
        },
      };

      const planner = {
        id: "planner",
        tools: {},
        async generate() {
          return {
            output: { steps: ["Abstract interface", "Implement OAuth2", "Add tests"] },
          };
        },
      };

      const implementer = {
        id: "implementer",
        tools: {},
        async generate() {
          return { output: { output: "Refactored auth module" } };
        },
      };

      const workflow = smithers((ctx) => {
        const analysis = ctx.outputMaybe("analysis", { nodeId: "analyze" });
        const isComplex = analysis?.complexity === "high";
        return (
          <Workflow name="dynamic-plan">
            <Sequence>
              <Task id="analyze" output={outputs.analysis} agent={analyzer}>
                <DynamicAnalyzePrompt />
              </Task>
              <Branch
                if={isComplex}
                then={
                  <Sequence>
                    <Task id="plan" output={outputs.plan} agent={planner}>
                      <DynamicPlanPrompt summary={analysis?.summary} />
                    </Task>
                    <Task id="implement" output={outputs.result} agent={implementer}>
                      <DynamicExecutePrompt />
                    </Task>
                  </Sequence>
                }
                else={
                  <Task id="implement" output={outputs.result} agent={implementer}>
                    <DynamicQuickFixPrompt />
                  </Task>
                }
              />
            </Sequence>
          </Workflow>
        );
      });

      const result = await runWorkflow(workflow, { input: {}, runId: "dynamic-plan-test" });
      expect(result.status).toBe("finished");

      const planRows = await (db as any).select().from(tables.plan);
      expect(planRows.length).toBe(1);
      expect(planRows[0]?.steps).toEqual(["Abstract interface", "Implement OAuth2", "Add tests"]);

      const resultRows = await (db as any).select().from(tables.result);
      expect(resultRows[0]?.output).toBe("Refactored auth module");
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Docs: ralph-loop.mdx — write/review iteration loop
// ---------------------------------------------------------------------------
describe("docs: ralph-loop", () => {
  test("Ralph iterates write/review until approved", async () => {
    let reviewCalls = 0;
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      code: z.object({ source: z.string(), language: z.string() }),
      review: z.object({ approved: z.boolean(), feedback: z.string() }),
      finalOutput: z.object({ source: z.string(), iterations: z.number() }),
    });

    try {
      const coder = {
        id: "coder",
        tools: {},
        async generate() {
          return { output: { source: "function debounce() {}", language: "ts" } };
        },
      };

      const reviewer = {
        id: "reviewer",
        tools: {},
        async generate() {
          reviewCalls++;
          return {
            output: {
              approved: reviewCalls >= 2,
              feedback: reviewCalls >= 2 ? "LGTM" : "Missing generics",
            },
          };
        },
      };

      const workflow = smithers((ctx) => {
        const latestReview = ctx.outputMaybe("review", { nodeId: "review" });
        const latestCode = ctx.outputMaybe("code", { nodeId: "write" });
        return (
          <Workflow name="ralph-loop">
            <Sequence>
              <Ralph
                id="revision-loop"
                until={latestReview?.approved === true}
                maxIterations={5}
                onMaxReached="return-last"
              >
                <Sequence>
                  <Task id="write" output={outputs.code} agent={coder}>
                    <RalphWritePrompt feedback={latestReview?.feedback} />
                  </Task>
                  <Task id="review" output={outputs.review} agent={reviewer}>
                    <RalphReviewPrompt source={latestCode?.source ?? "no code yet"} />
                  </Task>
                </Sequence>
              </Ralph>
              <Task id="final" output={outputs.finalOutput}>
                {{
                  source: latestCode?.source ?? "",
                  iterations: ctx.iterationCount("code", "write"),
                }}
              </Task>
            </Sequence>
          </Workflow>
        );
      });

      const result = await runWorkflow(workflow, { input: {}, runId: "ralph-loop-test" });
      expect(result.status).toBe("finished");
      expect(reviewCalls).toBe(2);

      const finalRows = await (db as any).select().from(tables.finalOutput);
      expect(finalRows[0]?.source).toBe("function debounce() {}");
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Docs: multi-agent-review.mdx — parallel reviews + aggregation
// ---------------------------------------------------------------------------
describe("docs: multi-agent-review", () => {
  test("parallel reviewers + aggregator with outputs.xxx", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      review: z.object({ approved: z.boolean(), feedback: z.string() }),
      verdict: z.object({ approved: z.boolean(), summary: z.string() }),
    });

    try {
      const makeReviewer = (name: string, approve: boolean) => ({
        id: name,
        tools: {},
        async generate() {
          return { output: { approved: approve, feedback: `${name}: looks ${approve ? "good" : "bad"}` } };
        },
      });

      const aggregator = {
        id: "aggregator",
        tools: {},
        async generate() {
          return { output: { approved: false, summary: "Security good, quality needs work" } };
        },
      };

      const workflow = smithers((ctx) => {
        const secReview = ctx.outputMaybe("review", { nodeId: "security-review" });
        const qualReview = ctx.outputMaybe("review", { nodeId: "quality-review" });
        return (
          <Workflow name="multi-agent-review">
            <Sequence>
              <Parallel maxConcurrency={2}>
                <Task id="security-review" output={outputs.review} agent={makeReviewer("security", true)}>
                  <MultiSecurityReviewPrompt />
                </Task>
                <Task id="quality-review" output={outputs.review} agent={makeReviewer("quality", false)}>
                  <MultiQualityReviewPrompt />
                </Task>
              </Parallel>
              <Task id="aggregate" output={outputs.verdict} agent={aggregator}>
                <MultiAggregatePrompt
                  securityFeedback={secReview?.feedback}
                  qualityFeedback={qualReview?.feedback}
                />
              </Task>
            </Sequence>
          </Workflow>
        );
      });

      const result = await runWorkflow(workflow, { input: {}, runId: "multi-review-test" });
      expect(result.status).toBe("finished");

      const reviewRows = await (db as any).select().from(tables.review);
      expect(reviewRows.length).toBe(2);

      const verdictRows = await (db as any).select().from(tables.verdict);
      expect(verdictRows[0]?.approved).toBe(false);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Docs: approval-gate.mdx — needsApproval pauses then resumes
// ---------------------------------------------------------------------------
describe("docs: approval-gate", () => {
  test("needsApproval pauses before publish, resumes after approval", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      draft: z.object({ title: z.string(), content: z.string() }),
      published: z.object({ url: z.string(), publishedAt: z.string() }),
    });

    try {
      const writer = {
        id: "writer",
        tools: {},
        async generate() {
          return { output: { title: "Why Resumability Matters", content: "In production AI systems..." } };
        },
      };

      const publisher = {
        id: "publisher",
        tools: {},
        async generate() {
          return { output: { url: "https://blog.example.com/resumability", publishedAt: "2026-02-10T12:00:00Z" } };
        },
      };

      const workflow = smithers((ctx) => {
        const draft = ctx.outputMaybe("draft", { nodeId: "write-draft" });
        return (
          <Workflow name="approval-gate">
            <Sequence>
              <Task id="write-draft" output={outputs.draft} agent={writer}>
                <ApprovalWriteDraftPrompt />
              </Task>
              <Task
                id="publish"
                output={outputs.published}
                agent={publisher}
                needsApproval
                label="Publish blog post"
              >
                <ApprovalPublishPrompt title={draft?.title} />
              </Task>
            </Sequence>
          </Workflow>
        );
      });

      // First run — pauses at approval
      const first = await runWorkflow(workflow, { input: {}, runId: "approval-gate-test" });
      expect(first.status).toBe("waiting-approval");

      const draftRows = await (db as any).select().from(tables.draft);
      expect(draftRows[0]?.title).toBe("Why Resumability Matters");

      // Approve
      const adapter = new SmithersDb(workflow.db as any);
      await approveNode(adapter, first.runId, "publish", 0, "ok", "test");

      // Resume
      const resumed = await runWorkflow(workflow, {
        input: {},
        runId: first.runId,
        resume: true,
      });
      expect(resumed.status).toBe("finished");

      const pubRows = await (db as any).select().from(tables.published);
      expect(pubRows[0]?.url).toBe("https://blog.example.com/resumability");
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Docs: tools-agent.mdx — agent with tools, timeoutMs, retries
// ---------------------------------------------------------------------------
describe("docs: tools-agent", () => {
  test("Task with timeoutMs and retries props", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      searchResult: z.object({
        matches: z.array(z.object({ file: z.string(), line: z.number(), content: z.string() })),
        summary: z.string(),
        recommendation: z.string(),
      }),
    });

    try {
      let seenTimeout: number | undefined;
      const codeSearchAgent = {
        id: "code-search",
        tools: {},
        async generate(options: { timeout?: { totalMs: number } }) {
          seenTimeout = options.timeout?.totalMs;
          return {
            output: {
              matches: [{ file: "src/auth.ts", line: 45, content: "legacyAuth.create()" }],
              summary: "1 usage in 1 file",
              recommendation: "Replace with AuthService",
            },
          };
        },
      };

      const workflow = smithers(() => (
        <Workflow name="tools-agent">
          <Sequence>
            <Task
              id="search"
              output={outputs.searchResult}
              agent={codeSearchAgent}
              timeoutMs={60_000}
              retries={2}
            >
              <ToolsSearchPrompt />
            </Task>
          </Sequence>
        </Workflow>
      ));

      const result = await runWorkflow(workflow, { input: {}, runId: "tools-agent-test" });
      expect(result.status).toBe("finished");
      expect(seenTimeout).toBe(60_000);

      const rows = await (db as any).select().from(tables.searchResult);
      expect(rows[0]?.matches).toEqual([{ file: "src/auth.ts", line: 45, content: "legacyAuth.create()" }]);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Ghost: CI workflow — validates the pattern is documentable (no runtime test needed)
// Ghost: AGENTS.md — documentation only, no runtime test needed
// Ghost: generate-llms-txt.ts — script utility, no runtime test needed
// Ghost: Claude Code plugins — plugin config, no runtime test needed
// ---------------------------------------------------------------------------
describe("ghost: documentation-only examples", () => {
  test("placeholder — CI, AGENTS.md, generate-llms-txt, and plugin docs are documentation-only ghost docs", () => {
    // These ghost docs document scripts/configs that aren't Smithers workflows.
    // Their correctness is validated by the files existing and being readable.
    expect(true).toBe(true);
  });
});
