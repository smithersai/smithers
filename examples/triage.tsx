/**
 * <Triage> — Intake items → classify/prioritize → route to handlers.
 *
 * Pattern: Receive batch → AI classifies each → route by classification.
 * Use cases: bug triage, support ticket routing, PR labeling, alert handling,
 * email classification, content moderation.
 */
import { createSmithers, Sequence, Parallel } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import ClassifyPrompt from "./prompts/triage/classify.mdx";
import HandlePrompt from "./prompts/triage/handle.mdx";

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

const { Workflow, Task, smithers, outputs } = createSmithers({
  classification: classificationSchema,
  handlerResult: handlerResultSchema,
  triageReport: triageReportSchema,
});

const classifier = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep, bash },
  instructions: `You are a triage specialist. Classify incoming items by category,
priority, and routing. Be consistent and fair in prioritization.
Use "ignore" for items that don't need action.`,
});

const makeHandler = (role: string) =>
  new Agent({
    model: anthropic("claude-sonnet-4-20250514"),
    tools: { read, bash, grep },
    instructions: `You are a ${role} handler. Take appropriate action on the assigned item.
If you can handle it, do so. If it needs human attention, escalate with details.`,
  });

const handlers: Record<string, any> = {
  security: makeHandler("security incident"),
  "bug-fix": makeHandler("bug fix"),
  feature: makeHandler("feature request"),
  docs: makeHandler("documentation"),
  infra: makeHandler("infrastructure"),
};

export default smithers((ctx) => {
  const classification = ctx.outputMaybe("classification", { nodeId: "classify" });
  const results = ctx.outputs.handlerResult ?? [];

  const actionableItems = classification?.items?.filter((i) => i.assignTo !== "ignore") ?? [];

  return (
    <Workflow name="triage">
      <Sequence>
        {/* Classify all items */}
        <Task id="classify" output={outputs.classification} agent={classifier}>
          <ClassifyPrompt
            source={ctx.input.source ?? "GitHub issues"}
            items={ctx.input.items ?? null}
            fetchCmd={ctx.input.fetchCmd ?? "gh issue list --json number,title,body,labels --limit 20"}
          />
        </Task>

        {/* Route to handlers in parallel */}
        {actionableItems.length > 0 && (
          <Parallel maxConcurrency={5}>
            {actionableItems.map((item) => (
              <Task
                key={item.id}
                id={`handle-${item.id}`}
                output={outputs.handlerResult}
                agent={handlers[item.assignTo] ?? handlers["bug-fix"]}
                continueOnFail
              >
                <HandlePrompt
                  priority={item.priority}
                  category={item.category}
                  id={item.id}
                  title={item.title}
                  assignTo={item.assignTo}
                  reasoning={item.reasoning}
                />
              </Task>
            ))}
          </Parallel>
        )}

        {/* Report */}
        <Task id="report" output={outputs.triageReport}>
          {{
            totalItems: classification?.items?.length ?? 0,
            handled: results.filter((r) => r.status === "handled").length,
            escalated: results.filter((r) => r.status === "escalated").length,
            deferred: results.filter((r) => r.status === "deferred").length,
            byCategory: Object.fromEntries(
              Object.entries(
                (classification?.items ?? []).reduce((acc, i) => {
                  acc[i.assignTo] = (acc[i.assignTo] ?? 0) + 1;
                  return acc;
                }, {} as Record<string, number>)
              )
            ),
            summary: `Triaged ${classification?.items?.length ?? 0} items: ${results.filter((r) => r.status === "handled").length} handled, ${results.filter((r) => r.status === "escalated").length} escalated`,
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});
