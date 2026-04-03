// @ts-nocheck
/**
 * <ConfigDiffExplainer> — Read env/config/Helm/Terraform/k8s diffs and produce
 * a plain-English blast-radius and risk summary.
 *
 * Shape: diff fetcher -> config-aware explainer agent -> approval/comment sink.
 */
import { Sequence } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import FetchPrompt from "./prompts/config-diff-explainer/fetch.mdx";
import ExplainPrompt from "./prompts/config-diff-explainer/explain.mdx";
import ApprovalPrompt from "./prompts/config-diff-explainer/approval.mdx";

const fetchedDiffSchema = z.object({
  files: z.array(
    z.object({
      path: z.string(),
      kind: z.enum(["helm", "terraform", "k8s", "env", "other"]),
      diff: z.string(),
      service: z.string(),
    })
  ),
  totalChanges: z.number(),
  summary: z.string(),
});

const explainerSchema = z.object({
  blastRadius: z.array(
    z.object({
      system: z.string(),
      impact: z.string(),
      severity: z.enum(["low", "medium", "high", "critical"]),
    })
  ),
  riskLevel: z.enum(["low", "medium", "high", "critical"]),
  affectedSystems: z.array(z.string()),
  rollbackNotes: z.string(),
  summary: z.string(),
});

const approvalSchema = z.object({
  action: z.enum(["approve", "request-changes", "comment"]),
  comment: z.string(),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
  fetchedDiff: fetchedDiffSchema,
  explanation: explainerSchema,
  approval: approvalSchema,
});

const fetcher = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a config diff fetcher. Given file paths or git refs, collect the
raw diffs for environment files, Helm values, Terraform plans, and Kubernetes manifests.
Classify each file by kind and identify the service it belongs to.`,
});

const explainer = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a config change analyst. Given collected diffs from infrastructure
config files (Helm, Terraform, k8s manifests, env files), produce a blast-radius analysis.
Identify every affected system, rate each impact's severity, assign an overall risk level,
and note any rollback considerations. Be specific — mention replica counts, resource limits,
timeout changes, feature flags, and network policy shifts.`,
});

export default smithers((ctx) => {
  const fetched = ctx.outputMaybe("fetchedDiff", { nodeId: "fetch-diffs" });
  const explanation = ctx.outputMaybe("explanation", { nodeId: "explain" });

  return (
    <Workflow name="config-diff-explainer">
      <Sequence>
        {/* Stage 1: Fetch and classify config diffs */}
        <Task id="fetch-diffs" output={outputs.fetchedDiff} agent={fetcher}>
          <FetchPrompt
            paths={ctx.input.paths ?? []}
            gitRef={ctx.input.gitRef ?? "HEAD~1..HEAD"}
            filePatterns={ctx.input.filePatterns ?? ["values.yaml", "*.tf", "*.env", "*.yaml"]}
          />
        </Task>

        {/* Stage 2: Explainer agent produces blast-radius analysis */}
        <Task id="explain" output={outputs.explanation} agent={explainer}>
          <ExplainPrompt
            files={fetched?.files ?? []}
            totalChanges={fetched?.totalChanges ?? 0}
            context={ctx.input.context ?? ""}
          />
        </Task>

        {/* Stage 3: Approval/comment sink */}
        <Task id="approve" output={outputs.approval}>
          <ApprovalPrompt
            riskLevel={explanation?.riskLevel ?? "low"}
            affectedSystems={explanation?.affectedSystems ?? []}
            blastRadius={explanation?.blastRadius ?? []}
            summary={explanation?.summary ?? ""}
            autoApproveThreshold={ctx.input.autoApproveThreshold ?? "low"}
          />
        </Task>
      </Sequence>
    </Workflow>
  );
});
