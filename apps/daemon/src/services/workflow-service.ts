import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"

import type {
  AgentCli,
  Workflow,
  WorkflowAuthoringStage,
  WorkflowDocument,
  WorkflowLaunchFieldsResponse,
} from "@burns/shared"

import type { AgentCliEvent } from "@/agents/BaseCliAgent"
import { defaultWorkflowTemplates } from "@/domain/workflows/templates"
import { listInstalledAgentClis, runWorkflowGenerationAgent } from "@/services/agent-cli-service"
import { ensureWorkspaceSmithersLayout } from "@/services/workspace-layout"
import { getWorkspace } from "@/services/workspace-service"
import { HttpError } from "@/utils/http-error"
import { slugify } from "@/utils/slugify"

const workflowPromptScaffold = `import { ClaudeCodeAgent, CodexAgent, createSmithers, Ralph, Sequence } from "smithers-orchestrator"
import { z } from "zod"

const { Workflow, Task, smithers, outputs } = createSmithers({
  plan: z.object({
    summary: z.string(),
    acceptanceCriteria: z.array(z.string()),
  }),
  implement: z.object({
    summary: z.string(),
    filesChanged: z.array(z.string()),
  }),
  validate: z.object({
    allPassed: z.boolean(),
    summary: z.string(),
  }),
  review: z.object({
    approved: z.boolean(),
    findings: z.array(z.string()),
  }),
})

const SHARED_SYSTEM_PROMPT =
  "You are working inside a real repository. Preserve stable task IDs, keep the workflow coherent, and return only schema-matching JSON."

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

export default smithers((ctx) => (
  <Workflow name="example-workflow">
    <Sequence>
      <Task id="plan" output={outputs.plan} agent={plannerAgent} timeoutMs={10 * 60 * 1000} retries={1}>
        {[
          "Create a plan for: " + String(ctx.input?.request ?? "the requested change") + ".",
          "",
          "Return only JSON that matches the plan schema.",
        ].join("\\n")}
      </Task>
      <Ralph id="implement-review-loop" until={Boolean(ctx.outputMaybe("review", { nodeId: "review" })?.approved)} maxIterations={3} onMaxReached="return-last">
        <Sequence>
          <Task id="implement" output={outputs.implement} agent={implementationAgent} timeoutMs={20 * 60 * 1000}>
            {[
              "Implement the plan.",
              "",
              "Acceptance criteria:",
              JSON.stringify(ctx.outputMaybe("plan", { nodeId: "plan" })?.acceptanceCriteria ?? [], null, 2),
              "",
              "Return only JSON that matches the implement schema.",
            ].join("\\n")}
          </Task>
          <Task id="validate" output={outputs.validate} agent={implementationAgent} timeoutMs={10 * 60 * 1000} retries={1}>
            {"Run the relevant validation for the latest implementation and return only JSON that matches the validate schema."}
          </Task>
          <Task id="review" output={outputs.review} agent={reviewAgent} timeoutMs={10 * 60 * 1000} skipIf={!ctx.outputMaybe("validate", { nodeId: "validate" })?.allPassed}>
            {"Review the latest implementation only when validation passed. Return only JSON that matches the review schema."}
          </Task>
        </Sequence>
      </Ralph>
    </Sequence>
  </Workflow>
))`

const smithersGuideLinks = [
  "https://smithers.sh/guides/tutorial-workflow",
  "https://smithers.sh/guides/patterns",
  "https://smithers.sh/guides/project-structure",
  "https://smithers.sh/guides/best-practices",
  "https://smithers.sh/guides/model-selection",
  "https://smithers.sh/guides/review-loop",
  "https://smithers.sh/guides/mdx-prompts",
  "https://smithers.sh/guides/structured-output",
  "https://smithers.sh/guides/error-handling",
]

const smithersGuideDigest = [
  "Smithers authoring guidance (apply when relevant):",
  "- Tutorial workflow: start from a clear entry task that reads ctx.input and then sequence downstream steps.",
  "- Patterns: use Sequence/Parallel/Branch/Ralph intentionally; choose deterministic node IDs and explicit control flow.",
  "- Project structure: for Burns, keep the primary workflow in the requested target file unless the user explicitly asks for a multi-file component split.",
  "- Best practices: keep prompts task-specific, preserve stable task IDs, keep tasks composable, and avoid hidden side effects.",
  "- Prefer explicit reusable agent definitions and shared prompt constants near the top of the file instead of inline ad-hoc agent setup.",
  "- Model selection: use stronger models for planning/review-heavy tasks and faster models for straightforward transform tasks.",
  "- Review loop: when quality gates are requested, model them with bounded Ralph loops and explicit stop conditions.",
  "- MDX prompts: only use MDX prompt files when the user asks for prompt externalization or workflow complexity justifies it.",
  "- Structured output: define clear schemas and keep Task output wired through outputs.<schemaKey> consistently.",
  "- Error handling: prefer explicit retries/timeouts/branches and graceful failure paths over silent failures.",
  "Guide references:",
  ...smithersGuideLinks.map((link) => `- ${link}`),
].join("\n")

const smithersSyntaxReference = [
  "Smithers syntax quick reference:",
  "- Core setup: import { createSmithers, Sequence, Parallel, Branch, Ralph } from \"smithers-orchestrator\" and define schemas in createSmithers({...}).",
  "- Workflow skeleton: export default smithers((ctx) => (<Workflow name=\"...\">...</Workflow>)).",
  "- Agent setup: define reusable agents once (for example planner/reviewer/implementer) and then reference them from tasks.",
  "- Task contract: every <Task> must have a stable id and output wired as output={outputs.<schemaKey>}.",
  "- Launch inputs: read user-provided run input via ctx.input.<field>; if optional, use nullish defaults (ctx.input.<field> ?? <default>).",
  "- Cross-task references: use ctx.output(\"schemaKey\", { nodeId: \"task-id\" }) for required upstream output and ctx.outputMaybe(...) for optional flow.",
  "- Stateful/table patterns: use ctx.latest(...)/ctx.latestArray(...) only when stateful table-driven workflows are intentionally required.",
  "- Control flow primitives:",
  "  - <Sequence>: strict ordered execution.",
  "  - <Parallel>: independent concurrent branches.",
  "  - <Branch if={condition} then={<TaskOrSubtree />} else={<TaskOrSubtree />} /> for explicit branching.",
  "  - <Ralph until={condition} maxIterations={n}>...</Ralph> for bounded review/fix loops.",
  "- Error handling primitives: retries, timeoutMs, skipIf, continueOnFail, explicit Branch-based recovery paths.",
].join("\n")

const smithersFeatureImplementationFlowExample = [
  "Feature implementation flow example (adapt when relevant):",
  "```tsx",
  "const { Workflow, Task, smithers, outputs } = createSmithers({",
  "  plan: z.object({ summary: z.string(), steps: z.array(z.string()) }),",
  "  implement: z.object({ summary: z.string(), filesChanged: z.array(z.string()) }),",
  "  validate: z.object({ passed: z.boolean(), notes: z.array(z.string()) }),",
  "  review: z.object({ approved: z.boolean(), feedback: z.string().optional() }),",
  "})",
  "",
  "const implementationAgent = new CodexAgent({ model: \"gpt-5.3-codex\", sandbox: \"workspace-write\", fullAuto: true })",
  "const reviewAgent = new ClaudeCodeAgent({ model: \"claude-opus-4-6\", permissionMode: \"bypassPermissions\" })",
  "",
  "export default smithers((ctx) => (",
  "  <Workflow name=\"feature-flow\">",
  "    <Sequence>",
  "      <Task id=\"plan\" output={outputs.plan}>",
  "        {{ summary: `Plan for ${ctx.input.feature}`, steps: [\"analyze\", \"implement\", \"test\"] }}",
  "      </Task>",
  "      <Task id=\"implement\" output={outputs.implement} agent={implementationAgent}>",
  "        {{ summary: \"Implemented feature\", filesChanged: [\"src/feature.ts\"] }}",
  "      </Task>",
  "      <Task id=\"validate\" output={outputs.validate} agent={implementationAgent}>",
  "        {{ passed: true, notes: [\"typecheck passed\", \"tests passed\"] }}",
  "      </Task>",
  "      <Task id=\"review\" output={outputs.review} agent={reviewAgent} skipIf={!ctx.output(\"validate\", { nodeId: \"validate\" }).passed}>",
  "        {{ approved: true, feedback: \"\", }}",
  "      </Task>",
  "    </Sequence>",
  "  </Workflow>",
  "))",
  "```",
].join("\n")

const smithersCliAgentModelGuide = [
  "Model and agent selection guidance (explicit):",
  "Choosing the right model for each task has a significant impact on workflow quality and cost.",
  "",
  "Recommended models:",
  "- Codex (gpt-5.3-codex) — Implementation: implementing features, fixing bugs, running/interpreting tests, refactors, and fixing review issues.",
  "- Codex reasoning effort: high by default; use xhigh for especially complex architectural/multi-file dependency-heavy changes.",
  "- Claude Opus (claude-opus-4-6) — Planning and Review: codebase research, implementation planning, code review, report generation, orchestration logic/tool calling.",
  "- Claude Sonnet (claude-sonnet-4-5-20250929) — Simple Tasks: lightweight tool calls, cheap/fast reviews, straightforward report aggregation.",
  "",
  "Summary table (task -> model):",
  "- Implementing code -> Codex",
  "- Reviewing code -> Claude Opus + Codex in parallel",
  "- Research and planning -> Claude Opus",
  "- Running tests / validation -> Codex",
  "- Simple tool calls -> Claude Sonnet",
  "- Report generation -> Claude Sonnet or Claude Opus (based on complexity)",
  "- Ticket discovery -> Codex or Claude Opus",
  "",
  "CLI Agents vs AI SDK Agents:",
  "- Prefer CLI agents (subscription-backed binaries) when you need native tool ecosystems (file editing, shell access, local project operations).",
  "- AI SDK agents are appropriate when you explicitly need provider/API-level orchestration in application runtime code.",
  "",
  "CLI agent examples:",
  "```ts",
  "import { ClaudeCodeAgent, CodexAgent, KimiAgent } from \"smithers-orchestrator\"",
  "",
  "const claude = new ClaudeCodeAgent({",
  "  model: \"claude-opus-4-6\",",
  "  systemPrompt: SYSTEM_PROMPT,",
  "  dangerouslySkipPermissions: true,",
  "  timeoutMs: 30 * 60 * 1000,",
  "})",
  "",
  "const codex = new CodexAgent({",
  "  model: \"gpt-5.3-codex\",",
  "  systemPrompt: SYSTEM_PROMPT,",
  "  yolo: true,",
  "  config: { model_reasoning_effort: \"high\" },",
  "  timeoutMs: 30 * 60 * 1000,",
  "})",
  "",
  "const kimi = new KimiAgent({",
  "  model: \"kimi-latest\",",
  "  systemPrompt: SYSTEM_PROMPT,",
  "  thinking: true,",
  "  timeoutMs: 30 * 60 * 1000,",
  "})",
  "```",
  "",
  "Dual-agent pattern recommendation:",
  "- For high-signal review workflows, run Opus and Codex reviewers in parallel and merge findings in a dedicated summarize task.",
].join("\n")

function buildAvailableAgentCliDigest(params: {
  selectedAgentId: string
  availableAgentClis: AgentCli[]
}) {
  const availableLines =
    params.availableAgentClis.length === 0
      ? ["- none detected in PATH"]
      : params.availableAgentClis.map(
          (agent) => `- ${agent.id} | ${agent.name} | command: ${agent.command}`
        )

  return [
    `Selected authoring CLI agent for this run: ${params.selectedAgentId}`,
    "Installed CLI agents currently available on this machine:",
    ...availableLines,
    "When selecting or describing agents in workflow code/prompts, only reference this available set unless the user explicitly requests otherwise.",
  ].join("\n")
}

const defaultTemplateById = new Map<string, string>(
  defaultWorkflowTemplates.map((template) => [template.id, template.source])
)

const MAX_WORKFLOW_AUTHORING_ATTEMPTS = 2

type WorkflowAuthoringProgressEvent = {
  stage: WorkflowAuthoringStage
  message: string
  attempt?: number
  totalAttempts?: number
}

type WorkflowAuthoringProgressHandler = (event: WorkflowAuthoringProgressEvent) => void
type WorkflowAuthoringOutputHandler = (event: { stream: "stdout" | "stderr"; chunk: string }) => void
type WorkflowAuthoringAgentEventHandler = (event: AgentCliEvent) => void

function getWorkflowRoot(workspaceId: string) {
  const workspace = getWorkspace(workspaceId)

  if (!workspace) {
    throw new HttpError(404, `Workspace not found: ${workspaceId}`)
  }

  return ensureWorkspaceSmithersLayout(workspace.path).workflowRoot
}

function inferWorkflowStatus(workflowId: string): Workflow["status"] {
  if (workflowId === "pr-feedback") {
    return "hot"
  }

  if (workflowId === "approval-gate") {
    return "draft"
  }

  return "active"
}

function stripCodeFences(source: string) {
  const fencedMatch = source.match(/```(?:tsx|ts|typescript)?\n([\s\S]*?)```/i)
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim()
  }

  return source.trim()
}

function isLegacyBareSmithersSource(source: string) {
  return (
    /export\s+default\s+smithers\s*\(/.test(source) &&
    !/createSmithers/.test(source)
  )
}

function assertWorkflowSourceIsValid(source: string) {
  if (!source.trim()) {
    throw new HttpError(400, "Workflow source cannot be empty")
  }

  if (!/from\s+["']smithers-orchestrator["']/.test(source)) {
    throw new HttpError(400, "Workflow must import from smithers-orchestrator")
  }

  if (!/createSmithers/.test(source)) {
    throw new HttpError(
      400,
      "Workflow must define smithers via createSmithers(...) before export default"
    )
  }

  if (!/export\s+default\s+smithers\s*\(/.test(source)) {
    throw new HttpError(400, "Workflow must default export smithers((ctx) => (...))")
  }

  if (!/<Workflow\b/.test(source) || !/<Task\b/.test(source)) {
    throw new HttpError(400, "Workflow must contain <Workflow> and at least one <Task>")
  }

  if (!/output\s*=\s*{outputs\.[a-zA-Z0-9_]+}/.test(source)) {
    throw new HttpError(400, "Each task output should use output={outputs.<schemaKey>}")
  }

  if (/output\s*=\s*["'][^"']+["']/.test(source)) {
    throw new HttpError(
      400,
      "String task outputs are not valid. Use output={outputs.<schemaKey>} from createSmithers."
    )
  }
}

function normalizeAndValidateWorkflowSource(source: string) {
  const normalizedSource = `${stripCodeFences(source)}\n`
  assertWorkflowSourceIsValid(normalizedSource)
  return normalizedSource
}

export function buildWorkflowGenerationPrompt(params: {
  workflowName: string
  workflowId: string
  userPrompt: string
  workspacePath: string
  selectedAgentId: string
  availableAgentClis: AgentCli[]
}) {
  return [
    "You are authoring a Smithers workflow for Burns inside a real workspace.",
    "Use your file editing tools to create or overwrite the target workflow file.",
    "Do NOT return the workflow source in chat unless absolutely necessary.",
    "Your primary task is to write the file on disk.",
    "After writing the file, respond with a short success confirmation only.",
    "Use stable kebab-case task IDs.",
    `Workflow display name: ${params.workflowName}`,
    `Workflow folder id: ${params.workflowId}`,
    `Target relative file: .smithers/workflows/${params.workflowId}/workflow.tsx`,
    `Workspace path: ${params.workspacePath}`,
    "The file must contain a default export that defines a valid Smithers workflow in TypeScript/TSX.",
    "Prefer a simple but production-leaning structure with clear plan/implement/validate style tasks when relevant.",
    "If the user asks for approval steps, use needsApproval on the relevant task.",
    "Do not use a bare global smithers symbol. Always define it from createSmithers(...).",
    "Always import createSmithers from smithers-orchestrator and z from zod.",
    "Always define output schemas and reference outputs with output={outputs.<schemaKey>}.",
    "Define reusable agents and any shared prompt constants near the top of the file when agent-driven tasks are involved.",
    "Create any missing folders needed for the target file.",
    buildAvailableAgentCliDigest({
      selectedAgentId: params.selectedAgentId,
      availableAgentClis: params.availableAgentClis,
    }),
    smithersGuideDigest,
    smithersSyntaxReference,
    smithersCliAgentModelGuide,
    smithersFeatureImplementationFlowExample,
    "Use this scaffold shape and adapt IDs/schemas/prompts:",
    `\`\`\`tsx\n${workflowPromptScaffold}\n\`\`\``,
    "User request:",
    params.userPrompt,
  ].join("\n\n")
}

export function buildWorkflowEditPrompt(params: {
  workflowName: string
  workflowId: string
  userPrompt: string
  workspacePath: string
  relativeFilePath: string
  selectedAgentId: string
  availableAgentClis: AgentCli[]
}) {
  return [
    "You are editing an existing Smithers workflow for Burns inside a real workspace.",
    "First read the current workflow file from disk before making changes.",
    "Then overwrite that same file on disk with the updated workflow.",
    "Do NOT create a new workflow folder or a second file.",
    "Do NOT return the full workflow source in chat unless absolutely necessary.",
    "Your primary task is to update the existing file on disk.",
    "After writing the file, respond with a short success confirmation only.",
    "Preserve stable kebab-case task IDs unless the user explicitly asks to rename them.",
    `Workflow display name: ${params.workflowName}`,
    `Workflow folder id: ${params.workflowId}`,
    `Target relative file: ${params.relativeFilePath}`,
    `Workspace path: ${params.workspacePath}`,
    "The file must continue to contain a default export that defines a valid Smithers workflow in TypeScript/TSX.",
    "If the user asks for approval steps, use needsApproval on the relevant task.",
    "Do not use a bare global smithers symbol. Always define it from createSmithers(...).",
    "Always import createSmithers from smithers-orchestrator and z from zod.",
    "Always define output schemas and reference outputs with output={outputs.<schemaKey>}.",
    "Keep reusable agents and shared prompt constants explicit instead of burying them inside task bodies.",
    buildAvailableAgentCliDigest({
      selectedAgentId: params.selectedAgentId,
      availableAgentClis: params.availableAgentClis,
    }),
    smithersGuideDigest,
    smithersSyntaxReference,
    smithersCliAgentModelGuide,
    smithersFeatureImplementationFlowExample,
    "Use this scaffold shape when rewriting if needed:",
    `\`\`\`tsx\n${workflowPromptScaffold}\n\`\`\``,
    "User request:",
    params.userPrompt,
  ].join("\n\n")
}

export function buildWorkflowRepairPrompt(params: {
  workflowName: string
  workflowId: string
  userPrompt: string
  workspacePath: string
  relativeFilePath: string
  validationError: string
  selectedAgentId: string
  availableAgentClis: AgentCli[]
}) {
  return [
    "You are repairing a Smithers workflow file after validation failed.",
    "Read the current workflow file and overwrite that same file on disk with a corrected version.",
    "Do not create a second workflow file and do not rename the workflow folder.",
    "Do not return the full file in chat.",
    "After fixing the file on disk, reply with a short success confirmation only.",
    `Workflow display name: ${params.workflowName}`,
    `Workflow folder id: ${params.workflowId}`,
    `Target relative file: ${params.relativeFilePath}`,
    `Workspace path: ${params.workspacePath}`,
    "The file must import createSmithers from smithers-orchestrator and z from zod.",
    "The file must define smithers via createSmithers(...) and default export smithers((ctx) => (...)).",
    "Every task output must use output={outputs.<schemaKey>}.",
    "If the workflow uses agents, define them explicitly and keep the prompts/schema contract coherent.",
    buildAvailableAgentCliDigest({
      selectedAgentId: params.selectedAgentId,
      availableAgentClis: params.availableAgentClis,
    }),
    smithersGuideDigest,
    smithersSyntaxReference,
    smithersCliAgentModelGuide,
    smithersFeatureImplementationFlowExample,
    "Validation error to fix:",
    params.validationError,
    "Original user request (preserve intent):",
    params.userPrompt,
    "Scaffold reference:",
    `\`\`\`tsx\n${workflowPromptScaffold}\n\`\`\``,
  ].join("\n\n")
}

function getErrorMessage(error: unknown) {
  if (error instanceof HttpError) {
    return error.message
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message
  }

  return "Workflow authoring failed with an unknown error."
}

function isNonFatalCodexWarning(error: unknown) {
  const message = getErrorMessage(error).toLowerCase()

  if (!message.includes("mcp") && !message.includes("network")) {
    return false
  }

  return (
    message.includes("transport channel closed") ||
    message.includes("connection refused") ||
    message.includes("failed to start") ||
    message.includes("network error")
  )
}

const workflowAuthorSystemPrompt =
  "You author Smithers workflow files. Write the requested file to disk and then return a short success confirmation."

function getWorkflowFilePath(workspaceId: string, workflowId: string) {
  const workflowRoot = getWorkflowRoot(workspaceId)
  const candidateExtensions = ["workflow.tsx", "workflow.ts"]

  for (const candidate of candidateExtensions) {
    const filePath = path.join(workflowRoot, workflowId, candidate)
    if (existsSync(filePath)) {
      return filePath
    }
  }

  throw new HttpError(404, `Workflow not found: ${workflowId}`)
}

function getWorkflowDirectoryPath(workspaceId: string, workflowId: string) {
  const workflowRoot = getWorkflowRoot(workspaceId)
  const workflowDirectoryPath = path.join(workflowRoot, workflowId)

  if (!existsSync(workflowDirectoryPath) || !statSync(workflowDirectoryPath).isDirectory()) {
    throw new HttpError(404, `Workflow not found: ${workflowId}`)
  }

  return workflowDirectoryPath
}

function normalizeWorkflowFilePath(inputPath: string) {
  const normalized = inputPath.replaceAll("\\", "/").replace(/^\.?\//, "")
  if (!normalized || normalized.includes("\0")) {
    throw new HttpError(400, "Invalid workflow file path")
  }
  return normalized
}

function resolveWorkflowFilePath(workflowDirectoryPath: string, inputPath: string) {
  const normalizedPath = normalizeWorkflowFilePath(inputPath)
  const resolvedPath = path.resolve(workflowDirectoryPath, normalizedPath)
  const rootPrefix = workflowDirectoryPath.endsWith(path.sep)
    ? workflowDirectoryPath
    : `${workflowDirectoryPath}${path.sep}`

  if (resolvedPath !== workflowDirectoryPath && !resolvedPath.startsWith(rootPrefix)) {
    throw new HttpError(400, "Workflow file path escapes workflow directory")
  }

  if (!existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) {
    throw new HttpError(404, `Workflow file not found: ${normalizedPath}`)
  }

  return {
    normalizedPath,
    resolvedPath,
  }
}

function mapWorkflowFile(workspaceId: string, workflowId: string, filePath: string): Workflow {
  const relativePath = path.relative(getWorkspace(workspaceId)!.path, filePath)
  const stats = statSync(filePath)

  return {
    id: workflowId,
    workspaceId,
    name: workflowId,
    relativePath,
    status: inferWorkflowStatus(workflowId),
    updatedAt: stats.mtime.toISOString(),
  }
}

function toFieldLabel(key: string) {
  const withSpaces = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()

  if (!withSpaces) {
    return key
  }

  return withSpaces[0].toUpperCase() + withSpaces.slice(1)
}

function extractFirstTaskSegment(source: string) {
  const taskMatch = source.match(/<Task\b[\s\S]*?<\/Task>/)
  if (!taskMatch?.[0]) {
    return {
      entryTaskId: null,
      taskSegment: null,
      taskEndIndex: null,
    }
  }

  const taskSegment = taskMatch[0]
  const idMatch = taskSegment.match(/\bid\s*=\s*["']([^"']+)["']/)
  const taskEndIndex = (taskMatch.index ?? 0) + taskSegment.length

  return {
    entryTaskId: idMatch?.[1] ?? null,
    taskSegment,
    taskEndIndex,
  }
}

function extractCtxInputKeys(source: string) {
  const nullishChainPattern =
    /ctx\.input\??\.[A-Za-z_$][\w$]*(?:\s*\?\?\s*ctx\.input\??\.[A-Za-z_$][\w$]*)+/g
  const ctxInputKeyPattern = /ctx\.input\??\.([A-Za-z_$][\w$]*)/g
  const nullishChainHeadKeys = new Set<string>()
  const nullishChainTailKeys = new Set<string>()

  for (const chainMatch of source.matchAll(nullishChainPattern)) {
    const chainSource = chainMatch[0]
    if (!chainSource) {
      continue
    }

    const chainKeys = Array.from(
      chainSource.matchAll(ctxInputKeyPattern),
      (match) => match[1]
    ).filter((key): key is string => Boolean(key))

    if (chainKeys.length === 0) {
      continue
    }

    nullishChainHeadKeys.add(chainKeys[0]!)
    for (const key of chainKeys.slice(1)) {
      nullishChainTailKeys.add(key)
    }
  }

  const pattern = /ctx\.input\??\.([A-Za-z_$][\w$]*)/g
  const keys: string[] = []
  const seen = new Set<string>()

  for (const match of source.matchAll(pattern)) {
    const key = match[1]
    if (!key || seen.has(key)) {
      continue
    }

    if (nullishChainTailKeys.has(key) && !nullishChainHeadKeys.has(key)) {
      continue
    }

    seen.add(key)
    keys.push(key)
  }

  return keys
}

export function getWorkflowLaunchFields(
  workspaceId: string,
  workflowId: string
): WorkflowLaunchFieldsResponse {
  const workflow = getWorkflow(workspaceId, workflowId)
  const { entryTaskId, taskSegment, taskEndIndex } = extractFirstTaskSegment(workflow.source)

  if (!taskSegment || taskEndIndex === null) {
    return {
      workflowId,
      mode: "fallback",
      entryTaskId: null,
      fields: [],
      message: "Unable to determine inputs automatically.",
    }
  }

  // Include pre-task callback setup plus the first task body so patterns like:
  // const feature = ctx.input?.feature ?? ctx.input?.description
  // are discovered even when the first task only interpolates `${feature}`.
  const inferenceSegment = workflow.source.slice(0, taskEndIndex)
  const inputKeys = extractCtxInputKeys(inferenceSegment)
  if (inputKeys.length === 0) {
    return {
      workflowId,
      mode: "fallback",
      entryTaskId,
      fields: [],
      message: "Unable to determine inputs automatically.",
    }
  }

  return {
    workflowId,
    mode: "inferred",
    entryTaskId,
    fields: inputKeys.map((key) => ({
      key,
      label: toFieldLabel(key),
      type: "string",
    })),
  }
}

export function ensureDefaultWorkflowTemplates(workspaceId: string, templateIds?: string[]) {
  const workflowRoot = getWorkflowRoot(workspaceId)
  mkdirSync(workflowRoot, { recursive: true })

  const hasWorkflowFiles = readdirSync(workflowRoot, { withFileTypes: true }).some((entry) => {
    if (!entry.isDirectory()) {
      return false
    }

    return existsSync(path.join(workflowRoot, entry.name, "workflow.tsx"))
  })

  if (hasWorkflowFiles) {
    return
  }

  const selectedTemplateIds = new Set(templateIds ?? [])
  const templatesToWrite = templateIds?.length
    ? defaultWorkflowTemplates.filter((template) => selectedTemplateIds.has(template.id))
    : defaultWorkflowTemplates

  for (const template of templatesToWrite) {
    const workflowDir = path.join(workflowRoot, template.id)
    mkdirSync(workflowDir, { recursive: true })
    writeFileSync(path.join(workflowDir, "workflow.tsx"), `${template.source}\n`, "utf8")
  }
}

export function listWorkflows(workspaceId: string) {
  const workflowRoot = getWorkflowRoot(workspaceId)

  if (!existsSync(workflowRoot)) {
    return []
  }

  return readdirSync(workflowRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      try {
        const filePath = getWorkflowFilePath(workspaceId, entry.name)
        return mapWorkflowFile(workspaceId, entry.name, filePath)
      } catch {
        return null
      }
    })
    .filter((workflow): workflow is Workflow => workflow !== null)
    .sort((left, right) => left.name.localeCompare(right.name))
}

export function getWorkflow(workspaceId: string, workflowId: string): WorkflowDocument {
  const filePath = getWorkflowFilePath(workspaceId, workflowId)

  return {
    ...mapWorkflowFile(workspaceId, workflowId, filePath),
    source: readFileSync(filePath, "utf8"),
  }
}

export function listWorkflowFiles(workspaceId: string, workflowId: string) {
  const workflowDirectoryPath = getWorkflowDirectoryPath(workspaceId, workflowId)
  const files: { path: string }[] = []

  const walk = (directoryPath: string) => {
    const entries = readdirSync(directoryPath, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name)
    )

    for (const entry of entries) {
      const entryPath = path.join(directoryPath, entry.name)
      if (entry.isDirectory()) {
        walk(entryPath)
        continue
      }

      if (!entry.isFile()) {
        continue
      }

      files.push({
        path: path.relative(workflowDirectoryPath, entryPath).replaceAll("\\", "/"),
      })
    }
  }

  walk(workflowDirectoryPath)

  return {
    workflowId,
    files,
  }
}

export function getWorkflowFile(workspaceId: string, workflowId: string, filePath: string) {
  const workflowDirectoryPath = getWorkflowDirectoryPath(workspaceId, workflowId)
  const { normalizedPath, resolvedPath } = resolveWorkflowFilePath(workflowDirectoryPath, filePath)

  return {
    workflowId,
    path: normalizedPath,
    source: readFileSync(resolvedPath, "utf8"),
  }
}

export function saveWorkflow(workspaceId: string, workflowId: string, source: string) {
  const workflowRoot = getWorkflowRoot(workspaceId)
  const workflowDir = path.join(workflowRoot, workflowId)
  const filePath = path.join(workflowDir, "workflow.tsx")

  const normalizedSource = normalizeAndValidateWorkflowSource(source)

  mkdirSync(workflowDir, { recursive: true })
  writeFileSync(filePath, normalizedSource, "utf8")

  return getWorkflow(workspaceId, workflowId)
}

export function deleteWorkflow(workspaceId: string, workflowId: string) {
  const workflowRoot = getWorkflowRoot(workspaceId)
  const workflowDir = path.join(workflowRoot, workflowId)

  if (!existsSync(workflowDir)) {
    throw new HttpError(404, `Workflow not found: ${workflowId}`)
  }

  rmSync(workflowDir, { recursive: true, force: true })
}

function finalizeWorkflowFile(workspaceId: string, workflowId: string, filePath: string) {
  if (!existsSync(filePath)) {
    throw new HttpError(500, `Agent did not create workflow file: ${filePath}`)
  }

  const existingSource = readFileSync(filePath, "utf8")
  if (!existingSource.trim()) {
    throw new HttpError(500, `Generated workflow file is empty: ${filePath}`)
  }

  const normalizedSource = normalizeAndValidateWorkflowSource(existingSource)
  if (normalizedSource !== existingSource) {
    writeFileSync(filePath, normalizedSource, "utf8")
  }

  return getWorkflow(workspaceId, workflowId)
}

async function runWorkflowAuthoringWithRetries(params: {
  workspaceId: string
  workflowId: string
  workflowName: string
  workspacePath: string
  relativeFilePath: string
  filePath: string
  agentId: string
  availableAgentClis: AgentCli[]
  initialPrompt: string
  userPrompt: string
  onProgress?: WorkflowAuthoringProgressHandler
  onAgentOutput?: WorkflowAuthoringOutputHandler
  onAgentEvent?: WorkflowAuthoringAgentEventHandler
}) {
  let promptToRun = params.initialPrompt

  for (let attempt = 1; attempt <= MAX_WORKFLOW_AUTHORING_ATTEMPTS; attempt += 1) {
    params.onProgress?.({
      stage: "running-agent",
      message: `Running ${params.agentId} authoring attempt ${attempt}/${MAX_WORKFLOW_AUTHORING_ATTEMPTS}.`,
      attempt,
      totalAttempts: MAX_WORKFLOW_AUTHORING_ATTEMPTS,
    })

    let commandError: unknown = null
    try {
      await runWorkflowGenerationAgent({
        agentId: params.agentId,
        prompt: promptToRun,
        cwd: params.workspacePath,
        systemPrompt: workflowAuthorSystemPrompt,
        onOutput: params.onAgentOutput,
        onEvent: params.onAgentEvent,
      })
    } catch (error) {
      commandError = error
      if (!(params.agentId === "codex" && isNonFatalCodexWarning(error))) {
        throw error
      }

      params.onProgress?.({
        stage: "validating",
        message: "Codex reported non-fatal MCP/network warnings. Continuing with validation.",
        attempt,
        totalAttempts: MAX_WORKFLOW_AUTHORING_ATTEMPTS,
      })
    }

    params.onProgress?.({
      stage: "validating",
      message: `Validating workflow source after attempt ${attempt}.`,
      attempt,
      totalAttempts: MAX_WORKFLOW_AUTHORING_ATTEMPTS,
    })

    try {
      return finalizeWorkflowFile(params.workspaceId, params.workflowId, params.filePath)
    } catch (error) {
      const validationError =
        commandError && params.agentId === "codex" && isNonFatalCodexWarning(commandError)
          ? `${getErrorMessage(commandError)}; ${getErrorMessage(error)}`
          : getErrorMessage(error)

      if (attempt >= MAX_WORKFLOW_AUTHORING_ATTEMPTS) {
        if (commandError && params.agentId === "codex" && isNonFatalCodexWarning(commandError)) {
          throw new HttpError(500, validationError)
        }
        throw error
      }

      params.onProgress?.({
        stage: "retrying",
        message: `Validation failed on attempt ${attempt}: ${validationError}`,
        attempt,
        totalAttempts: MAX_WORKFLOW_AUTHORING_ATTEMPTS,
      })

      promptToRun = buildWorkflowRepairPrompt({
        workflowName: params.workflowName,
        workflowId: params.workflowId,
        userPrompt: params.userPrompt,
        workspacePath: params.workspacePath,
        relativeFilePath: params.relativeFilePath,
        validationError,
        selectedAgentId: params.agentId,
        availableAgentClis: params.availableAgentClis,
      })
    }
  }

  throw new HttpError(500, "Workflow authoring exhausted all retries")
}

export function repairLegacyDefaultWorkflowTemplate(
  workspaceId: string,
  workflowId: string
) {
  const replacementSource = defaultTemplateById.get(workflowId)
  if (!replacementSource) {
    return false
  }

  let filePath: string
  try {
    filePath = getWorkflowFilePath(workspaceId, workflowId)
  } catch {
    return false
  }

  const existingSource = readFileSync(filePath, "utf8")
  if (!isLegacyBareSmithersSource(existingSource)) {
    return false
  }

  const normalizedReplacement = normalizeAndValidateWorkflowSource(replacementSource)
  writeFileSync(filePath, normalizedReplacement, "utf8")
  return true
}

export async function generateWorkflowFromPrompt(params: {
  workspaceId: string
  name: string
  agentId: string
  prompt: string
  onProgress?: WorkflowAuthoringProgressHandler
  onAgentOutput?: WorkflowAuthoringOutputHandler
  onAgentEvent?: WorkflowAuthoringAgentEventHandler
}) {
  const workspace = getWorkspace(params.workspaceId)

  if (!workspace) {
    throw new HttpError(404, `Workspace not found: ${params.workspaceId}`)
  }

  const availableAgentClis = listInstalledAgentClis()

  const workflowId = slugify(params.name)
  if (!workflowId) {
    throw new HttpError(400, "Workflow name must contain letters or numbers")
  }

  const workflowRoot = getWorkflowRoot(params.workspaceId)
  const workflowDir = path.join(workflowRoot, workflowId)
  const filePath = path.join(workflowDir, "workflow.tsx")
  const relativeFilePath = path.join(".smithers", "workflows", workflowId, "workflow.tsx")

  mkdirSync(workflowDir, { recursive: true })

  params.onProgress?.({
    stage: "preparing",
    message: `Preparing generation for workflow "${params.name}" (${workflowId}).`,
    totalAttempts: MAX_WORKFLOW_AUTHORING_ATTEMPTS,
  })

  const generationPrompt = buildWorkflowGenerationPrompt({
    workflowName: params.name,
    workflowId,
    userPrompt: params.prompt,
    workspacePath: workspace.path,
    selectedAgentId: params.agentId,
    availableAgentClis,
  })

  const authoredWorkflow = await runWorkflowAuthoringWithRetries({
    workspaceId: params.workspaceId,
    workflowId,
    workflowName: params.name,
    workspacePath: workspace.path,
    relativeFilePath,
    filePath,
    agentId: params.agentId,
    availableAgentClis,
    initialPrompt: generationPrompt,
    userPrompt: params.prompt,
    onProgress: params.onProgress,
    onAgentOutput: params.onAgentOutput,
    onAgentEvent: params.onAgentEvent,
  })

  params.onProgress?.({
    stage: "completed",
    message: `Workflow "${workflowId}" generated successfully.`,
  })

  return authoredWorkflow
}

export async function editWorkflowFromPrompt(params: {
  workspaceId: string
  workflowId: string
  agentId: string
  prompt: string
  onProgress?: WorkflowAuthoringProgressHandler
  onAgentOutput?: WorkflowAuthoringOutputHandler
  onAgentEvent?: WorkflowAuthoringAgentEventHandler
}) {
  const workspace = getWorkspace(params.workspaceId)

  if (!workspace) {
    throw new HttpError(404, `Workspace not found: ${params.workspaceId}`)
  }

  const availableAgentClis = listInstalledAgentClis()

  const existingWorkflow = getWorkflow(params.workspaceId, params.workflowId)
  const filePath = getWorkflowFilePath(params.workspaceId, params.workflowId)

  params.onProgress?.({
    stage: "preparing",
    message: `Preparing edit for workflow "${params.workflowId}".`,
    totalAttempts: MAX_WORKFLOW_AUTHORING_ATTEMPTS,
  })

  const editPrompt = buildWorkflowEditPrompt({
    workflowName: existingWorkflow.name,
    workflowId: params.workflowId,
    userPrompt: params.prompt,
    workspacePath: workspace.path,
    relativeFilePath: existingWorkflow.relativePath,
    selectedAgentId: params.agentId,
    availableAgentClis,
  })

  const editedWorkflow = await runWorkflowAuthoringWithRetries({
    workspaceId: params.workspaceId,
    workflowId: params.workflowId,
    workflowName: existingWorkflow.name,
    workspacePath: workspace.path,
    relativeFilePath: existingWorkflow.relativePath,
    filePath,
    agentId: params.agentId,
    availableAgentClis,
    initialPrompt: editPrompt,
    userPrompt: params.prompt,
    onProgress: params.onProgress,
    onAgentOutput: params.onAgentOutput,
    onAgentEvent: params.onAgentEvent,
  })

  params.onProgress?.({
    stage: "completed",
    message: `Workflow "${params.workflowId}" updated successfully.`,
  })

  return editedWorkflow
}
