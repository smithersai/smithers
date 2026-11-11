/**
 * Turn env, Helm, Terraform and k8s diffs into a blast-radius and risk summary, then a review verdict.
 *
 * Port of the 0.x `config-diff-explainer.jsx`. A fetcher agent collects the
 * config diffs for a git range and classifies each file by kind and service.
 * An explainer agent rates the blast radius per system and an overall risk
 * level, and a review step turns that into approve, request-changes, or
 * comment against an auto-approve threshold. The steps run in sequence with no
 * branch.
 *
 * 0.x's fetcher was an agent that ran git itself, so the fetch stays an `AgentAction` rather than a deterministic `Action`.
 * 0.x gave `approve` no agent, so it persisted its prompt element as a static output that fails its schema; here it is a model step with no system prompt.
 * 0.x gave the agents `read`, `bash` and `grep` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

const Risk = Schema.Literals(["low", "medium", "high", "critical"])

/** One changed config file. */
export const ConfigFile = Schema.Struct({
  path: Schema.String,
  kind: Schema.Literals(["helm", "terraform", "k8s", "env", "other"]),
  diff: Schema.String,
  service: Schema.String
})

/** The collected diffs. */
export const FetchedDiff = Schema.Struct({
  files: Schema.Array(ConfigFile),
  totalChanges: Schema.Number,
  summary: Schema.String
})

/** The blast-radius analysis. */
export const Explanation = Schema.Struct({
  blastRadius: Schema.Array(Schema.Struct({
    system: Schema.String,
    impact: Schema.String,
    severity: Risk
  })),
  riskLevel: Risk,
  affectedSystems: Schema.Array(Schema.String),
  rollbackNotes: Schema.String,
  summary: Schema.String
})

/** The review verdict. */
export const Review = Schema.Struct({
  action: Schema.Literals(["approve", "request-changes", "comment"]),
  comment: Schema.String,
  summary: Schema.String
})

/** What the flow settles with: the analysis and the verdict on it. */
export const Output = Schema.Struct({ explanation: Explanation, review: Review })

/** Collects and classifies the config diffs. */
export const FetchDiffs = AgentAction.make("examples/ConfigDiffExplainer/FetchDiffs", {
  payload: { paths: Schema.Array(Schema.String), gitRef: Schema.String, filePatterns: Schema.Array(Schema.String) },
  output: FetchedDiff,
  seat,
  system: [
    `You are a config diff fetcher. Given file paths or git refs, collect the
raw diffs for environment files, Helm values, Terraform plans, and Kubernetes manifests.
Classify each file by kind and identify the service it belongs to.`
  ],
  prompt: ({ filePatterns, gitRef, paths }) =>
    `Collect the config diffs for ${gitRef}.\n\nPaths: ${JSON.stringify(paths)}\nFile patterns: ${
      JSON.stringify(filePatterns)
    }`
})

/** Rates the blast radius and overall risk. */
export const Explain = AgentAction.make("examples/ConfigDiffExplainer/Explain", {
  payload: { files: Schema.Array(ConfigFile), totalChanges: Schema.Number, context: Schema.String },
  output: Explanation,
  seat,
  system: [
    `You are a config change analyst. Given collected diffs from infrastructure
config files (Helm, Terraform, k8s manifests, env files), produce a blast-radius analysis.
Identify every affected system, rate each impact's severity, assign an overall risk level,
and note any rollback considerations. Be specific — mention replica counts, resource limits,
timeout changes, feature flags, and network policy shifts.`
  ],
  prompt: ({ context, files, totalChanges }) =>
    `Explain the blast radius of these ${totalChanges} config changes.\n\nContext: ${context}\nFiles: ${
      JSON.stringify(files)
    }`
})

/** Approves, requests changes, or comments. */
export const Approve = AgentAction.make("examples/ConfigDiffExplainer/Approve", {
  payload: {
    riskLevel: Risk,
    affectedSystems: Schema.Array(Schema.String),
    blastRadius: Explanation.fields.blastRadius,
    summary: Schema.String,
    autoApproveThreshold: Schema.String
  },
  output: Review,
  seat,
  prompt: ({ affectedSystems, autoApproveThreshold, blastRadius, riskLevel, summary }) =>
    `Review this config change: approve it, request changes, or comment.\n\nRisk level: ${riskLevel}\nAuto-approve threshold: ${autoApproveThreshold}\nAffected systems: ${
      JSON.stringify(affectedSystems)
    }\nBlast radius: ${JSON.stringify(blastRadius)}\nSummary: ${summary}`
})

/** The flow: fetch, explain, review. */
export const ConfigDiffExplainer = Flow.make("examples/ConfigDiffExplainer", {
  payload: {
    paths: Schema.optional(Schema.Array(Schema.String)),
    gitRef: Schema.optional(Schema.String),
    filePatterns: Schema.optional(Schema.Array(Schema.String)),
    context: Schema.optional(Schema.String),
    autoApproveThreshold: Schema.optional(Schema.String)
  },
  success: Output,
  error: AgentAction.AgentFailure,
  body: ({
    autoApproveThreshold = "low",
    context = "",
    filePatterns = ["values.yaml", "*.tf", "*.env", "*.yaml"],
    gitRef = "HEAD~1..HEAD",
    paths = []
  }) =>
    Node.bindPlanned(
      FetchDiffs.call({ paths, gitRef, filePatterns }),
      (fetched) =>
        Node.bindPlanned(
          Explain.call({ files: fetched.files, totalChanges: fetched.totalChanges, context }),
          (explanation) =>
            Node.bindPlanned(
              Approve.call({
                riskLevel: explanation.riskLevel,
                affectedSystems: explanation.affectedSystems,
                blastRadius: explanation.blastRadius,
                summary: explanation.summary,
                autoApproveThreshold
              }),
              (review) => Node.succeed({ explanation, review })
            )
        )
    )
})

/** Every step the flow calls. */
export const layer = Layer.mergeAll(FetchDiffs.layer, Explain.layer, Approve.layer)
