import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"

import type {
  AgentCli,
  LocalWorkflowDiscoveryResponse,
  Workflow,
  WorkflowAuthoringStage,
  WorkflowDocument,
  WorkflowLaunchFieldsResponse,
} from "@burns/shared"

import type { AgentCliEvent } from "@/agents/BaseCliAgent"
import { defaultWorkflowTemplates } from "@/domain/workflows/templates"
import { listInstalledAgentClis, runWorkflowGenerationAgent } from "@/services/agent-cli-service"
import { isGitRepository } from "@/services/git-service"
import { ensureWorkspaceSmithersLayout } from "@/services/workspace-layout"
import { getWorkspace } from "@/services/workspace-service"
import { HttpError } from "@/utils/http-error"
import { slugify } from "@/utils/slugify"

const workflowPromptScaffold = [
  'import { ClaudeCodeAgent, CodexAgent, createSmithers, Ralph, Sequence } from "smithers-orchestrator"',
  'import { z } from "zod"',
  "",
  "const { Workflow, Task, smithers, outputs } = createSmithers({",
  "  plan: z.object({",
  "    summary: z.string(),",
  "    acceptanceCriteria: z.array(z.string()),",
  "  }),",
  "  implement: z.object({",
  "    summary: z.string(),",
  "    filesChanged: z.array(z.string()),",
  "  }),",
  "  validate: z.object({",
  "    allPassed: z.boolean(),",
  "    summary: z.string(),",
  "  }),",
  "  review: z.object({",
  "    approved: z.boolean(),",
  "    findings: z.array(z.string()),",
  "  }),",
  "})",
  "",
  "const SHARED_SYSTEM_PROMPT =",
  '  "You are working inside a real repository. Preserve stable task IDs, keep the workflow coherent, and return only schema-matching JSON."',
  "",
  "const plannerAgent = new ClaudeCodeAgent({",
  '  model: "claude-sonnet-4-5-20250929",',
  '  permissionMode: "bypassPermissions",',
  "  timeoutMs: 10 * 60 * 1000,",
  "  systemPrompt: SHARED_SYSTEM_PROMPT,",
  "})",
  "",
  "const implementationAgent = new CodexAgent({",
  '  model: "gpt-5.3-codex",',
  '  sandbox: "workspace-write",',
  "  fullAuto: true,",
  "  timeoutMs: 20 * 60 * 1000,",
  '  config: { model_reasoning_effort: "high" },',
  "  systemPrompt: SHARED_SYSTEM_PROMPT,",
  "})",
  "",
  "const reviewAgent = new ClaudeCodeAgent({",
  '  model: "claude-opus-4-6",',
  '  permissionMode: "bypassPermissions",',
  "  timeoutMs: 10 * 60 * 1000,",
  "  systemPrompt: SHARED_SYSTEM_PROMPT,",
  "})",
  "",
  "export default smithers((ctx) => (",
  '  <Workflow name="example-workflow">',
  "    <Sequence>",
  '      <Task id="plan" output={outputs.plan} agent={plannerAgent} timeoutMs={10 * 60 * 1000} retries={1}>',
  "        {[",
  '          "Create a plan for: " + String(ctx.input?.request ?? "the requested change") + ".",',
  '          "",',
  '          "Return only JSON that matches the plan schema.",',
  '        ].join("\\n")}',
  "      </Task>",
  '      <Ralph id="implement-review-loop" until={Boolean(ctx.outputMaybe("review", { nodeId: "review" })?.approved)} maxIterations={3} onMaxReached="return-last">',
  "        <Sequence>",
  '          <Task id="implement" output={outputs.implement} agent={implementationAgent} timeoutMs={20 * 60 * 1000}>',
  "            {[",
  '              "Implement the plan.",',
  '              "",',
  '              "Acceptance criteria:",',
  '              JSON.stringify(ctx.outputMaybe("plan", { nodeId: "plan" })?.acceptanceCriteria ?? [], null, 2),',
  '              "",',
  '              "Return only JSON that matches the implement schema.",',
  '            ].join("\\n")}',
  "          </Task>",
  '          <Task id="validate" output={outputs.validate} agent={implementationAgent} timeoutMs={10 * 60 * 1000} retries={1}>',
  '            {"Run the relevant validation for the latest implementation and return only JSON that matches the validate schema."}',
  "          </Task>",
  '          <Task id="review" output={outputs.review} agent={reviewAgent} timeoutMs={10 * 60 * 1000} skipIf={!ctx.outputMaybe("validate", { nodeId: "validate" })?.allPassed}>',
  '            {"Review the latest implementation only when validation passed. Return only JSON that matches the review schema."}',
  "          </Task>",
  "        </Sequence>",
  "      </Ralph>",
  "    </Sequence>",
  "  </Workflow>",
  "))",
].join("\n")

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
const MAX_DISCOVERED_WORKFLOW_FILE_SIZE_BYTES = 512 * 1024
const WORKFLOW_SOURCE_EXTENSIONS = new Set([".ts", ".tsx"])
const STANDARD_WORKFLOW_RELATIVE_PATH_PATTERN = /^\.smithers\/workflows\/([^/]+)\/workflow\.(?:tsx|ts)$/
const IGNORED_WORKFLOW_DISCOVERY_DIRECTORIES = new Set([
  ".git",
  ".jj",
  ".next",
  ".smithers",
  ".turbo",
  ".vscode",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "tmp",
])

type WorkflowAuthoringProgressEvent = {
  stage: WorkflowAuthoringStage
  message: string
  attempt?: number
  totalAttempts?: number
}

type WorkflowAuthoringProgressHandler = (event: WorkflowAuthoringProgressEvent) => void
type WorkflowAuthoringOutputHandler = (event: { stream: "stdout" | "stderr"; chunk: string }) => void
type WorkflowAuthoringAgentEventHandler = (event: AgentCliEvent) => void
type WorkflowEntry = Workflow & {
  browseRootPath: string
  directoryPath: string
  filePath: string
}

function assertWorkspaceRecord(workspaceId: string) {
  const workspace = getWorkspace(workspaceId)

  if (!workspace) {
    throw new HttpError(404, `Workspace not found: ${workspaceId}`)
  }

  return workspace
}

function assertWorkflowMutationsAllowed(workspaceId: string) {
  const workspace = assertWorkspaceRecord(workspaceId)

  if (workspace.runtimeMode === "self-managed") {
    throw new HttpError(403, "Self-managed workflows are read-only in Burns.")
  }

  return workspace
}

function getWorkflowRoot(workspaceId: string) {
  return ensureWorkspaceSmithersLayout(assertWorkspaceRecord(workspaceId).path).workflowRoot
}

function normalizeFilesystemPath(value: string) {
  return value.replaceAll("\\", "/").replace(/^\.?\//, "")
}

function readWorkflowCandidateSource(filePath: string) {
  const fileStats = statSync(filePath)
  if (!fileStats.isFile() || fileStats.size > MAX_DISCOVERED_WORKFLOW_FILE_SIZE_BYTES) {
    return null
  }

  return readFileSync(filePath, "utf8")
}

function looksLikeSmithersWorkflowSource(filePath: string, source: string) {
  if (!/from\s+["']smithers-orchestrator["']/.test(source)) {
    return false
  }

  if (/export\s+default\s+smithers\s*\(/.test(source)) {
    return true
  }

  const fileName = path.basename(filePath).toLowerCase()
  return (fileName === "workflow.tsx" || fileName === "workflow.ts") && /<Workflow\b/.test(source)
}

function extractWorkflowDisplayName(filePath: string, source: string) {
  const workflowNameMatch = source.match(/<Workflow\b[^>]*\bname\s*=\s*["']([^"']+)["']/)
  if (workflowNameMatch?.[1]) {
    return workflowNameMatch[1]
  }

  const fileStem = path.basename(filePath, path.extname(filePath))
  if (fileStem !== "workflow") {
    return fileStem
  }

  return path.basename(path.dirname(filePath)) || "workflow"
}

function buildWorkflowId(relativePath: string) {
  const normalizedRelativePath = normalizeFilesystemPath(relativePath)
  const standardMatch = normalizedRelativePath.match(STANDARD_WORKFLOW_RELATIVE_PATH_PATTERN)
  if (standardMatch?.[1]) {
    return standardMatch[1]
  }

  const withoutExtension = normalizedRelativePath.replace(/\.(tsx|ts)$/i, "")
  const withoutWorkflowStem = withoutExtension.endsWith("/workflow")
    ? withoutExtension.slice(0, -"/workflow".length)
    : withoutExtension
  const candidateId = slugify(withoutWorkflowStem.replaceAll("/", "-"))

  return candidateId || slugify(path.basename(withoutExtension)) || "workflow"
}

function buildWorkflowEntry(params: {
  workspaceId: string
  workspacePath: string
  filePath: string
  source: string
  name?: string
}): WorkflowEntry {
  const relativePath = normalizeFilesystemPath(path.relative(params.workspacePath, params.filePath))
  const fileName = path.basename(params.filePath)
  const browseRootPath =
    fileName === "workflow.tsx" || fileName === "workflow.ts"
      ? path.dirname(params.filePath)
      : params.filePath
  const stats = statSync(params.filePath)

  return {
    id: buildWorkflowId(relativePath),
    workspaceId: params.workspaceId,
    name: params.name ?? extractWorkflowDisplayName(params.filePath, params.source),
    relativePath,
    status: inferWorkflowStatus(buildWorkflowId(relativePath)),
    updatedAt: stats.mtime.toISOString(),
    browseRootPath,
    directoryPath: path.dirname(params.filePath),
    filePath: params.filePath,
  }
}

function toUniqueWorkflowEntries(entries: WorkflowEntry[]) {
  const seenPaths = new Set<string>()
  const uniqueEntries: WorkflowEntry[] = []

  for (const entry of entries) {
    if (seenPaths.has(entry.filePath)) {
      continue
    }

    seenPaths.add(entry.filePath)
    uniqueEntries.push(entry)
  }

  const idCounts = new Map<string, number>()

  return uniqueEntries
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    .map((entry) => {
      const nextCount = (idCounts.get(entry.id) ?? 0) + 1
      idCounts.set(entry.id, nextCount)

      if (nextCount === 1) {
        return entry
      }

      return {
        ...entry,
        id: `${entry.id}-${nextCount}`,
      }
    })
}

function collectStandardWorkflowEntries(workspaceId: string, workspacePath: string) {
  const workflowRoot = getWorkflowRoot(workspaceId)

  return collectStandardWorkflowEntriesFromRoot({
    workspaceId,
    workspacePath,
    workflowRoot,
  })
}

function collectStandardWorkflowEntriesFromRoot(params: {
  workspaceId: string
  workspacePath: string
  workflowRoot: string
}) {
  const { workspaceId, workspacePath, workflowRoot } = params

  if (!existsSync(workflowRoot)) {
    return []
  }

  const entries: WorkflowEntry[] = []

  for (const directoryEntry of readdirSync(workflowRoot, { withFileTypes: true })) {
    if (!directoryEntry.isDirectory()) {
      continue
    }

    for (const fileName of ["workflow.tsx", "workflow.ts"] as const) {
      const filePath = path.join(workflowRoot, directoryEntry.name, fileName)
      if (!existsSync(filePath)) {
        continue
      }

      const source = readWorkflowCandidateSource(filePath)
      if (!source) {
        continue
      }

      entries.push(
        buildWorkflowEntry({
          workspaceId,
          workspacePath,
          filePath,
          source,
          name: directoryEntry.name,
        })
      )
      break
    }
  }

  return entries
}

function shouldIgnoreWorkflowDiscoveryDirectory(directoryName: string) {
  return IGNORED_WORKFLOW_DISCOVERY_DIRECTORIES.has(directoryName)
}

function discoverSelfManagedWorkflowEntries(workspaceId: string, workspacePath: string) {
  const discoveredEntries: WorkflowEntry[] = []

  const walk = (directoryPath: string) => {
    const directoryEntries = readdirSync(directoryPath, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name)
    )

    for (const directoryEntry of directoryEntries) {
      const entryPath = path.join(directoryPath, directoryEntry.name)

      if (directoryEntry.isDirectory()) {
        if (shouldIgnoreWorkflowDiscoveryDirectory(directoryEntry.name)) {
          continue
        }

        walk(entryPath)
        continue
      }

      if (!directoryEntry.isFile()) {
        continue
      }

      if (!WORKFLOW_SOURCE_EXTENSIONS.has(path.extname(directoryEntry.name))) {
        continue
      }

      const source = readWorkflowCandidateSource(entryPath)
      if (!source || !looksLikeSmithersWorkflowSource(entryPath, source)) {
        continue
      }

      discoveredEntries.push(
        buildWorkflowEntry({
          workspaceId,
          workspacePath,
          filePath: entryPath,
          source,
        })
      )
    }
  }

  walk(workspacePath)

  return discoveredEntries
}

function listWorkflowEntries(workspaceId: string) {
  const workspace = assertWorkspaceRecord(workspaceId)
  const standardEntries = collectStandardWorkflowEntries(workspaceId, workspace.path)

  if (workspace.runtimeMode !== "self-managed") {
    return toUniqueWorkflowEntries(standardEntries)
  }

  const discoveredEntries = discoverSelfManagedWorkflowEntries(workspaceId, workspace.path)
  return toUniqueWorkflowEntries([...standardEntries, ...discoveredEntries])
}

function resolveWorkflowEntry(workspaceId: string, workflowId: string) {
  const normalizedWorkflowId = normalizeFilesystemPath(workflowId)
  const entries = listWorkflowEntries(workspaceId)

  const matchedEntry =
    entries.find((entry) => entry.id === workflowId) ??
    entries.find((entry) => entry.name === workflowId) ??
    entries.find((entry) => normalizeFilesystemPath(entry.relativePath) === normalizedWorkflowId)

  if (!matchedEntry) {
    throw new HttpError(404, `Workflow not found: ${workflowId}`)
  }

  return matchedEntry
}

export function findWorkflowEntryByFilePath(workspaceId: string, workflowFilePath: string) {
  const normalizedWorkflowFilePath = path.resolve(workflowFilePath)
  return (
    listWorkflowEntries(workspaceId).find((entry) => path.resolve(entry.filePath) === normalizedWorkflowFilePath) ??
    null
  )
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

function buildBurnsWorkflowLayoutGuidance(params: {
  workflowId: string
  targetRelativeFile: string
}) {
  return [
    "Burns stores each workflow under its own folder at .smithers/workflows/<workflow-id>/ and launches the root entry file named workflow.tsx or workflow.ts.",
    `Keep the canonical runnable entry file at ${params.targetRelativeFile}. That entry file must remain the root workflow entrypoint and default export smithers((ctx) => (...)).`,
    "For small workflows, prefer a single-file entry workflow. For larger or production workflows, you may split code into multiple supporting files inside the same workflow folder.",
    "Supporting files may include components/, prompts/, lib/, agents.ts, smithers.ts, schemas.ts, config.ts, system-prompt.ts, preload.ts, and bunfig.toml when they improve structure.",
    `You may create or update multiple files under .smithers/workflows/${params.workflowId}/ when needed for shared schemas, agents, prompt templates, MDX files, helpers, or composed components.`,
    `Do not create another workflow folder, do not move the entry file out of .smithers/workflows/${params.workflowId}/, and do not write outside that workflow folder unless the user explicitly asks for broader repository changes.`,
    "If you split the workflow across files, keep imports relative and Bun/TypeScript friendly so Burns can browse the files and Smithers can run the root entry file successfully.",
  ].join("\n")
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
    "Use your file editing tools to create or overwrite the target workflow entry file and any necessary supporting files.",
    "Do NOT return the workflow source in chat unless absolutely necessary.",
    "Your primary task is to write the workflow files on disk.",
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
    buildBurnsWorkflowLayoutGuidance({
      workflowId: params.workflowId,
      targetRelativeFile: `.smithers/workflows/${params.workflowId}/workflow.tsx`,
    }),
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
    "First read the current workflow entry file and any related files from disk before making changes.",
    "Then update the workflow entry file and any supporting files on disk as needed.",
    "Do NOT return the full workflow source in chat unless absolutely necessary.",
    "Your primary task is to update the existing workflow files on disk.",
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
    buildBurnsWorkflowLayoutGuidance({
      workflowId: params.workflowId,
      targetRelativeFile: params.relativeFilePath,
    }),
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
    "Read the current workflow entry file and any supporting files needed to understand the failure.",
    "Update the existing workflow entry file and any supporting files on disk with a corrected version.",
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
    buildBurnsWorkflowLayoutGuidance({
      workflowId: params.workflowId,
      targetRelativeFile: params.relativeFilePath,
    }),
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
  "You author Smithers workflow files. Write the workflow entry file and any necessary supporting files to disk, then return a short success confirmation."

function getWorkflowFilePath(workspaceId: string, workflowId: string) {
  return resolveWorkflowEntry(workspaceId, workflowId).filePath
}

export function resolveWorkflowEntryFilePath(workspaceId: string, workflowId: string) {
  return getWorkflowFilePath(workspaceId, workflowId)
}

export function getWorkflowDirectoryPath(workspaceId: string, workflowId: string) {
  return resolveWorkflowEntry(workspaceId, workflowId).directoryPath
}

function getWorkflowDirectoryPathForWrite(workspaceId: string, workflowId: string) {
  try {
    return getWorkflowDirectoryPath(workspaceId, workflowId)
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      return path.join(getWorkflowRoot(workspaceId), workflowId)
    }

    throw error
  }
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

function resolveWorkflowFileOutputPath(workflowDirectoryPath: string, inputPath: string) {
  const normalizedPath = normalizeWorkflowFilePath(inputPath)
  const resolvedPath = path.resolve(workflowDirectoryPath, normalizedPath)
  const rootPrefix = workflowDirectoryPath.endsWith(path.sep)
    ? workflowDirectoryPath
    : `${workflowDirectoryPath}${path.sep}`

  if (resolvedPath !== workflowDirectoryPath && !resolvedPath.startsWith(rootPrefix)) {
    throw new HttpError(400, "Workflow file path escapes workflow directory")
  }

  return {
    normalizedPath,
    resolvedPath,
  }
}

function isWorkflowSourceFilePath(filePath: string) {
  return filePath === "workflow.tsx" || filePath === "workflow.ts"
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

function hasDirectCtxInputReference(source: string) {
  return /ctx\.input(?!\s*\??\.)/.test(source)
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

  if (inputKeys.length === 0 && hasDirectCtxInputReference(inferenceSegment)) {
    return {
      workflowId,
      mode: "fallback",
      entryTaskId,
      fields: [],
      message: "Enter run input as JSON.",
    }
  }

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

  const selectedTemplateIds = new Set(templateIds ?? [])
  const templatesToWrite =
    templateIds === undefined
      ? defaultWorkflowTemplates
      : defaultWorkflowTemplates.filter((template) => selectedTemplateIds.has(template.id))

  for (const template of templatesToWrite) {
    const workflowDir = path.join(workflowRoot, template.id)
    if (
      existsSync(path.join(workflowDir, "workflow.tsx")) ||
      existsSync(path.join(workflowDir, "workflow.ts"))
    ) {
      continue
    }

    mkdirSync(workflowDir, { recursive: true })
    writeFileSync(path.join(workflowDir, "workflow.tsx"), `${template.source}\n`, "utf8")
  }
}

export function discoverLocalWorkflows(localPath: string): LocalWorkflowDiscoveryResponse {
  const trimmedLocalPath = localPath.trim()
  if (!trimmedLocalPath || !path.isAbsolute(trimmedLocalPath)) {
    throw new HttpError(400, "Local repository path must be absolute")
  }

  const resolvedLocalPath = path.resolve(trimmedLocalPath)

  if (!existsSync(resolvedLocalPath)) {
    throw new HttpError(400, `Local path does not exist: ${resolvedLocalPath}`)
  }

  if (!statSync(resolvedLocalPath).isDirectory()) {
    throw new HttpError(400, `Local path is not a directory: ${resolvedLocalPath}`)
  }

  if (!isGitRepository(resolvedLocalPath)) {
    throw new HttpError(400, `Local path is not a git repository: ${resolvedLocalPath}`)
  }

  const workflowRoot = path.join(resolvedLocalPath, ".smithers", "workflows")
  const workflows = collectStandardWorkflowEntriesFromRoot({
    workspaceId: "local-preview",
    workspacePath: resolvedLocalPath,
    workflowRoot,
  })
    .map(({ workspaceId: _workspaceId, status: _status, browseRootPath: _browseRootPath, directoryPath: _directoryPath, filePath: _filePath, ...workflow }) => workflow)
    .sort((left, right) => left.name.localeCompare(right.name))

  return {
    localPath: resolvedLocalPath,
    workflows,
  }
}

export function listWorkflows(workspaceId: string) {
  return listWorkflowEntries(workspaceId)
    .map(({ browseRootPath: _browseRootPath, directoryPath: _directoryPath, filePath: _filePath, ...workflow }) => workflow)
    .sort((left, right) => left.name.localeCompare(right.name))
}

export function getWorkflow(workspaceId: string, workflowId: string): WorkflowDocument {
  const workflowEntry = resolveWorkflowEntry(workspaceId, workflowId)
  const {
    browseRootPath: _browseRootPath,
    directoryPath: _directoryPath,
    filePath,
    ...workflow
  } = workflowEntry

  return {
    ...workflow,
    source: readFileSync(filePath, "utf8"),
  }
}

export function listWorkflowFiles(workspaceId: string, workflowId: string) {
  const workflowEntry = resolveWorkflowEntry(workspaceId, workflowId)
  const workflowDirectoryPath = workflowEntry.browseRootPath
  const files: { path: string }[] = []

  if (statSync(workflowDirectoryPath).isFile()) {
    return {
      workflowId: workflowEntry.id,
      files: [{ path: path.basename(workflowEntry.filePath) }],
    }
  }

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
    workflowId: workflowEntry.id,
    files,
  }
}

export function getWorkflowFile(workspaceId: string, workflowId: string, filePath: string) {
  const workflowEntry = resolveWorkflowEntry(workspaceId, workflowId)
  const browseRootPath = workflowEntry.browseRootPath

  if (statSync(browseRootPath).isFile()) {
    const normalizedPath = normalizeWorkflowFilePath(filePath)
    const expectedPath = path.basename(workflowEntry.filePath)
    if (normalizedPath !== expectedPath) {
      throw new HttpError(404, `Workflow file not found: ${normalizedPath}`)
    }

    return {
      workflowId: workflowEntry.id,
      path: normalizedPath,
      source: readFileSync(workflowEntry.filePath, "utf8"),
    }
  }

  const { normalizedPath, resolvedPath } = resolveWorkflowFilePath(browseRootPath, filePath)

  return {
    workflowId: workflowEntry.id,
    path: normalizedPath,
    source: readFileSync(resolvedPath, "utf8"),
  }
}

export function saveWorkflow(workspaceId: string, workflowId: string, source: string) {
  assertWorkflowMutationsAllowed(workspaceId)
  const workflowDir = getWorkflowDirectoryPathForWrite(workspaceId, workflowId)
  const filePath = existsSync(path.join(workflowDir, "workflow.tsx"))
    ? path.join(workflowDir, "workflow.tsx")
    : existsSync(path.join(workflowDir, "workflow.ts"))
      ? path.join(workflowDir, "workflow.ts")
      : path.join(workflowDir, "workflow.tsx")
  const fileName = path.basename(filePath)

  mkdirSync(workflowDir, { recursive: true })
  saveWorkflowFile(workspaceId, workflowId, fileName, source)

  return getWorkflow(workspaceId, workflowId)
}

export function saveWorkflowFile(
  workspaceId: string,
  workflowId: string,
  filePath: string,
  source: string
) {
  assertWorkflowMutationsAllowed(workspaceId)
  const workflowDirectoryPath = getWorkflowDirectoryPathForWrite(workspaceId, workflowId)
  const { normalizedPath, resolvedPath } = resolveWorkflowFileOutputPath(workflowDirectoryPath, filePath)
  const nextSource = isWorkflowSourceFilePath(normalizedPath)
    ? normalizeAndValidateWorkflowSource(source)
    : source

  mkdirSync(path.dirname(resolvedPath), { recursive: true })
  writeFileSync(resolvedPath, nextSource, "utf8")

  return {
    workflowId,
    path: normalizedPath,
    source: readFileSync(resolvedPath, "utf8"),
  }
}

export function deleteWorkflow(workspaceId: string, workflowId: string) {
  assertWorkflowMutationsAllowed(workspaceId)
  const workflowDir = getWorkflowDirectoryPath(workspaceId, workflowId)

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
  const workspace = assertWorkflowMutationsAllowed(params.workspaceId)

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
  const workspace = assertWorkflowMutationsAllowed(params.workspaceId)

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
