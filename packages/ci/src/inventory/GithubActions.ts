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
import { expand, hostAction, hostActions, type Toolchain } from "../contract/Inventory.ts"
import { addStep, type Draft, draft, fileProblem, note, type Parsed } from "./Draft.ts"
import { expandMatrix, type Matrix, noMatrix } from "./Matrix.ts"
import { isLiteralSecret } from "./Secrets.ts"
import { asScalar, asStrings, isRecord, normalizeDirectory, shellQuote } from "./Values.ts"

const source = "github-actions"

/** What an expression can see at one level of a workflow. */
interface Scope {
  readonly env: ReadonlyMap<string, string>
  /** Variable name to the secret it receives. */
  readonly secretEnv: ReadonlyMap<string, string>
  /** Secrets used inside longer values, which reach no variable here. */
  readonly secrets: ReadonlyArray<string>
  readonly matrix: Matrix
}

interface Resolved {
  readonly text: string
  readonly unresolved: ReadonlyArray<string>
  readonly secrets: ReadonlyArray<string>
}

const matrixReferences = (text: string): ReadonlyArray<string> =>
  [...text.matchAll(/\$\{\{\s*matrix\.([\w.-]+)\s*\}\}/g)].map((match) => match[1] as string)

const resolve = (text: string, scope: Scope): Resolved => {
  const unresolved: Array<string> = []
  const secrets: Array<string> = []
  const resolved = text.replace(/\$\{\{([\s\S]*?)\}\}/g, (whole, inner: string) => {
    const expression = inner.trim()
    const secret = /^secrets\.([\w-]+)$/.exec(expression)?.[1]
      ?? (expression === "github.token" ? "GITHUB_TOKEN" : undefined)
    if (secret !== undefined) {
      secrets.push(secret)
      return whole
    }
    if (expression.startsWith("matrix.") && scope.matrix.keys.has(expression.slice("matrix.".length))) {
      return `\${{ ${expression} }}`
    }
    const name = /^env\.([\w-]+)$/.exec(expression)?.[1] ?? ""
    const value = scope.env.get(name)
    if (value === undefined) {
      unresolved.push(expression)
      return whole
    }
    if (!isLiteralSecret(name, value)) return value
    secrets.push(name)
    return whole
  })
  return { text: resolved, unresolved, secrets }
}

/**
 * Adds one `env:` block to a scope. A value that is not known is left out and
 * reported. Only a step's block may read `env`; GitHub offers no `env` context
 * to the workflow's or a job's.
 */
const withEnv = (scope: Scope, raw: unknown, job: Draft, where: string, readsEnv: boolean): Scope => {
  if (raw === undefined) return scope
  if (!isRecord(raw)) {
    note(job, "expression", `${where} computes its whole environment`)
    return scope
  }
  const visible = readsEnv ? scope : { ...scope, env: new Map<string, string>() }
  const env = new Map(scope.env)
  const secretEnv = new Map(scope.secretEnv)
  const secrets = [...scope.secrets]
  for (const [name, rawValue] of Object.entries(raw)) {
    env.delete(name)
    secretEnv.delete(name)
    const scalar = asScalar(rawValue)
    if (scalar === undefined) {
      note(job, "malformed-env", `${where} sets ${name} to a list or mapping`)
      continue
    }
    const value = resolve(scalar, visible)
    const only = value.secrets[0]
    if (only !== undefined && value.secrets.length === 1 && /^\s*\$\{\{[^}]*\}\}\s*$/.test(scalar)) {
      secretEnv.set(name, only)
    } else {
      secrets.push(...value.secrets)
      for (const secret of value.secrets) note(job, "secret-env", `${where} builds ${name} from secret ${secret}`)
    }
    for (const expression of value.unresolved) note(job, "expression", `${where} sets ${name} from ${expression}`)
    if (value.secrets.length === 0 && value.unresolved.length === 0) env.set(name, value.text)
  }
  return { ...scope, env, secretEnv, secrets: [...new Set(secrets)] }
}

/** The directory a step runs in, relative to the repository root. */
const readCwd = (raw: string, scope: Scope): { readonly cwd: string } | { readonly problem: string } => {
  const value = resolve(raw.replace(/^\$\{\{\s*github\.workspace\s*\}\}\/?/, ""), scope)
  const first = [...value.unresolved, ...value.secrets][0]
  if (first !== undefined) return { problem: `its directory comes from ${first}` }
  const outside = { problem: `its directory ${value.text} is outside the repository` }
  if (!value.text.includes("${{")) {
    const cwd = normalizeDirectory(value.text)
    return cwd === undefined ? outside : { cwd }
  }
  // The variants decide where this is, so each must stay inside the repository.
  if (scope.matrix.variants.some((variant) => normalizeDirectory(expand(value.text, variant)) === undefined)) {
    return outside
  }
  return { cwd: value.text.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "") }
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
  const version = raw === undefined ? undefined : resolve(raw, { ...scope, matrix: noMatrix })
  return version === undefined || version.text === "" || version.text.includes("${{")
    ? { name, source: file }
    : { name, source: file, version: version.text }
}

/** Job keys that change what runs and cannot be reproduced from a command. */
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
      ? Object.keys(config).filter((key) => /^(?:(?:branches|tags|paths)(?:-ignore)?|types|workflows)$/.test(key))
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
  const scope = withEnv(context.scope, raw["env"], job, where, true)

  if (raw["if"] !== undefined) note(job, "condition", `${where} runs only if ${String(raw["if"])}`)
  if (raw["continue-on-error"] !== undefined) {
    note(job, "continue-on-error", `${where} may fail without failing the job`)
  }

  const uses = raw["uses"]
  if (typeof uses === "string") {
    const tool = readSetup(uses, raw["with"], scope, file)
    if (tool !== undefined) context.toolchains.push(tool)
    const prepares = tool !== undefined || hostActions.includes(uses.split("@")[0] as string)
    return note(job, prepares ? hostAction : "uses", `${uses} has no command to run`)
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

  // GitHub pastes a matrix value into the script text, where a quote would end the quoting added here.
  const references = matrixReferences(command.text)
  const breaksQuoting = (variant: Readonly<Record<string, string>>) =>
    references.some((key) => variant[key]?.includes("'"))
  if (start !== "" && scope.matrix.variants.some(breaksQuoting)) {
    return note(job, "shell", `${where} puts a matrix value holding a quote into its script`)
  }

  const rawCwd = asScalar(raw["working-directory"] ?? defaults.cwd ?? "")
  if (rawCwd === undefined) return note(job, "working-directory", `${where} has a directory that is not text`)
  const place = readCwd(rawCwd, scope)
  if ("problem" in place) return note(job, "working-directory", `${where}: ${place.problem}`)

  const runnerNames = [...new Set(command.text.match(/\b(?:GITHUB|RUNNER)_[A-Z_]+\b/g))]
  if (runnerNames.length > 0) note(job, "runner-variable", `${where} reads ${runnerNames.join(", ")}`)

  addStep(job, {
    where,
    command: start === "" ? command.text : `${start} ${shellQuote(command.text.trim())}`,
    cwd: place.cwd,
    env: scope.env,
    secrets: scope.secrets,
    secretEnv: scope.secretEnv,
    name: stepName
  })
}

/** How many runs of the job are on Windows, once each variant fills in its runner. */
const windowsRuns = (runsOn: string | undefined, matrix: Matrix): "all" | "some" | "none" => {
  if (runsOn === undefined) return "none"
  const names = matrix.variants.length === 0 ? [runsOn] : matrix.variants.map((variant) => expand(runsOn, variant))
  const windows = names.filter((name) => /windows/i.test(name)).length
  if (windows === 0) return "none"
  return windows === names.length ? "all" : "some"
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

/** GitHub reads a matrix key a variant lacks as empty, so a variant must say so. */
const fillReferencedKeys = (job: Draft, matrix: Matrix): Draft => {
  const texts = [job.runsOn ?? "", ...job.steps.flatMap((step) => [step.command, step.cwd, ...Object.values(step.env)])]
  const used = texts.flatMap(matrixReferences).filter((key) => matrix.keys.has(key))
  return {
    ...job,
    matrix: matrix.variants.map((variant) => ({
      ...variant,
      ...Object.fromEntries(used.filter((key) => !Object.hasOwn(variant, key)).map((key) => [key, ""]))
    }))
  }
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

const readJobBody = (workflow: WorkflowContext, job: Draft, raw: Record<string, unknown>, matrix: Matrix): void => {
  const { name } = job
  for (const filter of workflow.filters) note(job, "trigger-filter", filter)
  if (matrix.problem !== undefined) note(job, "matrix", `${name}: ${matrix.problem}`)
  if (raw["strategy"] !== undefined && !isRecord(raw["strategy"])) {
    note(job, "matrix", `${name}: its strategy is computed when the workflow runs`)
  }
  if (raw["if"] !== undefined) note(job, "condition", `${name} runs only if ${String(raw["if"])}`)
  for (const [jobKey, reason] of jobFeatures) {
    if (raw[jobKey] !== undefined) note(job, jobKey, `${name} ${reason}`)
  }

  const jobScope = { ...workflow.scope, matrix }
  if (job.runsOn !== undefined) {
    const unknown = resolve(job.runsOn, jobScope).unresolved
    if (unknown.length > 0) note(job, "runner", `${name} picks its runner from ${unknown.join(", ")}`)
  }
  const windows = windowsRuns(job.runsOn, matrix)
  if (windows === "some") note(job, "shell", `some variants of ${name} run in PowerShell on Windows`)

  if (typeof raw["uses"] === "string") {
    return note(job, "uses", `${raw["uses"]} is a reusable workflow; its jobs were not read`)
  }
  const steps: unknown = raw["steps"]
  if (!Array.isArray(steps)) return note(job, "malformed-job", `${name} has no list of steps`)
  const context: JobContext = {
    file: workflow.file,
    job,
    scope: withEnv(jobScope, raw["env"], job, name, false),
    defaults: readDefaults(raw, workflow.defaults),
    windowsOnly: windows === "all",
    toolchains: workflow.toolchains
  }
  steps.forEach((step: unknown, index) => readStep(context, step, index))
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
    ...readRunsOn(raw["runs-on"], { name }, problems)
  })
  for (const [feature, reason] of problems) note(job, feature, reason)
  readJobBody(workflow, job, raw, matrix)
  return fillReferencedKeys(job, matrix)
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
 * Reads a workflow. A file that is not a workflow adds no jobs, only the
 * reason.
 *
 * @category readers
 * @since 0.1.0
 * @throws {never}
 */
export const readWorkflow = (file: string, text: string): Parsed => {
  const base = file.slice(file.lastIndexOf("/") + 1)
  const parsed = parseYaml(text)
  if ("problem" in parsed) return fileProblem(file, "malformed-file", parsed.problem)
  const workflow = parsed.value
  if (!isRecord(workflow) || !isRecord(workflow["jobs"])) {
    return fileProblem(file, "malformed-file", "it has no jobs mapping")
  }
  const { filters, triggers } = readTriggers(workflow["on"])
  const toolchains: Array<Toolchain> = []
  const holder = draft({ id: base, source, file, name: base })
  const empty: Scope = { env: new Map(), secretEnv: new Map(), secrets: [], matrix: noMatrix }
  const context: WorkflowContext = {
    file,
    base,
    triggers,
    filters,
    scope: withEnv(empty, workflow["env"], holder, "the workflow", false),
    defaults: readDefaults(workflow, { shell: undefined, cwd: undefined }),
    toolchains
  }
  const jobs = Object.entries(workflow["jobs"]).map(([key, job]) => {
    const read = readJob(context, key, job)
    for (const entry of holder.unsupported) read.unsupported.push(entry)
    return read
  })
  return { jobs, toolchains, unsupported: [] }
}
