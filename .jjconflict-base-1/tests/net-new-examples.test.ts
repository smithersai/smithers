import { describe, expect, test } from "bun:test";
import { renderHydratedExampleFrame } from "./example-fixtures";

const exampleIds = [
  "fail-only-report",
  "flake-hunter",
  "benchmark-sheriff",
  "log-digest",
  "bisect-guide",
  "failing-test-author",
  "patch-plausibility-gate",
  "merge-conflict-mediator",
  "pr-shepherd",
  "repo-janitor",
  "standards-reviewer",
  "command-watchdog",
  "repro-harness-builder",
  "branch-doctor",
  "config-diff-explainer",
  "contract-drift-sentinel",
  "visual-diff-explainer",
  "test-sharder-judge",
  "change-blast-radius",
  "docs-patcher",
  "canary-judge",
  "rollback-advisor",
  "runbook-executor",
  "alert-suppressor",
  "error-clusterer",
  "slo-breach-explainer",
  "threat-intel-enricher",
  "ransomware-isolation-coordinator",
  "mcp-health-probe",
  "trace-explainer",
  "retry-budget-manager",
  "compliance-evidence-collector",
  "support-deflector",
  "revenue-scout",
  "lead-enricher",
  "lead-router-with-approval",
  "social-inbox-router",
  "service-desk-dispatcher",
  "feedback-pulse",
  "invoice-approval-watch",
  "financial-inbox-guard",
  "trust-safety-moderator",
  "meeting-briefer",
  "memory-support-agent",
  "typed-extractor-stage",
  "schema-conformance-gate",
  "receipt-stream-watcher",
  "prompt-optimizer-harness",
  "classifier-switchboard",
  "dynamic-schema-enricher",
  "collector-probe",
  "openapi-contract-agent",
  "form-filler-assistant",
  "docs-fixup-bot",
  "survey-answerer-agent",
  "extract-anything-workbench",
  "friday-bot",
  "blog-analyzer-pipeline",
] as const;

describe("net-new examples", () => {
  test("example list remains complete", () => {
    expect(exampleIds.length).toBe(58);
  });

  for (const exampleId of exampleIds) {
    test(exampleId, async () => {
      const module = await import(`../examples/${exampleId}.tsx`);
      const workflow = module.default;
      const { frame } = await renderHydratedExampleFrame(
        workflow,
        exampleId,
        (module.sampleInput ?? {}) as Record<string, unknown>,
      );
      expect(frame.xml).toBeDefined();
      expect(frame.tasks.length).toBeGreaterThan(0);

      try {
        (workflow.db as any)?.$client?.close?.();
      } catch {}
    });
  }
});
