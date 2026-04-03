import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildContext } from "../src/context";
import { renderFrame } from "../src/index";

const examplesDir = join(process.cwd(), "examples");
const exampleFiles = readdirSync(examplesDir)
  .filter((file) => file.endsWith(".tsx") && !file.startsWith("_"))
  .sort();
const tsNoCheckAllowlist: string[] = [
  "alert-suppressor.tsx",
  "benchmark-sheriff.tsx",
  "bisect-guide.tsx",
  "branch-doctor.tsx",
  "canary-judge.tsx",
  "change-blast-radius.tsx",
  "command-watchdog.tsx",
  "compliance-evidence-collector.tsx",
  "config-diff-explainer.tsx",
  "contract-drift-sentinel.tsx",
  "docs-fixup-bot.tsx",
  "docs-patcher.tsx",
  "error-clusterer.tsx",
  "fail-only-report.tsx",
  "failing-test-author.tsx",
  "feedback-pulse.tsx",
  "flake-hunter.tsx",
  "form-filler-assistant.tsx",
  "friday-bot.tsx",
  "invoice-approval-watch.tsx",
  "lead-enricher.tsx",
  "lead-router-with-approval.tsx",
  "log-digest.tsx",
  "mcp-health-probe.tsx",
  "meeting-briefer.tsx",
  "memory-support-agent.tsx",
  "merge-conflict-mediator.tsx",
  "migration.tsx",
  "milestone.tsx",
  "openapi-contract-agent.tsx",
  "patch-plausibility-gate.tsx",
  "pr-shepherd.tsx",
  "ransomware-isolation-coordinator.tsx",
  "repo-janitor.tsx",
  "repro-harness-builder.tsx",
  "retry-budget-manager.tsx",
  "revenue-scout.tsx",
  "review-cycle.tsx",
  "rollback-advisor.tsx",
  "runbook-executor.tsx",
  "scaffold.tsx",
  "schema-conformance-gate.tsx",
  "service-desk-dispatcher.tsx",
  "slo-breach-explainer.tsx",
  "social-inbox-router.tsx",
  "standards-reviewer.tsx",
  "support-deflector.tsx",
  "test-sharder-judge.tsx",
  "threat-intel-enricher.tsx",
  "trace-explainer.tsx",
  "visual-diff-explainer.tsx",
];

describe("examples (cleanliness)", () => {
  test("examples use the in-memory helper", () => {
    for (const file of exampleFiles) {
      const source = readFileSync(join(examplesDir, file), "utf8");
      expect(source.includes("createExampleSmithers(")).toBe(true);
      expect(source.includes("createSmithers(")).toBe(false);
    }
  });

  test("examples directory has no checked-in sqlite artifacts", () => {
    const sqliteArtifacts = readdirSync(examplesDir).filter((file) =>
      /\.(db|db-shm|db-wal)$/.test(file),
    );
    expect(sqliteArtifacts).toEqual([]);
  });

  test("ts-nocheck usage is explicit and does not spread", () => {
    const current = exampleFiles.filter((file) =>
      readFileSync(join(examplesDir, file), "utf8").includes("// @ts-nocheck"),
    );
    expect(current).toEqual(tsNoCheckAllowlist);
  });

  test("pr-lifecycle gates CI and merge on push output", async () => {
    const module = await import("../examples/pr-lifecycle.tsx");
    const workflow = module.default;

    const beforePush = buildContext({
      runId: "pr-lifecycle-before-push",
      iteration: 0,
      input: { mergeMethod: "squash" },
      outputs: {
        rebase: [{ runId: "x", nodeId: "rebase", iteration: 0, conflicts: false, conflictFiles: [], summary: "clean" }],
        review: [{ runId: "x", nodeId: "review", iteration: 0, issues: [], approved: true, summary: "approved" }],
      },
      zodToKeyName: workflow.zodToKeyName,
    });

    const beforePushFrame = await renderFrame(workflow, beforePush);
    const pushTaskBefore = beforePushFrame.tasks.find((task: any) => (task.nodeId ?? task.id) === "push");
    const pollTaskBefore = beforePushFrame.tasks.find((task: any) => (task.nodeId ?? task.id) === "poll-ci");
    const mergeTaskBefore = beforePushFrame.tasks.find((task: any) => (task.nodeId ?? task.id) === "merge");
    expect(pushTaskBefore?.skipIf).toBe(false);
    expect(pollTaskBefore).toBeUndefined();
    expect(mergeTaskBefore?.skipIf).toBe(true);

    const afterPush = buildContext({
      runId: "pr-lifecycle-after-push",
      iteration: 0,
      input: { mergeMethod: "squash" },
      outputs: {
        rebase: [{ runId: "x", nodeId: "rebase", iteration: 0, conflicts: false, conflictFiles: [], summary: "clean" }],
        review: [{ runId: "x", nodeId: "review", iteration: 0, issues: [], approved: true, summary: "approved" }],
        push: [{ runId: "x", nodeId: "push", iteration: 0, pushed: true, forced: true, remote: "origin", branch: "feature/example", summary: "pushed" }],
        ci: [{ runId: "x", nodeId: "poll-ci", iteration: 0, status: "pass", checks: [], mergeable: true }],
      },
      zodToKeyName: workflow.zodToKeyName,
    });

    const afterPushFrame = await renderFrame(workflow, afterPush);
    const pollTaskAfter = afterPushFrame.tasks.find((task: any) => (task.nodeId ?? task.id) === "poll-ci");
    const mergeTaskAfter = afterPushFrame.tasks.find((task: any) => (task.nodeId ?? task.id) === "merge");
    expect(pollTaskAfter?.skipIf).toBe(false);
    expect(mergeTaskAfter?.skipIf).toBe(false);

    const pushTask = afterPushFrame.tasks.find((task: any) => (task.nodeId ?? task.id) === "push");
    expect(pushTask?.outputTableName).toBe("push");
  });
});
