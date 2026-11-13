/**
 * Detect public API or CLI changes, patch the docs they make stale, and verify the patch beside a follow-up pull request.
 *
 * Port of the 0.x `docs-patcher.jsx`. A drift agent diffs the branch against
 * its base, lists each changed API, CLI, SDK or config surface, and names the
 * docs that still show the old one. One patch agent rewrites those docs. Then
 * two steps run side by side on the patch: a verifier agent checks it, and a
 * pull-request step opens the follow-up PR. The PR does not wait for the
 * verdict, as in 0.x; the flow returns both.
 *
 * `DriftDetector` does not fit: 0.x diffs against a base branch rather than a remembered baseline, and patches even when nothing drifted.
 * 0.x's prompts were placeholders that printed their props; these are minimal prompts over the same props.
 * 0.x's PR agent ran `git` and `gh`; here that is the deterministic `CreatePullRequest` action a host implements.
 * 0.x gave the agents `bash`, `read`, `write` and `grep` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import type * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

const Severity = Schema.Literals(["breaking", "notable", "minor"])

/** One public surface that changed between the base and the branch. */
export const SurfaceChange = Schema.Struct({
  kind: Schema.Literals(["api", "cli", "sdk", "config"]),
  name: Schema.String,
  before: Schema.String,
  after: Schema.String,
  file: Schema.String
})

/** One doc that still shows an old surface. */
export const AffectedDoc = Schema.Struct({
  path: Schema.String,
  reason: Schema.String,
  staleSnippets: Schema.Array(Schema.String)
})

/** The drift agent's answer. */
export const Drift = Schema.Struct({
  changes: Schema.Array(SurfaceChange),
  affectedDocs: Schema.Array(AffectedDoc),
  severity: Severity,
  summary: Schema.String
})

/** The patch agent's answer: each doc's rewritten hunks. */
export const Patch = Schema.Struct({
  patches: Schema.Array(Schema.Struct({
    docPath: Schema.String,
    hunks: Schema.Array(Schema.Struct({ before: Schema.String, after: Schema.String }))
  })),
  filesChanged: Schema.Array(Schema.String),
  summary: Schema.String
})

/** The verifier's verdict on the patch. */
export const Verification = Schema.Struct({
  allValid: Schema.Boolean,
  results: Schema.Array(Schema.Struct({
    docPath: Schema.String,
    valid: Schema.Boolean,
    issues: Schema.Array(Schema.String)
  })),
  brokenLinks: Schema.Array(Schema.String),
  staleReferences: Schema.Array(Schema.String)
})

/** The follow-up pull request a host is asked to open, with 0.x's PR props. */
export const PullRequestRequest = Schema.Struct({
  filesChanged: Schema.Array(Schema.String),
  summary: Schema.String,
  severity: Severity,
  repo: Schema.NullOr(Schema.String),
  dryRun: Schema.Boolean
})

/** The pull request the host opened, or the checklist it would have opened on a dry run. */
export const PullRequest = Schema.Struct({
  prNumber: Schema.optional(Schema.Number),
  prUrl: Schema.optional(Schema.String),
  branch: Schema.String,
  title: Schema.String,
  checklist: Schema.Array(Schema.String),
  created: Schema.Boolean,
  summary: Schema.String
})

/** What the flow settles with: every 0.x output. */
export const Output = Schema.Struct({
  drift: Drift,
  patch: Patch,
  verification: Verification,
  pullRequest: PullRequest
})

/** Finds public surface changes and the docs they make stale. */
export const DetectDrift = AgentAction.make("examples/DocsPatcher/DetectDrift", {
  payload: { baseBranch: Schema.String, docGlobs: Schema.Array(Schema.String), scope: Schema.String },
  output: Drift,
  seat,
  system: [
    `You detect public API and CLI surface changes. Diff the current branch
against the base, identify renamed flags, changed endpoints, altered SDK signatures,
and modified config shapes. For each change, find every doc file that references the
old surface and flag it as stale.`
  ],
  prompt: ({ baseBranch, docGlobs, scope }) =>
    `Detect public surface drift.\n\nBase branch: ${baseBranch}\nDoc globs: ${docGlobs.join(", ")}\nScope: ${scope}`
})

/** Rewrites the stale snippets in every affected doc. */
export const PatchDocs = AgentAction.make("examples/DocsPatcher/PatchDocs", {
  payload: { changes: Schema.Array(SurfaceChange), affectedDocs: Schema.Array(AffectedDoc), severity: Severity },
  output: Patch,
  seat,
  system: [
    `You patch documentation files to reflect API/CLI changes. For each
affected doc, locate stale snippets and rewrite them to match the new surface. Preserve
surrounding prose, formatting, and frontmatter. Never invent features that do not exist
in the diff — only update what actually changed.`
  ],
  prompt: ({ affectedDocs, changes, severity }) =>
    `Patch the docs for these ${severity} surface changes.\n\nChanges: ${JSON.stringify(changes)}\nAffected docs: ${
      JSON.stringify(affectedDocs)
    }`
})

/** Checks the patched docs against the new surface. */
export const VerifyPatch = AgentAction.make("examples/DocsPatcher/Verify", {
  payload: { patches: Patch.fields.patches, filesChanged: Schema.Array(Schema.String), baseBranch: Schema.String },
  output: Verification,
  seat,
  system: [
    `You verify patched docs for correctness. Check that every updated snippet
matches the actual new API surface. Look for broken internal links, stale cross-references,
and inconsistencies between code examples and the real implementation. Report any issues.`
  ],
  prompt: ({ baseBranch, filesChanged, patches }) =>
    `Verify the patched docs against base ${baseBranch}.\n\nFiles changed: ${filesChanged.join(", ")}\nPatches: ${
      JSON.stringify(patches)
    }`
})

/**
 * Opens the follow-up pull request. Deterministic: a host implements it with
 * `git` and `gh`. Irreversible with no idempotency key, so the engine runs it
 * at most once rather than open a second pull request on a retry.
 */
export const CreatePullRequest = Action.make("examples/DocsPatcher/CreatePullRequest", {
  payload: PullRequestRequest,
  success: PullRequest,
  tier: "irreversible"
})

/** The flow: detect, patch, then verify and open the follow-up pull request side by side. */
export const DocsPatcher = Flow.make("examples/DocsPatcher", {
  description:
    "Detect public API or CLI changes, patch the docs they make stale, and verify the patch beside a follow-up pull request.",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: {
    baseBranch: Schema.optional(Schema.String),
    docGlobs: Schema.optional(Schema.Array(Schema.String)),
    scope: Schema.optional(Schema.String),
    repo: Schema.optional(Schema.String),
    dryRun: Schema.optional(Schema.Boolean)
  },
  success: Output,
  error: AgentAction.AgentFailure,
  body: Node.capture(
    {},
    ({ baseBranch = "main", docGlobs = ["docs/**/*.mdx", "README.md"], dryRun = false, repo, scope = "all" }) => {
      const run = { baseBranch, repo: repo ?? null, dryRun }
      return Node.bindPlanned(
        DetectDrift.call({ baseBranch, docGlobs, scope }),
        Node.capture(run, (drift: Planned.Planned<typeof Drift.Type>) =>
          Node.bindPlanned(
            PatchDocs.call({ changes: drift.changes, affectedDocs: drift.affectedDocs, severity: drift.severity }),
            Node.capture(run, (patch: Planned.Planned<typeof Patch.Type>) =>
              Node.bindPlanned(
                Node.all({
                  verification: VerifyPatch.call({
                    patches: patch.patches,
                    filesChanged: patch.filesChanged,
                    baseBranch
                  }),
                  pullRequest: CreatePullRequest.call({
                    filesChanged: patch.filesChanged,
                    summary: patch.summary,
                    severity: drift.severity,
                    repo: repo ?? null,
                    dryRun
                  })
                }),
                Node.capture(
                  {},
                  (done) =>
                    Node.succeed({ drift, patch, verification: done.verification, pullRequest: done.pullRequest })
                )
              ))
          ))
      )
    }
  )
})

/** What a host supplies for the step that leaves the model. */
export interface Host {
  readonly createPullRequest: (
    request: typeof PullRequestRequest.Type
  ) => Effect.Effect<typeof PullRequest.Type>
}

/** Every step the flow calls, with the host's pull-request step. */
export const layer = (host: Host) =>
  Layer.mergeAll(
    DetectDrift.layer,
    PatchDocs.layer,
    VerifyPatch.layer,
    CreatePullRequest.toLayer(host.createPullRequest)
  )
