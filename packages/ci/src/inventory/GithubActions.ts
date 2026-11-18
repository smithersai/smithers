/**
 * Reads one GitHub Actions workflow file.
 *
 * A step becomes a command only when its text is known exactly. GitHub replaces
 * `${{ }}` expressions before the shell starts, so an expression is resolved
 * here when its value is in the file, kept as written when it is a matrix
 * variable the variants list, and otherwise the step is reported, not guessed.
 *
 * @since 0.1.0
 */

import { parseDocument } from "yaml"
import type { Toolchain } from "../contract/Inventory.ts"
import { addStep, type Draft, draft, fileProblem, note, type Parsed } from "./Draft.ts"
import { expandMatrix, type Matrix } from "./Matrix.ts"
import { asScalar, asStrings, isRecord, shellQuote } from "./Values.ts"

const source = "github-actions"

/** What an expression can see at one level of a workflow. */
interface Scope {
  readonly env: ReadonlyMap<string, string>
  readonly secrets: ReadonlyArray<string>
  readonly matrixKeys: ReadonlySet<string>
}

interface Resolved {
  readonly text: string
  readonly unresolved: ReadonlyArray<string>
  readonly secrets: ReadonlyArray<string>
}

const resolve = (text: string, scope: Scope): Resolved => {
  const unresolved: Array<string> = []
  const secrets: Array<string> = []
  const resolved = text.replace(/\$\{\{([\s\S]*?)\}\}/g, (whole, inner: string) => {
    const expression = inner.trim()
    const secret = /^secrets\.([\w-]+)$/.exec(expression)?.[1] ??
      (expression === "github.token" ? "GITHUB_TOKEN" : undefined)
    if (secret !== undefined) {
      secrets.push(secret)
      return whole
    }
    if (expression.startsWith("matrix.") && scope.matrixKeys.has(expression.slice("matrix.".length))) {
      return `\${{ ${expression} }}`
    }
    const value = scope.env.get(/^env\.([\w-]+)$/.exec(expression)?.[1] ?? "")
    if (value !== undefined) return value
    unresolved.push(expression)
    return whole
  })
  return { text: resolved, unresolved, secrets }
}

/** Adds one `env:` block to a scope. A value that is not known is left out and reported. */
const withEnv = (scope: Scope, raw: unknown, job: Draft, where: string): Scope => {
  if (raw === undefined) return scope
  if (!isRecord(raw)) {
    note(job, "expression", `${where} computes its whole environment`)
    return scope
  }
  const env = new Map(scope.env)
  const secrets = [...scope.secrets]
  for (const [name, rawValue] of Object.entries(raw)) {
    env.delete(name)
    const scalar = asScalar(rawValue)
    if (scalar === undefined) {
      note(job, "malformed-env", `${where} sets ${name} to a list or mapping`)
      continue
    }
    const value = resolve(scalar, scope)
    secrets.push(...value.secrets)
    for (const secret of value.secrets) {
      if (secret !== name) note(job, "secret-env", `${where} sets ${name} from secret ${secret}`)
    }
    for (const expression of value.unresolved) {
      note(job, "expression", `${where} sets ${name} from ${expression}`)
    }
    if (value.secrets.length === 0 && value.unresolved.length === 0) env.set(name, value.text)
  }
  return { ...scope, env, secrets: [...new Set(secrets)] }
}

/** The directory a step runs in, relative to the repository root. */
const readCwd = (raw: string, scope: Scope): { readonly cwd: string } | { readonly problem: string } => {
  const value = resolve(raw.replace(/^\$\{\{\s*github\.workspace\s*\}\}\/?/, ""), scope)
  const first = [...value.unresolved, ...value.secrets][0]
  if (first !== undefined) return { problem: `its directory comes from ${first}` }
  if (value.text.startsWith("/")) return { problem: `its directory ${value.text} is outside the repository` }
  const parts: Array<string> = []
  for (const part of value.text.split("/")) {
    if (part === "..") {
      if (parts.pop() === undefined) return { problem: `its directory ${value.text} is outside the repository` }
    } else if (part !== "" && part !== ".") {
      parts.push(part)
    }
  }
  return { cwd: parts.join("/") }
}

/** The shell command that starts a named shell, or `undefined` for one this cannot run. */
const shellStart = (shell: string): string | undefined => {
  if (shell === "bash") return "bash --noprofile --norc -eo pipefail -c"
  if (shell === "sh") return "sh -e -c"
  const template = /^(bash|sh)((?: [-\w]+)*) \{0\}$/.exec(shell)
  return template === null ? undefined : `${template[1]}${template[2]} -c`
}

/** Actions that install a tool, and the input that pins its version. */
const setupActions: ReadonlyMap<string, readonly [tool: string, input: string]> = new Map([
  ["actions/setup-node", ["node", "node-version"]],
  ["actions/setup-go", ["go", "go-version"]],
  ["actions/setup-python", ["python", "python-version"]],
  ["actions/setup-java", ["java", "java-version"]],
  ["oven-sh/setup-bun", ["bun", "bun-version"]],
  ["pnpm/action-setup", ["pnpm", "version"]],
  ["mlugg/setup-zig", ["zig", "version"]],
  ["goto-bus-stop/setup-zig", ["zig", "version"]],
  ["dtolnay/rust-toolchain", ["rust", "toolchain"]],
  ["extractions/setup-just", ["just", "just-version"]]
])

const readSetup = (uses: string, inputs: unknown, scope: Scope, file: string): Toolchain | undefined => {
  const setup = setupActions.get(uses.split("@")[0] as string)
  if (setup === undefined) return undefined
  const [name, input] = setup
  const raw = isRecord(inputs) ? asScalar(inputs[input]) : undefined
  const version = raw === undefined ? undefined : resolve(raw, { ...scope, matrixKeys: new Set() })
  return version === undefined || version.text === "" || version.text.includes("${{")
    ? { name, source: file }
    : { name, source: file, version: version.text }
}

/** Job and step keys that change what runs and cannot be reproduced from a command. */
const jobFeatures: ReadonlyMap<string, string> = new Map([
  ["services", "runs service containers"],
  ["container", "runs inside a container"],
  ["environment", "deploys to an environment"],
  ["continue-on-error", "may fail without failing the workflow"]
])

const readTriggers = (
  on: unknown
): { readonly triggers: ReadonlyArray<string>; readonly filters: ReadonlyArray<string> } => {
  if (!isRecord(on)) return { triggers: asStrings(on) ?? [], filters: [] }
  const filters = Object.entries(on).flatMap(([event, config]) => {
    const keys = isRecord(config)
      ? Object.keys(config).filter((key) => /^(branches|tags|paths)(-ignore)?$/.test(key))
      : []
    return keys.length === 0 ? [] : [`${event} runs only for matching ${keys.join(", ")}`]
  })
  return { triggers: Object.keys(on), filters }
}

interface RunDefaults {
  readonly shell: unknown
  readonly cwd: unknown
}

const readDefaults = (owner: Record<string, unknown>, parent: RunDefaults): RunDefaults => {
  const defaults = owner["defaults"]
  const run = isRecord(defaults) ? defaults["run"] : undefined
  return isRecord(run)
    ? { shell: run["shell"] ?? parent.shell, cwd: run["working-directory"] ?? parent.cwd }
    : parent
}

interface JobContext {
  readonly file: string
  readonly job: Draft
  readonly scope: Scope
  readonly defaults: RunDefaults
  readonly windowsOnly: boolean
  readonly toolchains: Array<Toolchain>
}

const readStep = (context: JobContext, raw: unknown, index: number): void => {
  const { defaults, file, job, windowsOnly } = context
  const number = index + 1
  if (!isRecord(raw)) return note(job, "malformed-step", `step ${number} of ${job.name} is not a mapping`)
  const stepName = typeof raw["name"] === "string" ? raw["name"] : undefined
  const where = `${job.name} step ${number}${stepName === undefined ? "" : ` (${stepName})`}`
  const scope = withEnv(context.scope, raw["env"], job, where)

  if (raw["if"] !== undefined) note(job, "condition", `${where} runs only if ${String(raw["if"])}`)
  if (raw["continue-on-error"] !== undefined) {
    note(job, "continue-on-error", `${where} may fail without failing the job`)
  }

  const uses = raw["uses"]
  if (typeof uses === "string") {
    const tool = readSetup(uses, raw["with"], scope, file)
    if (tool !== undefined) context.toolchains.push(tool)
    return note(job, "uses", `${uses} has no command to run`)
  }
  const run = raw["run"]
  if (typeof run !== "string") return note(job, "malformed-step", `${where} has neither run nor uses`)

  const rawShell = raw["shell"] ?? defaults.shell
  if (rawShell !== undefined && typeof rawShell !== "string") {
    return note(job, "shell", `${where} names its shell with a value that is not text`)
  }
  const start = rawShell === undefined ? "" : shellStart(rawShell)
  if (start === undefined) return note(job, "shell", `${where} runs in ${rawShell}`)
  if (rawShell === undefined && windowsOnly) return note(job, "shell", `${where} runs in PowerShell on Windows`)

  const command = resolve(run, scope)
  const blocking = [...command.unresolved, ...command.secrets.map((name) => `secret ${name}`)]
  if (blocking.length > 0) return note(job, "expression", `${where} depends on ${blocking.join(", ")}`)

  const rawCwd = raw["working-directory"] ?? defaults.cwd
  const place = typeof rawCwd === "string" ? readCwd(rawCwd, scope) : { cwd: "" }
  if ("problem" in place) return note(job, "working-directory", `${where}: ${place.problem}`)

  const runnerNames = [...new Set(command.text.match(/\b(?:GITHUB|RUNNER)_[A-Z_]+\b/g))]
  if (runnerNames.length > 0) note(job, "runner-variable", `${where} reads ${runnerNames.join(", ")}`)

  addStep(job, {
    where,
    command: start === "" ? command.text : `${start} ${shellQuote(command.text.trim())}`,
    cwd: place.cwd,
    env: scope.env,
    secrets: scope.secrets,
    name: stepName
  })
}

/** True when some variant of the job, or every run of it, is on Windows. */
const runnerOs = (runsOn: string | undefined, matrix: Matrix): "all" | "some" | "none" => {
  if (runsOn === undefined) return "none"
  const key = /\$\{\{\s*matrix\.([\w.-]+)\s*\}\}/.exec(runsOn)?.[1]
  if (key !== undefined) return matrix.variants.some((variant) => /windows/i.test(variant[key] ?? "")) ? "some" : "none"
  return /windows/i.test(runsOn) ? "all" : "none"
}

const readRunsOn = (raw: unknown, job: { readonly name: string }, problems: Array<[string, string]>) => {
  if (raw === undefined) return {}
  const labels = asStrings(raw)
  if (labels === undefined) {
    problems.push(["runner", `${job.name} picks its runner by group`])
    return {}
  }
  return { runsOn: labels.join(",") }
}

interface WorkflowContext {
  readonly file: string
  readonly base: string
  readonly triggers: ReadonlyArray<string>
  readonly filters: ReadonlyArray<string>
  readonly scope: Scope
  readonly defaults: RunDefaults
  readonly toolchains: Array<Toolchain>
}

const readJob = (workflow: WorkflowContext, key: string, raw: unknown): Draft => {
  const { base, file, triggers } = workflow
  const id = `${base}:${key}`
  if (!isRecord(raw)) {
    const job = draft({ id, source, file, name: key, triggers })
    note(job, "malformed-job", `job ${key} is not a mapping`)
    return job
  }
  const name = typeof raw["name"] === "string" ? raw["name"] : key
  const problems: Array<[string, string]> = []
  const needs = asStrings(raw["needs"] ?? [])
  if (needs === undefined) problems.push(["malformed-job", `${name} has a needs value that is not a job list`])
  const strategy = raw["strategy"]
  const matrix = expandMatrix(isRecord(strategy) ? strategy["matrix"] : undefined)
  const job = draft({
    id,
    source,
    file,
    name,
    needs: (needs ?? []).map((need) => `${base}:${need}`),
    triggers,
    matrix: matrix.variants,
    ...readRunsOn(raw["runs-on"], { name }, problems)
  })
  for (const [feature, reason] of problems) note(job, feature, reason)
  for (const filter of workflow.filters) note(job, "trigger-filter", filter)
  if (matrix.problem !== undefined) note(job, "matrix", `${name}: ${matrix.problem}`)
  if (raw["if"] !== undefined) note(job, "condition", `${name} runs only if ${String(raw["if"])}`)
  for (const [jobKey, reason] of jobFeatures) {
    if (raw[jobKey] !== undefined) note(job, jobKey, `${name} ${reason}`)
  }

  const jobScope = { ...workflow.scope, matrixKeys: matrix.keys }
  if (job.runsOn !== undefined) {
    const unknown = resolve(job.runsOn, jobScope).unresolved
    if (unknown.length > 0) note(job, "runner", `${name} picks its runner from ${unknown.join(", ")}`)
  }
  const os = runnerOs(job.runsOn, matrix)
  if (os === "some") note(job, "shell", `some variants of ${name} run in PowerShell on Windows`)

  if (typeof raw["uses"] === "string") {
    note(job, "uses", `${raw["uses"]} is a reusable workflow; its jobs were not read`)
    return job
  }
  const steps: unknown = raw["steps"]
  if (!Array.isArray(steps)) {
    note(job, "malformed-job", `${name} has no list of steps`)
    return job
  }
  const context: JobContext = {
    file,
    job,
    scope: withEnv(jobScope, raw["env"], job, name),
    defaults: readDefaults(raw, workflow.defaults),
    windowsOnly: os === "all",
    toolchains: workflow.toolchains
  }
  steps.forEach((step: unknown, index) => readStep(context, step, index))
  return job
}

const parseYaml = (text: string): { readonly value: unknown } | { readonly problem: string } => {
  const document = parseDocument(text)
  const error = document.errors[0]
  if (error !== undefined) return { problem: `${error.code} at line ${error.linePos?.[0].line}` }
  try {
    return { value: document.toJS() }
  } catch {
    return { problem: "its aliases cannot be expanded" }
  }
}

/**
 * Reads a workflow. A file that is not a workflow is one job with no steps
 * whose `unsupported` entry says why.
 *
 * @category readers
 * @since 0.1.0
 * @throws {never}
 */
export const readWorkflow = (file: string, text: string): Parsed => {
  const base = file.slice(file.lastIndexOf("/") + 1)
  const parsed = parseYaml(text)
  if ("problem" in parsed) return fileProblem(base, source, file, "malformed-file", parsed.problem)
  const workflow = parsed.value
  if (!isRecord(workflow) || !isRecord(workflow["jobs"])) {
    return fileProblem(base, source, file, "malformed-file", "it has no jobs mapping")
  }
  const { filters, triggers } = readTriggers(workflow["on"])
  const toolchains: Array<Toolchain> = []
  const holder = draft({ id: base, source, file, name: base })
  const scope = withEnv({ env: new Map(), secrets: [], matrixKeys: new Set() }, workflow["env"], holder, "the workflow")
  const context: WorkflowContext = {
    file,
    base,
    triggers,
    filters,
    scope,
    defaults: readDefaults(workflow, { shell: undefined, cwd: undefined }),
    toolchains
  }
  const jobs = Object.entries(workflow["jobs"]).map(([key, job]) => {
    const read = readJob(context, key, job)
    read.unsupported.push(...holder.unsupported)
    return read
  })
  return { jobs, toolchains }
}
