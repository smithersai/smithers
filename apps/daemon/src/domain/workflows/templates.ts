export const defaultWorkflowTemplates = [
  {
    id: "issue-to-pr",
    source: `import { ClaudeCodeAgent, CodexAgent, createSmithers, Ralph, Sequence } from "smithers-orchestrator"
import { z } from "zod"

const { Workflow, Task, smithers, outputs } = createSmithers({
  plan: z.object({
    summary: z.string(),
    acceptanceCriteria: z.array(z.string()),
    risks: z.array(z.string()),
  }),
  implement: z.object({
    summary: z.string(),
    filesChanged: z.array(z.string()),
    testsRun: z.array(z.string()),
  }),
  validate: z.object({
    allPassed: z.boolean(),
    summary: z.string(),
    failingChecks: z.array(z.string()),
  }),
  review: z.object({
    approved: z.boolean(),
    summary: z.string(),
    findings: z.array(z.string()),
  }),
  summarize: z.object({
    summary: z.string(),
    nextSteps: z.array(z.string()),
  }),
})

const SHARED_SYSTEM_PROMPT =
  "You are working inside a real repository. Keep output concise, preserve stable task IDs, and return only data that matches the requested schema."

const plannerAgent = new ClaudeCodeAgent({
  model: "claude-sonnet-4-5-20250929",
  permissionMode: "bypassPermissions",
  timeoutMs: 10 * 60 * 1000,
  systemPrompt: SHARED_SYSTEM_PROMPT,
})

const implementationAgent = new CodexAgent({
  model: "gpt-5.3-codex",
  sandbox: "workspace-write",
  fullAuto: true,
  timeoutMs: 20 * 60 * 1000,
  config: { model_reasoning_effort: "high" },
  systemPrompt: SHARED_SYSTEM_PROMPT,
})

const reviewAgent = new ClaudeCodeAgent({
  model: "claude-opus-4-6",
  permissionMode: "bypassPermissions",
  timeoutMs: 10 * 60 * 1000,
  systemPrompt: SHARED_SYSTEM_PROMPT,
})

export default smithers((ctx) => {
  const latestValidation = ctx.outputMaybe("validate", { nodeId: "validate" })
  const latestReview = ctx.outputMaybe("review", { nodeId: "review" })
  const latestPlan = ctx.outputMaybe("plan", { nodeId: "plan" })
  const isApproved = Boolean(latestValidation?.allPassed && latestReview?.approved)

  return (
    <Workflow name="issue-to-pr">
      <Sequence>
        <Task
          id="plan"
          output={outputs.plan}
          agent={plannerAgent}
          timeoutMs={10 * 60 * 1000}
          retries={1}
        >
          {[
            "Create an implementation plan for this issue.",
            "",
            "Issue title: " + String(ctx.input?.issueTitle ?? "Untitled issue"),
            "Issue description:",
            String(ctx.input?.issueDescription ?? "No issue description provided."),
            "",
            "Additional context:",
            String(ctx.input?.context ?? "No additional context provided."),
            "",
            "Return only JSON that matches the plan schema.",
          ].join("\\n")}
        </Task>

        <Ralph id="implement-review-loop" until={isApproved} maxIterations={3} onMaxReached="return-last">
          <Sequence>
            <Task
              id="implement"
              output={outputs.implement}
              agent={implementationAgent}
              timeoutMs={20 * 60 * 1000}
            >
              {[
                "Implement the approved plan.",
                "",
                "Acceptance criteria:",
                JSON.stringify(latestPlan?.acceptanceCriteria ?? [], null, 2),
                "",
                "Known risks to account for:",
                JSON.stringify(latestPlan?.risks ?? [], null, 2),
                "",
                "Prior validation failures:",
                JSON.stringify(latestValidation?.failingChecks ?? [], null, 2),
                "",
                "Prior review findings:",
                JSON.stringify(latestReview?.findings ?? [], null, 2),
                "",
                "Return only JSON that matches the implement schema.",
              ].join("\\n")}
            </Task>

            <Task
              id="validate"
              output={outputs.validate}
              agent={implementationAgent}
              timeoutMs={10 * 60 * 1000}
              retries={1}
            >
              {"Run the relevant validation for the latest implementation, summarize the result, and return only JSON that matches the validate schema."}
            </Task>

            <Task
              id="review"
              output={outputs.review}
              agent={reviewAgent}
              timeoutMs={10 * 60 * 1000}
              skipIf={!latestValidation?.allPassed}
            >
              {"Review the latest implementation only if validation passed. Focus on correctness, regressions, and missing tests. Return only JSON that matches the review schema."}
            </Task>
          </Sequence>
        </Ralph>

        <Task id="summarize" output={outputs.summarize}>
          {{
            summary: isApproved
              ? "Issue implementation completed and approved."
              : "Issue implementation finished without full approval.",
            nextSteps: isApproved
              ? ["Open the pull request", "Share validation evidence"]
              : ["Inspect the latest validation and review findings", "Run another iteration if needed"],
          }}
        </Task>
      </Sequence>
    </Workflow>
  )
})`,
  },
  {
    id: "pr-feedback",
    source: `import { ClaudeCodeAgent, CodexAgent, createSmithers, Ralph, Sequence } from "smithers-orchestrator"
import { z } from "zod"

const { Workflow, Task, smithers, outputs } = createSmithers({
  analyzeFeedback: z.object({
    summary: z.string(),
    requestedChanges: z.array(z.string()),
    riskyAreas: z.array(z.string()),
  }),
  implementFixes: z.object({
    summary: z.string(),
    filesChanged: z.array(z.string()),
    addressedComments: z.array(z.string()),
  }),
  validateFixes: z.object({
    allPassed: z.boolean(),
    summary: z.string(),
    checksRun: z.array(z.string()),
    failingChecks: z.array(z.string()),
  }),
  reviewFixes: z.object({
    approved: z.boolean(),
    summary: z.string(),
    findings: z.array(z.string()),
  }),
  summarize: z.object({
    summary: z.string(),
    followUps: z.array(z.string()),
  }),
})

const SHARED_SYSTEM_PROMPT =
  "You are updating a pull request in response to review feedback. Preserve intent, avoid unrelated changes, and return only schema-matching JSON."

const analysisAgent = new ClaudeCodeAgent({
  model: "claude-opus-4-6",
  permissionMode: "bypassPermissions",
  timeoutMs: 10 * 60 * 1000,
  systemPrompt: SHARED_SYSTEM_PROMPT,
})

const implementationAgent = new CodexAgent({
  model: "gpt-5.3-codex",
  sandbox: "workspace-write",
  fullAuto: true,
  timeoutMs: 20 * 60 * 1000,
  config: { model_reasoning_effort: "high" },
  systemPrompt: SHARED_SYSTEM_PROMPT,
})

export default smithers((ctx) => {
  const analyzedFeedback = ctx.outputMaybe("analyzeFeedback", { nodeId: "analyze-feedback" })
  const validationResult = ctx.outputMaybe("validateFixes", { nodeId: "validate-fixes" })
  const reviewResult = ctx.outputMaybe("reviewFixes", { nodeId: "review-fixes" })
  const fixesApproved = Boolean(validationResult?.allPassed && reviewResult?.approved)

  return (
    <Workflow name="pr-feedback">
      <Sequence>
        <Task
          id="analyze-feedback"
          output={outputs.analyzeFeedback}
          agent={analysisAgent}
          timeoutMs={10 * 60 * 1000}
        >
          {[
            "Analyze the pull request feedback and extract the concrete requested changes.",
            "",
            "PR summary:",
            String(ctx.input?.pullRequestSummary ?? "No PR summary provided."),
            "",
            "Feedback:",
            String(ctx.input?.feedback ?? "No feedback provided."),
            "",
            "Return only JSON that matches the analyzeFeedback schema.",
          ].join("\\n")}
        </Task>

        <Ralph id="feedback-fix-loop" until={fixesApproved} maxIterations={3} onMaxReached="return-last">
          <Sequence>
            <Task
              id="implement-fixes"
              output={outputs.implementFixes}
              agent={implementationAgent}
              timeoutMs={20 * 60 * 1000}
            >
              {[
                "Implement the requested pull request changes.",
                "",
                "Requested changes:",
                JSON.stringify(analyzedFeedback?.requestedChanges ?? [], null, 2),
                "",
                "Risky areas to double-check:",
                JSON.stringify(analyzedFeedback?.riskyAreas ?? [], null, 2),
                "",
                "Prior validation failures:",
                JSON.stringify(validationResult?.failingChecks ?? [], null, 2),
                "",
                "Prior review findings:",
                JSON.stringify(reviewResult?.findings ?? [], null, 2),
                "",
                "Return only JSON that matches the implementFixes schema.",
              ].join("\\n")}
            </Task>

            <Task
              id="validate-fixes"
              output={outputs.validateFixes}
              agent={implementationAgent}
              timeoutMs={10 * 60 * 1000}
              retries={1}
            >
              {[
                "Run the relevant validation for the latest pull request fixes.",
                "",
                "Addressed comments so far:",
                JSON.stringify(
                  ctx.outputMaybe("implementFixes", { nodeId: "implement-fixes" })?.addressedComments ?? [],
                  null,
                  2
                ),
                "",
                "Return only JSON that matches the validateFixes schema.",
              ].join("\\n")}
            </Task>

            <Task
              id="review-fixes"
              output={outputs.reviewFixes}
              agent={analysisAgent}
              timeoutMs={10 * 60 * 1000}
              skipIf={!validationResult?.allPassed}
            >
              {"Review the latest pull request changes only if validation passed. Focus on correctness, regressions, and any feedback that is still unaddressed. Return only JSON that matches the reviewFixes schema."}
            </Task>
          </Sequence>
        </Ralph>

        <Task id="summarize" output={outputs.summarize}>
          {{
            summary: fixesApproved
              ? "Feedback addressed, validation passed, and review approved."
              : "Feedback processing finished without full validation and review approval.",
            followUps: fixesApproved
              ? ["Reply to reviewers with the validation summary", "Request re-review"]
              : [
                  "Inspect the latest validation failures and review findings",
                  "Run another fix iteration before requesting review again",
                ],
          }}
        </Task>
      </Sequence>
    </Workflow>
  )
})`,
  },
  {
    id: "approval-gate",
    source: `import { ClaudeCodeAgent, CodexAgent, createSmithers, Sequence } from "smithers-orchestrator"
import { z } from "zod"

const { Workflow, Task, smithers, outputs } = createSmithers({
  prepareRelease: z.object({
    summary: z.string(),
    rolloutPlan: z.array(z.string()),
    risks: z.array(z.string()),
    rollbackPlan: z.array(z.string()),
  }),
  runPreflight: z.object({
    ready: z.boolean(),
    summary: z.string(),
    checksRun: z.array(z.string()),
    blockers: z.array(z.string()),
    evidence: z.array(z.string()),
  }),
  deploy: z.object({
    summary: z.string(),
    deployedAt: z.string(),
    followUps: z.array(z.string()),
  }),
  summarize: z.object({
    summary: z.string(),
    nextSteps: z.array(z.string()),
  }),
})

const SHARED_SYSTEM_PROMPT =
  "You are preparing a production deployment. Be explicit about evidence, risks, and rollback expectations, and return only schema-matching JSON."

const releaseAgent = new ClaudeCodeAgent({
  model: "claude-sonnet-4-5-20250929",
  permissionMode: "bypassPermissions",
  timeoutMs: 10 * 60 * 1000,
  systemPrompt: SHARED_SYSTEM_PROMPT,
})

const deployAgent = new CodexAgent({
  model: "gpt-5.3-codex",
  sandbox: "workspace-write",
  fullAuto: true,
  timeoutMs: 20 * 60 * 1000,
  config: { model_reasoning_effort: "high" },
  systemPrompt: SHARED_SYSTEM_PROMPT,
})

export default smithers((ctx) => {
  const releasePreparation = ctx.outputMaybe("prepareRelease", { nodeId: "prepare-release" })
  const preflight = ctx.outputMaybe("runPreflight", { nodeId: "run-preflight" })
  const deployment = ctx.outputMaybe("deploy", { nodeId: "deploy" })

  return (
    <Workflow name="approval-gate">
      <Sequence>
        <Task
          id="prepare-release"
          output={outputs.prepareRelease}
          agent={releaseAgent}
          timeoutMs={10 * 60 * 1000}
        >
          {[
            "Prepare a deployment plan for this release.",
            "",
            "Release summary:",
            String(ctx.input?.releaseSummary ?? "No release summary provided."),
            "",
            "Environment:",
            String(ctx.input?.environment ?? "production"),
            "",
            "Release notes:",
            String(ctx.input?.releaseNotes ?? "No release notes provided."),
            "",
            "Return only JSON that matches the prepareRelease schema.",
          ].join("\\n")}
        </Task>

        <Task
          id="run-preflight"
          output={outputs.runPreflight}
          agent={deployAgent}
          timeoutMs={10 * 60 * 1000}
          retries={1}
        >
          {[
            "Run preflight validation for the pending release.",
            "",
            "Rollout plan:",
            JSON.stringify(releasePreparation?.rolloutPlan ?? [], null, 2),
            "",
            "Risks:",
            JSON.stringify(releasePreparation?.risks ?? [], null, 2),
            "",
            "Return only JSON that matches the runPreflight schema.",
          ].join("\\n")}
        </Task>

        <Task
          id="deploy"
          output={outputs.deploy}
          agent={deployAgent}
          timeoutMs={20 * 60 * 1000}
          needsApproval
          label="Approve production deployment"
          skipIf={!preflight?.ready}
        >
          {[
            "Deploy only after explicit approval.",
            "",
            "Release preparation:",
            String(releasePreparation?.summary ?? "No preparation summary available."),
            "",
            "Rollback plan:",
            JSON.stringify(releasePreparation?.rollbackPlan ?? [], null, 2),
            "",
            "Preflight summary:",
            String(preflight?.summary ?? "Preflight did not complete."),
            "",
            "Preflight evidence:",
            JSON.stringify(preflight?.evidence ?? [], null, 2),
            "",
            "Return only JSON that matches the deploy schema.",
          ].join("\\n")}
        </Task>

        <Task id="summarize" output={outputs.summarize}>
          {[
            "Summarize the deployment outcome and next steps.",
            "",
            "Release summary:",
            String(releasePreparation?.summary ?? "No release preparation summary available."),
            "",
            "Preflight blockers:",
            JSON.stringify(preflight?.blockers ?? [], null, 2),
            "",
            "Deployment summary:",
            String(deployment?.summary ?? "Deployment did not run."),
            "",
            "Return only JSON that matches the summarize schema.",
          ].join("\\n")}
        </Task>
      </Sequence>
    </Workflow>
  )
})`,
  },
] as const
