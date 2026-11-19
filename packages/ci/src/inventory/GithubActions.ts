/**
 * Reads one GitHub Actions workflow file.
 *
 * A step becomes a command only when what it does is known exactly. GitHub
 * fills `${{ }}` in before the shell starts and decides `if:` before a step
 * runs, so every expression is evaluated here as GitHub evaluates it for the
 * event a replay stands for (see `Contexts.ts`). A value known only while
 * the job runs, such as a step's output, is worked out by the step's runner
 * text (see `Runner.ts`). A condition that is false leaves its step or job
 * out, and an expression nobody can evaluate here leaves its job out with
 * the reason: nothing is guessed.
 *
 * @since 0.1.0
 */

import {
  changeTriggers,
  conditionFalse,
  expand,
  type Host,
  hostAction,
  hostActions,
  hostOf,
  releaseTrigger,
  runnerSoftware,
  secret as receivesSecret,
  type Toolchain,
  triggerFilter,
  writePermission
} from "../contract/Inventory.ts"
import { cacheActions, checkoutProblems, parseYaml, readAction, setupVariables } from "./Actions.ts"
import {
  type CacheUse,
  cacheUse,
  handedOn,
  restoreScript,
  saveScript,
  shell as cacheShell,
  variables as cacheVariables
} from "./Cache.ts"
import { leaveCacheEmpty } from "./CacheCredentials.ts"
import {
  type Event,
  eventFile,
  eventName,
  eventOf,
  type Facts,
  github,
  runner as runnerContext,
  standIns,
  startedVariables,
  variables
} from "./Contexts.ts"
import { addStep, type Draft, draft, fileProblem, note, type Parsed } from "./Draft.ts"
import {
  type Context,
  evaluate,
  fields,
  fill,
  type Filled,
  type Part,
  type Residual,
  type Scope as Expressions,
  truthy,
  unknown,
  value,
  type Variable,
  variable,
  whole
} from "./Expression.ts"
import { filesOf } from "./Glob.ts"
import { installsOf } from "./MachineChanges.ts"
import { expandMatrix, type Matrix, noMatrix } from "./Matrix.ts"
import { type JobFacts, settled, type StepFacts, write } from "./Runner.ts"
import { isLiteralSecret, isSecretName } from "./Secrets.ts"
import { readSetup, type Setup } from "./Setup.ts"
import { before as beforeSetupCache, lockVariable, setupCache } from "./SetupCache.ts"
import { readLimit, secondsOf, within as withinLimit } from "./TimeLimit.ts"
import { asScalar, asStrings, isRecord, normalizeDirectory } from "./Values.ts"

const source = "github-actions"

/** The pieces of one value: text, and expressions finished while the job runs. */
type Entry = ReadonlyArray<Part>

/** The variables one level of a workflow sets, and the secrets they receive. */
interface Env {
  readonly entries: ReadonlyMap<string, Entry>
  /** Variable name to the secret it receives. */
  readonly secretEnv: ReadonlyMap<string, string>
  /** Secrets used inside longer values, which reach no variable here. */
  readonly secrets: ReadonlyArray<string>
  /** The names a step sets itself. `GITHUB_ENV` never replaces these. */
  readonly own: ReadonlySet<string>
  /** Variables whose value nobody can know here, each with the reason. An expression that reads one is refused. */
  readonly unread: ReadonlyMap<string, string>
}

const noEnv: Env = { entries: new Map(), secretEnv: new Map(), secrets: [], own: new Set(), unread: new Map() }

/** Whether a step runs: always, never, when an expression says so, or nobody can tell. */
type Condition =
  | { readonly kind: "always" }
  | { readonly kind: "never" }
  | { readonly kind: "when"; readonly residual: Residual }
  | { readonly kind: "problem"; readonly why: string }

const always: Condition = { kind: "always" }

/** What later steps read of a step: its outputs and how it ended. */
interface StepRecord {
  readonly outputs: Context
  readonly outcome: Context
}

/** Where a step is read: the job's own steps, or the steps of a composite action one of them uses. */
interface StepScope {
  readonly env: Env
  readonly inputs: Context
  readonly steps: Map<string, StepRecord>
  /** Starts the key of each step, so the steps of two actions never share one. */
  readonly prefix: string
  /** The condition of the step that uses the action. */
  readonly condition: Residual | undefined
  readonly actionPath: string | undefined
  readonly depth: number
  readonly where: string
  /** The most minutes a step here may run: the limit of the job, or of the step that uses the action. */
  readonly limit: number | undefined
}

interface RunDefaults {
  readonly shell: unknown
  readonly cwd: unknown
}

/** What an expression of a job reads of the job and its workflow. */
interface Shape {
  readonly facts: Facts
  readonly event: Event | undefined
  readonly key: string
  readonly workflow: string
  readonly matrix: Matrix
  /** Matrix keys whose value is text in every variant: only these can be compared. */
  readonly textKeys: ReadonlySet<string>
}

/** One job while its steps are read. */
interface JobState extends Shape {
  readonly file: string
  readonly job: Draft
  readonly host: Host | undefined
  readonly defaults: RunDefaults
  readonly windowsOnly: boolean
  readonly toolchains: Array<Toolchain>
  readonly runner: JobFacts
  /**
   * True once the job has a command. Any step can set a variable for later steps: a program it starts can write to
   * `GITHUB_ENV` with the step's text never naming the file. So from the second command on, a variable of the job
   * is read when the step runs.
   */
  ran: boolean
  /** Variables a setup action that ran would have set. */
  readonly setupNames: Set<string>
  /** How many commands of the job have a place among its steps: every one but those a replay may leave out. */
  placed: number
  /** The keys of those commands, in the order they run: a later step reads what each wrote for the steps after it. */
  readonly keys: Array<string>
  /** True when the command added last is one a replay may leave out. */
  apart: boolean
  /** The mark of the job's first command, by which the commands after it find what it left. */
  mark: string | undefined
  /** Where the job's first command is among its steps, and the runner text it takes when no command follows it. */
  only: { readonly at: number; readonly text: string } | undefined
  /** Values to work out once, when the next command starts, and keep for later steps under a name. */
  readonly keeps: Array<readonly [name: string, parts: Entry]>
  /** How many local actions the job has had read, which a job that nests them without end would not stop. */
  actions: number
  /** What the job's actions run after its other steps, as a cache step saves: the last one added runs first. */
  readonly after: Array<() => void>
}

/** A job is read with this many local actions and no more. */
const maxActions = 64

/** A value as a note shows it: its text, or that it has none. */
const shown = (raw: unknown): string => asScalar(raw) ?? "a value that is not text"

const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/

/** The variable that tells a step of an action where the action is. */
const actionPathVariable = "GITHUB_ACTION_PATH"

const actionDirectory = (directory: string): Variable => ({
  id: `path:${directory}`,
  name: "github.action_path",
  nullable: false,
  typed: false
})

const matrixReferences = (text: string): ReadonlyArray<string> =>
  [...text.matchAll(/\$\{\{\s*matrix\.([\w.-]+)\s*\}\}/g)].map((match) => match[1] as string)

const matrixKey = (part: Part): string | undefined =>
  typeof part !== "string" && part.residual.kind === "variable" && part.residual.variable.id.startsWith("matrix:")
    ? part.residual.variable.id.slice("matrix:".length)
    : undefined

/** The text of a value known before the run. A matrix value stays as `${{ matrix.<key> }}`, filled in per variant. */
const textOf = (parts: Entry): string | undefined => {
  let text = ""
  for (const part of parts) {
    const key = matrixKey(part)
    if (typeof part !== "string" && key === undefined) return undefined
    text += typeof part === "string" ? part : `\${{ matrix.${key} }}`
  }
  return text
}

/** One expression for a value made of several pieces. */
const residualOf = (parts: Entry): Residual => {
  const [only] = parts
  if (parts.length === 1 && only !== undefined && typeof only !== "string") return only.residual
  const args: Array<Residual> = []
  const template = parts.map((part) => {
    if (typeof part === "string") return part.replaceAll("{", "{{").replaceAll("}", "}}")
    args.push(part.residual)
    return `{${args.length - 1}}`
  }).join("")
  return { kind: "call", name: "format", args: [{ kind: "literal", value: template }, ...args] }
}

/** What a filled text stands for when another expression reads it. */
const contextOf = (filled: Filled): Context => {
  if (filled.kind === "problem") return unknown(filled.why)
  if (filled.kind === "secret") return filled
  const text = textOf(filled.parts)
  return text !== undefined && !text.includes("${{")
    ? value(text)
    : { kind: "residual", residual: residualOf(filled.parts) }
}

const matrixContext = (state: Shape): Context => {
  const { matrix, textKeys } = state
  if (matrix.problem !== undefined) return unknown(`the matrix is not known before the run (${matrix.problem})`)
  // GitHub reads a matrix key without case.
  const written = new Map([...matrix.keys].map((key) => [key.toLowerCase(), key]))
  const under = (lower: string): Context | undefined => {
    const key = written.get(lower)
    if (key !== undefined) {
      // A value is filled in per variant where its key is written, which reads only these characters.
      return /^[\w.-]+$/.test(key)
        ? variable(`matrix:${key}`, `matrix.${key}`, false, !textKeys.has(key))
        : unknown(`matrix key ${JSON.stringify(key)} has a name whose value is not filled in here`)
    }
    return [...written.keys()].some((other) => other.startsWith(`${lower}.`))
      ? fields((name) => under(`${lower}.${name}`))
      : undefined
  }
  return fields(under)
}

/**
 * `hashFiles` in a cache key. Named files are hashed as GitHub hashes them. A pattern is read too (`Glob.ts`): a
 * key has to be the same from one run to the next, and is never compared with GitHub's.
 */
const hashFilesForKey = (patterns: ReadonlyArray<string>): Context => {
  const named = hashFiles(patterns)
  const files = named.kind === "unknown" ? filesOf(patterns) : undefined
  return files === undefined ? named : variable(`glob:${JSON.stringify(files)}`, "hashFiles")
}

/** `hashFiles` of files named without a wildcard. */
const hashFiles = (patterns: ReadonlyArray<string>): Context =>
  patterns.every((pattern) =>
      !/[*?[\]{}!~]/.test(pattern) && normalizeDirectory(pattern) !== undefined && pattern !== ""
    )
    ? variable(`hash:${JSON.stringify(patterns.map((pattern) => normalizeDirectory(pattern)))}`, "hashFiles")
    : unknown("hashFiles with a wildcard or a path outside the repository is not worked out off GitHub")

const envContext = (state: JobState, env: Env): Context =>
  fields((name) => {
    const secret = env.secretEnv.get(name)
    if (secret !== undefined) return { kind: "secret", name: secret }
    const why = env.unread.get(name)
    if (why !== undefined) return unknown(why)
    const entry = env.entries.get(name)
    const text = entry === undefined ? undefined : textOf(entry)
    // A value written out under a name that says it is a secret is one: only its name is kept.
    if (text !== undefined && isLiteralSecret(name, text)) return { kind: "secret", name }
    if (entry === undefined && state.setupNames.has(name)) {
      return unknown(`env.${name} is set by a setup action, which a replay does not run`)
    }
    // A step's own variable is never replaced. Any other may have been by a step that ran before, so it is read
    // when the step runs: from the step's own environment when the workflow sets it, else from what was written.
    if (!env.own.has(name) && state.ran && identifier.test(name)) {
      return entry === undefined
        ? variable(`env:${JSON.stringify({ name, held: null })}`, `env.${name}`, true)
        : variable(`process:${name}`, `env.${name}`)
    }
    return entry === undefined ? undefined : contextOf({ kind: "ok", parts: entry })
  }, true)

/** The contexts an expression of a job can read; with `step`, those of one of its steps too. */
const expressions = (
  state: Shape,
  inputs: Context,
  step?: { readonly state: JobState; readonly scope: StepScope; readonly env: Env }
): Expressions => {
  const place = { job: state.key, workflow: state.workflow, actionPath: step?.scope.actionPath }
  const contexts = new Map<string, () => Context>([
    ["github", () => github(state.event, state.facts, place)],
    ["vars", () => fields(() => undefined)],
    ["inputs", () => inputs],
    ["matrix", () => matrixContext(state)],
    ["strategy", () =>
      fields((name) =>
        name === "job-total"
          ? value(Math.max(1, state.matrix.variants.length))
          : name === "job-index" && state.matrix.variants.length === 0 && state.matrix.problem === undefined
          ? value(0)
          : unknown(`strategy.${name} is known only while the run goes`)
      )],
    ["needs", () => unknown("what another job gave is known only while the run goes")],
    ["secrets", () => fields((name) => ({ kind: "secret", name }), true)]
  ])
  if (step !== undefined) {
    contexts.set("env", () => envContext(step.state, step.env))
    contexts.set("runner", () => runnerContext(step.state.host))
    contexts.set(
      "job",
      () => fields((name) => name === "status" ? value("success") : unknown(`job.${name} is known only on GitHub`))
    )
    contexts.set("steps", () =>
      fields((id) => {
        const record = step.scope.steps.get(id)
        return record === undefined
          ? undefined
          : fields((name) =>
            name === "outputs"
              ? record.outputs
              : name === "outcome" || name === "conclusion"
              ? record.outcome
              : undefined
          )
      }))
  }
  return {
    context: (name) => contexts.get(name)?.(),
    // A step or job is reached only when what ran before it passed: the baseline and the targets both stop at a failure.
    status: { success: true, always: true, cancelled: false, failure: false },
    ...(step === undefined ? {} : { hashFiles })
  }
}

/**
 * Reads an `if:`. It may be written with or without `${{ }}`. With any text around a `${{ }}`, even a line end
 * after it, GitHub reads the whole as text, and text that is not empty is true: `if: ${{ false }} ` runs.
 */
const readCondition = (raw: unknown, scope: Expressions): Condition => {
  if (raw === undefined) return always
  const scalar = asScalar(raw)
  if (scalar === undefined) return { kind: "problem", why: "it is not text" }
  const expression = whole(scalar, true)
  const settle = (residual: Residual): Condition => {
    // `x && false` is false whatever `x` is when the job runs.
    const known = residual.kind === "literal" ? truthy(residual.value) : settled(residual)
    if (known === undefined) return { kind: "when", residual }
    return known ? always : { kind: "never" }
  }
  if (expression === undefined) {
    const filled = fill(scalar, scope)
    if (filled.kind === "secret") return { kind: "problem", why: `it reads secret ${filled.name}` }
    if (filled.kind === "problem") return filled
    const text = textOf(filled.parts)
    return settle(
      text === undefined || text.includes("${{") ? residualOf(filled.parts) : { kind: "literal", value: text }
    )
  }
  const evaluated = evaluate(expression, scope)
  if (evaluated.kind === "secret") return { kind: "problem", why: `it reads secret ${evaluated.name}` }
  return evaluated.kind === "problem" ? evaluated : settle(evaluated.residual)
}

/** A step of an action runs when the step that uses the action does, and its own condition holds. */
const within = (outer: Residual | undefined, inner: Condition): Condition => {
  if (outer === undefined || inner.kind === "never" || inner.kind === "problem") return inner
  return {
    kind: "when",
    residual: inner.kind === "always" ? outer : { kind: "binary", operator: "&&", left: outer, right: inner.residual }
  }
}

/**
 * Adds one `env:` block to the variables above it. A value nobody can know
 * is left out and reported. With `own` the block is a step's.
 */
const withEnv = (above: Env, raw: unknown, job: Draft, where: string, scope: Expressions, own: boolean): Env => {
  if (raw === undefined) return above
  if (!isRecord(raw)) {
    note(job, "expression", `${where} computes its whole environment`)
    return above
  }
  const entries = new Map(above.entries)
  const secretEnv = new Map(above.secretEnv)
  const secrets = [...above.secrets]
  const names = new Set(above.own)
  const unread = new Map(above.unread)
  for (const [name, rawValue] of Object.entries(raw)) {
    entries.delete(name)
    secretEnv.delete(name)
    unread.delete(name)
    if (own) names.add(name)
    const scalar = asScalar(rawValue)
    if (scalar === undefined) {
      note(job, "malformed-env", `${where} sets ${name} to a list or mapping`)
      continue
    }
    const filled = fill(scalar, scope)
    if (filled.kind === "ok") {
      entries.set(name, filled.parts)
    } else if (filled.kind === "problem") {
      note(job, "expression", `${where} sets ${name} from ${filled.why}`)
      unread.set(name, filled.why)
    } else if (whole(scalar) !== undefined) {
      // The value is one expression that reads a secret: the variable receives it.
      secretEnv.set(name, filled.name)
    } else {
      secrets.push(filled.name)
      note(job, "secret-env", `${where} builds ${name} from secret ${filled.name}`)
    }
  }
  return { entries, secretEnv, secrets: [...new Set(secrets)], own: names, unread }
}

/** The directory a step runs in, relative to the repository root. */
const readCwd = (
  raw: string,
  matrix: Matrix,
  scope: Expressions
): { readonly cwd: string; readonly directory?: Entry } | { readonly problem: string } => {
  const filled = fill(raw, scope)
  if (filled.kind !== "ok") {
    return { problem: `its directory comes from ${filled.kind === "secret" ? `secret ${filled.name}` : filled.why}` }
  }
  const [first, second] = filled.parts
  // `${{ github.workspace }}/dir` is a directory of the repository.
  const rooted = first !== undefined && typeof first !== "string" && first.residual.kind === "variable"
    && first.residual.variable.id === "workspace"
  const parts = !rooted
    ? filled.parts
    : typeof second === "string"
    ? [second.replace(/^\/+/, ""), ...filled.parts.slice(2)]
    : filled.parts.slice(1)
  const text = textOf(parts)
  // A directory decided while the job runs: the step starts in the repository root and enters it from there.
  if (text === undefined) return { cwd: "", directory: parts }
  const outside = { problem: `its directory ${text} is outside the repository` }
  if (!text.includes("${{")) {
    const cwd = normalizeDirectory(text)
    return cwd === undefined ? outside : { cwd }
  }
  // The variants decide where this is, so each must stay inside the repository.
  if (matrix.variants.some((variant) => normalizeDirectory(expand(text, variant)) === undefined)) return outside
  return { cwd: text.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "") }
}

/** The shell and its flags for a step, or `undefined` for a shell this cannot run. The script follows `-c`. */
const shellStart = (shell: string | undefined): ReadonlyArray<string> | undefined => {
  if (shell === undefined) return ["bash", "-e"]
  if (shell === "bash") return ["bash", "--noprofile", "--norc", "-eo", "pipefail"]
  if (shell === "sh") return ["sh", "-e"]
  const template = /^(bash|sh)((?: [-\w]+)*) \{0\}$/.exec(shell)
  return template === null
    ? undefined
    : [template[1] as string, ...(template[2] as string).split(" ").filter((flag) => flag !== "")]
}

/** The text of a tool's version when it is written out, or is a matrix value, which each variant fills in. */
const versionOf = (written: string | undefined, scope: Expressions): string | undefined => {
  const filled = written === undefined ? undefined : fill(written, scope)
  const version = filled?.kind === "ok" ? textOf(filled.parts) : undefined
  return version === "" ? undefined : version
}

/** The tools a setup action stands for, as the inventory lists them: with the job that needs them. */
const toolchainsOf = (setup: Setup, uses: string, scope: Expressions, job: Draft): ReadonlyArray<Toolchain> =>
  setup.tools.map((tool) => {
    const entry = { name: tool.name, source: job.file, job: job.id, action: uses }
    const version = versionOf(tool.version, scope)
    return version === undefined ? entry : { ...entry, version }
  })

/** Job keys that change what runs and cannot be reproduced from a command. */
const jobFeatures: ReadonlyMap<string, string> = new Map([
  ["services", "runs service containers"],
  ["container", "runs inside a container"],
  ["environment", "deploys to an environment"],
  ["continue-on-error", "may fail without failing the workflow"]
])

interface Triggers {
  readonly triggers: ReadonlyArray<string>
  readonly filters: ReadonlyArray<string>
  /** Set when the only change that starts the workflow is a push of a tag. */
  readonly release: string | undefined
}

const readTriggers = (on: unknown): Triggers => {
  if (!isRecord(on)) return { triggers: asStrings(on) ?? [], filters: [], release: undefined }
  const filters = Object.entries(on).flatMap(([event, config]) => {
    const keys = isRecord(config)
      ? Object.keys(config).filter((key) => /^(?:(?:branches|tags|paths)(?:-ignore)?|types|workflows)$/.test(key))
      : []
    return keys.length === 0 ? [] : [`${event} runs only for matching ${keys.join(", ")}`]
  })
  // GitHub runs a push with `tags` and no `branches` for tags only.
  const push = on["push"]
  const tagsOnly = isRecord(push) && push["tags"] !== undefined
    && push["branches"] === undefined && push["branches-ignore"] === undefined
  const others = Object.keys(on).filter((event) => event !== "push" && changeTriggers.includes(event))
  return {
    triggers: Object.keys(on),
    filters,
    release: tagsOnly && others.length === 0 ? "push runs only for tags" : undefined
  }
}

/** The scopes a `permissions` value lets a job write, such as `contents` or `id-token`. */
const writeScopes = (permissions: unknown): ReadonlyArray<string> => {
  if (permissions === "write-all") return ["every scope"]
  if (!isRecord(permissions)) return []
  return Object.entries(permissions).flatMap(([scope, level]) => level === "write" ? [scope] : [])
}

const readDefaults = (owner: Record<string, unknown>, parent: RunDefaults): RunDefaults => {
  const defaults = owner["defaults"]
  const run = isRecord(defaults) ? defaults["run"] : undefined
  return isRecord(run)
    ? { shell: run["shell"] ?? parent.shell, cwd: run["working-directory"] ?? parent.cwd }
    : parent
}

/** A step as later steps see it, from how it is known to run. */
const recordOf = (
  ran: Condition,
  outputs: Context,
  outcome: (() => Context) | undefined
): StepRecord => {
  if (ran.kind === "never") return { outputs: fields(() => undefined), outcome: value("skipped") }
  if (ran.kind === "always") return { outputs, outcome: value("success") }
  const unread = unknown("how a step ended is known only when its condition is")
  return {
    outputs: ran.kind === "problem" ? unread : outputs,
    outcome: outcome === undefined || ran.kind === "problem" ? unread : outcome()
  }
}

/** What one step is read with: where it is, its variables, and how it runs. */
interface StepContext {
  readonly state: JobState
  readonly scope: StepScope
  readonly where: string
  readonly key: string
  readonly name: string | undefined
  readonly env: Env
  readonly reads: Expressions
  readonly ran: Condition & { readonly kind: "always" | "when" }
  readonly limit: number | undefined
  /** True for a step that keeps files from one run to the next, as a cache step does. */
  readonly store?: boolean
  /** The step's name as a runner gives it in `GITHUB_ACTION`. */
  readonly action: string
}

/** Adds a command to the job, with the runner text that runs it as its step. */
const addRun = (
  context: StepContext,
  script: Entry,
  start: ReadonlyArray<string>,
  cwd: string,
  directory?: Entry
): void => {
  const { env, state, where } = context
  const { job } = state
  const fills = new Map<string, Residual>()
  const command = script.map((part) => {
    const key = matrixKey(part)
    if (typeof part === "string") return part
    if (key !== undefined) return `\${{ matrix.${key} }}`
    fills.set(part.written, part.residual)
    return part.written
  }).join("")

  const inAction = context.scope.actionPath
  const given = new Set([
    ...Object.keys(state.runner.variables),
    ...startedVariables,
    ...env.entries.keys(),
    ...(inAction === undefined ? [] : [actionPathVariable])
  ])
  const missing = [...new Set(command.match(/\b(?:GITHUB|RUNNER)_[A-Z0-9_]+\b/g))].filter((name) => !given.has(name))
  if (missing.length > 0) return note(job, "runner-variable", `${where} reads ${missing.join(", ")}`)
  // A variable a setup action sets on GitHub, such as GOROOT, is not set here. One a runner has anyway, such as
  // JAVA_HOME, is this machine's (`Inventory.runnerSoftware`).
  const unset = [...state.setupNames].filter((name) =>
    !runnerSoftware.includes(name) && !env.entries.has(name) && new RegExp(`\\$\\{?${name}\\b`).test(command)
  )
  if (unset.length > 0) {
    return note(job, "runner-variable", `${where} reads ${unset.join(", ")}, which a setup action sets on GitHub`)
  }

  const fixedEnv = new Map<string, string>()
  // A step of an action is told where the action is.
  const decided: Array<readonly [string, Entry, boolean]> = inAction === undefined
    ? []
    : [[
      actionPathVariable,
      [{ residual: { kind: "variable", variable: actionDirectory(inAction) }, written: "" }],
      true
    ]]
  for (const [name, entry] of env.entries) {
    const text = textOf(entry)
    if (text !== undefined) fixedEnv.set(name, text)
    else if (identifier.test(name)) decided.push([name, entry, env.own.has(name)])
    else return note(job, "expression", `${where} sets ${name}, a name a shell cannot hold, while the job runs`)
  }
  // A step that only installs packages is left out of a replay on a machine that has them
  // (`MachineChanges.withInstalled`). So it takes no place among the job's steps: the others are the first, the
  // second and the rest with it or without it.
  const apart = installsOf(command) !== undefined
  const first = state.placed === 0
  const keeps = state.keeps.splice(0)
  // Every step is told its job, the first one too: a runner gives `GITHUB_JOB` to every step, and a job's steps
  // are its own, as each job has a machine of its own on GitHub.
  const facts: StepFacts = {
    key: context.key,
    after: first ? undefined : state.mark,
    second: false,
    apart,
    job: state.key,
    before: [...state.keys],
    cwd,
    directory,
    start,
    own: [...env.own].filter((name) => identifier.test(name)),
    keeps,
    condition: context.ran.kind === "when" ? context.ran.residual : undefined,
    outer: decided.filter(([, , own]) => !own).map(([name, entry]) => [name, entry] as const),
    env: decided.filter(([, , own]) => own).map(([name, entry]) => [name, entry] as const),
    fills: [...fills],
    commit: /\bGITHUB_(?:SHA|WORKFLOW_SHA|EVENT_PATH|RUN_ID|RUN_NUMBER|RUN_ATTEMPT)\b/.test(command),
    ownCi: env.entries.has("CI"),
    action: context.action,
    limit: secondsOf(context.limit),
    store: context.store
  }
  const written = write(state.runner, facts, command)
  if ("problem" in written) return note(job, "expression", `${where}: ${written.problem}`)
  const before = job.steps.length
  addStep(job, {
    where,
    command,
    cwd,
    env: fixedEnv,
    secrets: env.secrets,
    secretEnv: env.secretEnv,
    name: context.name,
    runner: written.text
  })
  if (job.steps.length > before) {
    state.ran = true
    state.apart = apart
    if (apart) return
    if (first) {
      state.mark = written.mark
      state.only = { at: before, text: written.alone }
    }
    state.placed += 1
    state.keys.push(context.key)
  }
}

const noDefaults: RunDefaults = { shell: undefined, cwd: undefined }

const readRun = (context: StepContext, raw: Record<string, unknown>, run: string): void => {
  const { reads, state, where } = context
  const { job, windowsOnly } = state
  // "Creating a composite action": a step of an action names its own shell, and runs in the repository root
  // unless it names a directory. The job's `defaults.run` do not reach it.
  const defaults = context.scope.actionPath === undefined ? state.defaults : noDefaults
  const rawShell = raw["shell"] ?? defaults.shell
  if (rawShell !== undefined && typeof rawShell !== "string") {
    return note(job, "shell", `${where} names its shell with a value that is not text`)
  }
  const start = shellStart(rawShell)
  if (start === undefined) return note(job, "shell", `${where} runs in ${rawShell}`)
  if (rawShell === undefined && windowsOnly) return note(job, "shell", `${where} runs in PowerShell on Windows`)

  const script = fill(run, reads)
  if (script.kind !== "ok") {
    return note(
      job,
      "expression",
      `${where} depends on ${script.kind === "secret" ? `secret ${script.name}` : script.why}`
    )
  }
  const rawCwd = asScalar(raw["working-directory"] ?? defaults.cwd ?? "")
  if (rawCwd === undefined) return note(job, "working-directory", `${where} has a directory that is not text`)
  const place = readCwd(rawCwd, state.matrix, reads)
  if ("problem" in place) return note(job, "working-directory", `${where}: ${place.problem}`)
  addRun(context, script.parts, start, place.cwd, place.directory)
}

/** True for an expression whose value a later step of the job can change: a variable, or a hash of files. */
const changes = (residual: Residual): boolean => {
  if (residual.kind === "variable") return /^(?:env|process|hash):/.test(residual.variable.id)
  if (residual.kind === "literal") return false
  if (residual.kind === "not") return changes(residual.operand)
  return residual.kind === "call" ? residual.args.some(changes) : changes(residual.left) || changes(residual.right)
}

/**
 * What a value given to an action or a called workflow stands for, under its input's name. A value written out
 * under a name that says it is a secret is one, as it is for a variable.
 */
const inputOf = (name: string, text: string, scope: Expressions): Context => {
  const found = contextOf(fill(text, scope))
  return found.kind === "value" && typeof found.value === "string" && isLiteralSecret(name, found.value)
    ? { kind: "secret", name }
    : found
}

const readComposite = (context: StepContext, raw: Record<string, unknown>, uses: string): Context | undefined => {
  const { reads, scope, state, where } = context
  const { job } = state
  const directory = normalizeDirectory(uses)
  state.actions += 1
  const text = directory === undefined || scope.depth >= 8 || state.actions > maxActions
    ? undefined
    : state.facts.read?.(`${directory}/action.yml`) ?? state.facts.read?.(`${directory}/action.yaml`)
  if (text === undefined) return void note(job, "uses", `${uses} has no command to run`)
  const action = readAction(text)
  if ("problem" in action) return void note(job, "uses", `${uses}: ${action.problem}`)
  const given = new Map(
    (isRecord(raw["with"]) ? Object.entries(raw["with"]) : []).map(([name, held]) =>
      [name.toLowerCase(), asScalar(held)] as const
    )
  )
  // "Contexts: inputs": the values are worked out when the action starts. One that a step of the action could
  // change by then, such as a variable, is worked out once by the next command and kept for the rest.
  const values = new Map<string, Context>()
  for (const name of new Set([...action.inputs.keys(), ...given.keys()])) {
    const found = inputOf(name, given.get(name) ?? action.inputs.get(name) ?? "", reads)
    if (found.kind === "residual" && changes(found.residual)) {
      const kept = `${context.key}.${values.size}`
      state.keeps.push([kept, [{ residual: found.residual, written: "" }]])
      values.set(name, variable(`kept:${kept}`, `inputs.${name}`))
    } else {
      values.set(name, found)
    }
  }
  const inputs = fields((name) => values.get(name))
  const inner: StepScope = {
    env: context.env,
    inputs,
    steps: new Map(),
    prefix: `${context.key}.`,
    condition: context.ran.kind === "when" ? context.ran.residual : undefined,
    actionPath: directory,
    depth: scope.depth + 1,
    where: `${where} >`,
    limit: context.limit
  }
  action.steps.forEach((step, index) => readStep(state, inner, step, index))
  // An output is read after the action's last step, with the action's own steps in reach.
  const after = expressions(state, inputs, { state, scope: inner, env: inner.env })
  return fields((name) => {
    const held = action.outputs.get(name)
    return held === undefined ? undefined : contextOf(fill(held, after))
  })
}

/** The secrets among an action's inputs, by name. The token every job has is none: an action uses it to download. */
const secretsIn = (inputs: unknown, scope: Expressions): ReadonlyArray<string> => {
  const names = (isRecord(inputs) ? Object.values(inputs) : []).flatMap((held) => {
    const filled = fill(asScalar(held) ?? "", scope)
    return filled.kind === "secret" ? [filled.name] : []
  })
  return [...new Set(names)].filter((name) => name !== "GITHUB_TOKEN")
}

/**
 * Reads a cache step as the commands that keep its cache on this machine (`Cache.ts`): one that restores, where
 * the step stands, and for `actions/cache` one that saves, after the job's other steps. `undefined` for a step
 * with no `path` or no `key`, and for one whose inputs cannot be worked out here, such as a key that hashes the
 * files a pattern names: a replay runs nothing for it, and a cache that restores nothing is a miss.
 */
const readCache = (context: StepContext, raw: Record<string, unknown>, uses: string): StepRecord | undefined => {
  const use = cacheUse(uses.split("@")[0] as string, raw["with"])
  return use === undefined ? undefined : keepCache(context, uses, use, "")
}

/**
 * Adds the commands of a cache to the job. `first` is shell text that runs before the restoring script, as a setup
 * action's cache asks its tool where the cache is (`SetupCache.ts`). `known` is the outputs a reader may have of a
 * step that does more than keep a cache; every other one stays unknown, for all the step does is not run here.
 */
const keepCache = (
  context: StepContext,
  uses: string,
  use: CacheUse,
  first: string,
  known?: ReadonlyArray<string>
): StepRecord | undefined => {
  const { state, where } = context
  const { job } = state
  const reads = { ...context.reads, hashFiles: hashFilesForKey }
  if (Object.values(use.env).some((text) => fill(text, reads).kind !== "ok")) return undefined
  const named = { ...context, name: context.name ?? uses, store: true }
  const env = withEnv(context.env, use.env, job, where, reads, true)
  addRun({ ...named, env }, [`${first}${use.kind === "save" ? saveScript : restoreScript}`], cacheShell, "")
  const output = (name: string): Variable => ({
    id: `output:${context.key}/${name.toUpperCase()}`,
    name: `an output of ${where}`,
    nullable: true,
    typed: false
  })
  if (use.kind === "cache") {
    // The saving command is given what the restoring one worked out when the step started, through its outputs.
    const entries = new Map(context.env.entries)
    const own = new Set(context.env.own)
    for (const [name, from] of handedOn) {
      entries.set(name, [{ residual: { kind: "variable", variable: output(from) }, written: "" }])
      own.add(name)
    }
    // It runs whatever the step's condition is by then: with nothing restored it finds no key and saves nothing.
    const post: StepContext = {
      ...named,
      key: `${context.key}.POST`,
      name: `Post ${named.name}`,
      env: { ...context.env, entries, own },
      ran: { kind: "always" }
    }
    state.after.push(() => addRun(post, [saveScript], cacheShell, ""))
  }
  const outputs = fields((name) =>
    known !== undefined && !known.includes(name)
      ? unknown(`an output of ${uses}, which a replay does not run`)
      : /^[a-z0-9_-]+$/.test(name)
      ? { kind: "residual", residual: { kind: "variable", variable: output(name) } }
      : unknown(`an output of ${where} with a name a replay does not keep`)
  )
  return recordOf(context.ran, outputs, () => variable(`outcome:${context.key}`, `how ${where} ended`))
}

const readUses = (context: StepContext, raw: Record<string, unknown>, uses: string): StepRecord => {
  const { ran, reads, state, where } = context
  const { job } = state
  const action = uses.split("@")[0] as string
  const noOutput = unknown(`an output of ${uses}, which a replay does not run`)
  const notRun = fields(() => noOutput)
  if (uses.startsWith("./")) {
    const outputs = readComposite(context, raw, uses)
    return recordOf(outputs === undefined ? { kind: "problem", why: "" } : ran, outputs ?? notRun, undefined)
  }
  const setup = readSetup(uses, raw["with"])
  if (setup !== undefined) {
    // The inventory lists the version as the workflow's own files give it. A replay looks for the tool on the
    // machine before it runs the job (`Tools.ts`): nothing is installed here.
    const listed = expressions(state, context.scope.inputs, {
      state: { ...state, ran: false },
      scope: context.scope,
      env: context.env
    })
    state.toolchains.push(...toolchainsOf(setup, uses, listed, job))
    note(job, hostAction, `${uses} has no command to run`)
    // With a secret the action does what a tool on the machine cannot stand for, such as signing a tool in.
    const received = secretsIn(raw["with"], reads)
    if (received.length > 0) note(job, receivesSecret, `${where}: ${uses} receives ${received.join(", ")}`)
    if (setup.problem !== undefined) note(job, "uses", `${where}: ${uses} ${setup.problem}`)
    for (const entry of setup.tools) {
      for (const name of setupVariables.get(entry.name) ?? []) state.setupNames.add(name)
    }
    // "Caching packages data": a setup action may keep its package manager's cache, as a cache step does.
    const cache = setupCache(uses, raw["with"])
    const kept = cache === undefined ? undefined : keepCache(
      { ...context, key: `${context.key}.CACHE` },
      uses,
      { kind: "cache", env: { [cacheVariables.key]: cache.key, [lockVariable]: cache.lock } },
      `${beforeSetupCache(cache)}\n`,
      ["cache-hit"]
    )
    // An input can make the action run a command too, such as installing what a lockfile names.
    if (setup.command === undefined) return kept ?? recordOf(ran, notRun, undefined)
    addRun({ ...context, name: context.name ?? uses }, [setup.command], ["bash", "-e"], "")
    return recordOf(ran, notRun, () => variable(`outcome:${context.key}`, `how ${where} ended`))
  }
  if (!hostActions.includes(action)) {
    note(job, "uses", `${uses} has no command to run`)
    return recordOf({ kind: "problem", why: "" }, notRun, undefined)
  }
  const kept = readCache(context, raw, uses)
  if (kept !== undefined) return kept
  note(job, hostAction, `${uses} has no command to run`)
  if (action === "actions/checkout") {
    const read = (text: string): string | Residual | undefined => {
      const filled = fill(text, reads)
      if (filled.kind !== "ok") return undefined
      const [only] = filled.parts
      return filled.parts.length === 1 && only !== undefined && typeof only !== "string"
        ? only.residual
        : textOf(filled.parts)
    }
    for (const problem of checkoutProblems(raw["with"], state.facts.repository, read)) {
      note(job, "checkout", `${where} ${problem}`)
    }
  }
  // A cache step with no path or no key restores nothing, and reports a miss.
  const outputs = cacheActions.includes(action) ? fields((name) => name === "cache-hit" ? value("") : noOutput) : notRun
  return recordOf(ran, outputs, undefined)
}

const readStep = (state: JobState, scope: StepScope, raw: unknown, index: number): void => {
  const { job } = state
  const number = index + 1
  if (!isRecord(raw)) return note(job, "malformed-step", `step ${number} of ${scope.where} is not a mapping`)
  const stepName = typeof raw["name"] === "string" ? raw["name"] : undefined
  const where = `${scope.where} step ${number}${stepName === undefined ? "" : ` (${stepName})`}`
  const id = typeof raw["id"] === "string" ? raw["id"] : undefined
  // A step with no id is named by its place. An id never starts with a dash, so the two never meet.
  const key = `${scope.prefix}${id ?? `-${number}`}`.toUpperCase().replace(/[^A-Z0-9_.-]/g, "_")
  const outer = expressions(state, scope.inputs, { state, scope, env: scope.env })
  const uses = raw["uses"]
  // A step's own variables are set before its condition is read. Those of a step that uses an action a replay
  // does not run reach nothing but that condition, so one that cannot be read is no reason to leave the job out.
  const local = typeof uses !== "string" || uses.startsWith("./")
  const unheard = draft({ id: job.id, source, file: job.file, name: job.name })
  const env = withEnv(scope.env, raw["env"], local ? job : unheard, where, outer, true)
  const own = expressions(state, scope.inputs, { state, scope, env })
  const record = (found: StepRecord): void => {
    if (id !== undefined) scope.steps.set(id.toLowerCase(), found)
  }
  const unread = recordOf({ kind: "problem", why: "" }, unknown(""), undefined)

  const ran = within(scope.condition, readCondition(raw["if"], own))
  if (ran.kind === "never") {
    note(
      job,
      conditionFalse,
      `${where} is left out: ${shown(raw["if"])} is false for ${eventName(state.event, state.facts)}`
    )
    return record(recordOf(ran, unknown(""), undefined))
  }
  if (ran.kind === "problem") {
    note(job, "condition", `${where} runs only if ${shown(raw["if"])}: ${ran.why}`)
    return record(unread)
  }
  const tolerated = raw["continue-on-error"]
  if (tolerated !== undefined && readCondition(tolerated, own).kind !== "never") {
    note(job, "continue-on-error", `${where} may fail without failing the job`)
  }
  // "Workflow syntax: jobs.<job_id>.steps[*].timeout-minutes": the most minutes the step runs before it is stopped.
  const limit = readLimit(raw["timeout-minutes"], own)
  if ("problem" in limit) {
    note(job, "expression", `${where} has a timeout-minutes a replay cannot keep: ${limit.problem}`)
    return record(unread)
  }
  const context: StepContext = {
    state,
    scope,
    where,
    key,
    name: stepName,
    env,
    reads: own,
    ran,
    limit: withinLimit(scope.limit, limit.minutes),
    // "Default environment variables": a step's `id`, or `__run` with the place of a script that has none.
    action: id ?? (number === 1 ? "__run" : `__run_${number}`)
  }
  if (typeof uses === "string") return record(readUses(context, raw, uses))
  const run = raw["run"]
  if (typeof run !== "string") {
    note(job, "malformed-step", `${where} has neither run nor uses`)
    return record(unread)
  }
  const before = job.steps.length
  readRun(context, raw, run)
  if (job.steps.length === before) return record(unread)
  // Nothing may depend on a step a replay leaves out when the machine has its packages.
  if (state.apart) {
    const left = unknown(`what ${where} gave: a step that only installs packages is left out when they are there`)
    return record({ outputs: left, outcome: left })
  }
  const outputs = fields((name) =>
    /^[a-z0-9_-]+$/.test(name)
      ? variable(`output:${key}/${name.toUpperCase()}`, `steps.${id}.outputs.${name}`, true)
      : unknown(`steps.${id}.outputs.${name} has a name a replay does not keep`)
  )
  record(recordOf(ran, outputs, () => variable(`outcome:${key}`, `steps.${id}.outcome`)))
}

/**
 * True when every run of the job is on Windows, once each variant fills in its runner. A step of such a job that
 * names no shell is PowerShell text. A job with a variant on another system is read as that variant runs it: its
 * Windows variants are left out one by one where the job is replayed (`Inventory.otherSystem`), never the job.
 */
const windowsOnly = (runsOn: string | undefined, matrix: Matrix): boolean => {
  if (runsOn === undefined) return false
  const names = matrix.variants.length === 0 ? [runsOn] : matrix.variants.map((variant) => expand(runsOn, variant))
  return names.every((name) => hostOf(name) === "win32")
}

/** The system every run of the job is on, or `undefined` when the variants differ or none is named. */
const hostOfJob = (runsOn: string | undefined, matrix: Matrix): Host | undefined => {
  if (runsOn === undefined) return undefined
  const hosts = new Set(
    (matrix.variants.length === 0 ? [{}] : matrix.variants).map((variant) => hostOf(expand(runsOn, variant)))
  )
  const [only] = hosts
  return hosts.size === 1 ? only : undefined
}

/** GitHub reads a matrix key a variant lacks as empty, so a variant must say so. */
const fillReferencedKeys = (job: Draft, matrix: Matrix): Draft => {
  // The line that names a job's state holds every key, to tell the variants apart: it reads none of them.
  const texts = [
    job.runsOn ?? "",
    ...job.steps.flatMap((step) => [
      step.command,
      step.cwd,
      // Every step read from a workflow has runner text.
      String(step.runner).replace(/^__m=.*$/gm, ""),
      ...Object.values(step.env)
    ])
  ]
  const used = texts.flatMap(matrixReferences).filter((key) => matrix.keys.has(key))
  return {
    ...job,
    matrix: matrix.variants.map((variant) => ({
      ...variant,
      ...Object.fromEntries(used.filter((key) => !Object.hasOwn(variant, key)).map((key) => [key, ""]))
    }))
  }
}

/** The matrix keys whose value is text in every variant, read from the matrix as written. */
const textKeysOf = (raw: unknown, matrix: Matrix): ReadonlySet<string> => {
  // A matrix that was read has a list for each key, and mappings under `include`.
  if (!isRecord(raw) || matrix.problem !== undefined) return new Set()
  const { exclude: _exclude, include = [], ...lists } = raw as Record<string, ReadonlyArray<unknown>>
  const written = new Map<string, Array<unknown>>()
  const add = (key: string, held: unknown): void => void written.set(key, [...(written.get(key) ?? []), held])
  for (const [key, values] of Object.entries(lists)) for (const held of values) add(key, held)
  for (const entry of include as ReadonlyArray<Record<string, unknown>>) {
    for (const [key, held] of Object.entries(entry)) add(key, held)
  }
  return new Set(
    [...written].filter(([key, values]) =>
      values.every((held) => typeof held === "string") &&
      matrix.variants.every((variant) => Object.hasOwn(variant, key))
    ).map(([key]) => key)
  )
}

interface WorkflowContext {
  readonly file: string
  /** What starts the id of each job: `ci.yml:`, or the calling job's id and a slash. */
  readonly prefix: string
  readonly name: string
  readonly facts: Facts
  readonly event: Event | undefined
  readonly triggers: ReadonlyArray<string>
  readonly filters: ReadonlyArray<string>
  readonly release: string | undefined
  /** The scopes the workflow's `permissions` let every job write. */
  readonly writes: ReadonlyArray<string>
  readonly env: Env
  readonly inputs: Context
  readonly defaults: RunDefaults
  readonly toolchains: Array<Toolchain>
  /** What the calling job waits for, and whether it runs, when another workflow calls this one. */
  readonly needs: ReadonlyArray<string>
  readonly called: ReadonlyArray<readonly [feature: string, reason: string]>
  readonly depth: number
}

/** The runner name a `runs-on` value gives: its labels joined, with what is known filled in. */
const readRunsOn = (
  raw: unknown,
  job: { readonly name: string },
  scope: Expressions,
  problems: Array<[string, string]>
): { readonly runsOn?: string } => {
  if (raw === undefined) return {}
  const expression = typeof raw === "string" ? whole(raw) : undefined
  const evaluated = expression === undefined ? undefined : evaluate(expression, scope)
  const held = evaluated?.kind === "ok" && evaluated.residual.kind === "literal" ? evaluated.residual.value : raw
  const labels = asStrings(held)
  if (labels === undefined) {
    problems.push(["runner", `${job.name} picks its runner by group`])
    return {}
  }
  const filled = labels.map((label) => {
    const parts = fill(label, scope)
    const text = parts.kind === "ok" ? textOf(parts.parts) : undefined
    if (text === undefined) problems.push(["runner", `${job.name} picks its runner from ${whole(label) ?? label}`])
    return text ?? label
  })
  return { runsOn: filled.join(",") }
}

/** True when a variable named like a secret takes its value from the matrix, which would hold it in plain text. */
const matrixHoldsSecret = (raw: Record<string, unknown>, matrix: Matrix): boolean => {
  const steps: ReadonlyArray<unknown> = Array.isArray(raw["steps"]) ? raw["steps"] : []
  return [raw["env"], ...steps.map((step) => (isRecord(step) ? step["env"] : undefined))].some((block) =>
    isRecord(block) && Object.entries(block).some(([name, value]) =>
      isSecretName(name) && typeof value === "string"
      && matrixReferences(value).some((key) => matrix.keys.has(key))
    )
  )
}

/** The values a calling job gives a workflow it calls, with the defaults the workflow declares. */
const calledInputs = (declared: unknown, given: unknown, scope: Expressions): Context => {
  const known = new Map<string, Context>()
  const lower = (raw: unknown): ReadonlyMap<string, unknown> =>
    new Map(isRecord(raw) ? Object.entries(raw).map(([name, held]) => [name.toLowerCase(), held] as const) : [])
  const [inputs, values] = [lower(declared), lower(given)]
  const read = (name: string, held: unknown): Context => {
    if (typeof held !== "string") return value(typeof held === "number" || typeof held === "boolean" ? held : null)
    const expression = whole(held)
    const evaluated = expression === undefined ? undefined : evaluate(expression, scope)
    // One expression keeps its type, as a workflow's typed input does.
    if (evaluated?.kind === "ok") return { kind: "residual", residual: evaluated.residual }
    return inputOf(name, held, scope)
  }
  // "Workflow syntax: on.workflow_call.inputs": an input given no value and no default is `false` for a boolean,
  // `0` for a number and empty for a string.
  const unset = (input: unknown): Context => {
    const type = isRecord(input) ? input["type"] : undefined
    return value(type === "boolean" ? false : type === "number" ? 0 : "")
  }
  return fields((name) => {
    const input = inputs.get(name)
    if (input === undefined && !values.has(name)) return undefined
    const written = values.has(name) ? values.get(name) : isRecord(input) ? input["default"] : undefined
    const found = known.get(name) ?? (written === undefined || written === null ? unset(input) : read(name, written))
    known.set(name, found)
    return found
  })
}

const readJob = (workflow: WorkflowContext, key: string, raw: unknown): ReadonlyArray<Draft> => {
  const { file, prefix, triggers } = workflow
  const id = `${prefix}${key}`
  if (!isRecord(raw)) {
    const job = draft({ id, source, file, name: key, triggers })
    note(job, "malformed-job", `job ${key} is not a mapping`)
    return [job]
  }
  const name = typeof raw["name"] === "string" ? raw["name"] : key
  const problems: Array<[string, string]> = []
  const needs = asStrings(raw["needs"] ?? [])
  if (needs === undefined) problems.push(["malformed-job", `${name} has a needs value that is not a job list`])
  const strategy = raw["strategy"]
  const rawMatrix = isRecord(strategy) ? strategy["matrix"] : undefined
  const expanded = expandMatrix(rawMatrix)
  const matrix = matrixHoldsSecret(raw, expanded)
    ? { ...noMatrix, problem: "a variable named like a secret reads it" }
    : expanded
  const shape: Shape = {
    facts: workflow.facts,
    event: workflow.event,
    key,
    workflow: workflow.name,
    matrix,
    textKeys: textKeysOf(rawMatrix, matrix)
  }
  const before = expressions(shape, workflow.inputs)
  const job = draft({
    id,
    source,
    file,
    name,
    needs: [...(needs ?? []).map((need) => `${prefix}${need}`), ...workflow.needs],
    triggers,
    ...readRunsOn(raw["runs-on"], { name }, before, problems)
  })
  for (const [feature, reason] of [...problems, ...workflow.called]) note(job, feature, reason)
  for (const filter of workflow.filters) note(job, triggerFilter, filter)
  if (workflow.release !== undefined) note(job, releaseTrigger, workflow.release)
  // A job's own `permissions` replace the workflow's.
  const writes = raw["permissions"] === undefined ? workflow.writes : writeScopes(raw["permissions"])
  if (writes.length > 0) note(job, writePermission, `${name} may write ${writes.join(", ")}`)
  if (matrix.problem !== undefined) note(job, "matrix", `${name}: ${matrix.problem}`)
  if (strategy !== undefined && !isRecord(strategy)) {
    note(job, "matrix", `${name}: its strategy is computed when the workflow runs`)
  }
  const runs = readCondition(raw["if"], before)
  const event = eventName(workflow.event, workflow.facts)
  if (runs.kind === "never") note(job, "condition", `${name} is left out: ${shown(raw["if"])} is false for ${event}`)
  else if (runs.kind !== "always") {
    const why = runs.kind === "problem" ? runs.why : "it is decided while the job runs"
    note(job, "condition", `${name} runs only if ${shown(raw["if"])}: ${why}`)
  }
  for (const [jobKey, reason] of jobFeatures) {
    if (raw[jobKey] !== undefined) note(job, jobKey, `${name} ${reason}`)
  }

  const uses = raw["uses"]
  if (typeof uses === "string") {
    const jobs = readCalled(workflow, job, raw, uses, before, writes)
    return jobs ?? (note(job, "uses", `${uses} is a reusable workflow; its jobs were not read`), [job])
  }
  const steps: unknown = raw["steps"]
  if (!Array.isArray(steps)) {
    note(job, "malformed-job", `${name} has no list of steps`)
    return [job]
  }
  // "Workflow syntax: jobs.<job_id>.timeout-minutes": the most minutes the job runs before GitHub cancels it.
  const limit = readLimit(raw["timeout-minutes"], before)
  if ("problem" in limit) {
    note(job, "expression", `${name} has a timeout-minutes a replay cannot keep: ${limit.problem}`)
  }
  const host = hostOfJob(job.runsOn, matrix)
  const place = { job: key, workflow: workflow.name, file: workflow.file }
  const state: JobState = {
    ...shape,
    file,
    job,
    host,
    defaults: readDefaults(raw, workflow.defaults),
    windowsOnly: windowsOnly(job.runsOn, matrix),
    toolchains: workflow.toolchains,
    runner: {
      id,
      matrixKeys: [...matrix.keys].sort(),
      variants: matrix.variants,
      variables: variables(workflow.event, workflow.facts, place),
      standIns: standIns(workflow.event, workflow.facts, place),
      event: eventFile(workflow.event, workflow.facts),
      eventName: workflow.event
    },
    ran: false,
    placed: 0,
    keys: [],
    apart: false,
    mark: undefined,
    only: undefined,
    setupNames: new Set(),
    keeps: [],
    actions: 0,
    after: []
  }
  const scope: StepScope = {
    env: withEnv(workflow.env, raw["env"], job, name, before, false),
    inputs: workflow.inputs,
    steps: new Map(),
    prefix: "",
    condition: undefined,
    actionPath: undefined,
    depth: 0,
    where: name,
    limit: "problem" in limit ? undefined : limit.minutes
  }
  steps.forEach((step: unknown, index) => readStep(state, scope, step, index))
  // "Metadata syntax: runs.post": what an action runs after the job's steps, the last action's first.
  for (const run of state.after.reverse()) run()
  // A command no other command follows is told so: no later step reads what it leaves. A step a replay may
  // leave out, before it, is no reader of it.
  const only = state.only === undefined ? undefined : job.steps[state.only.at]
  if (state.placed === 1 && only !== undefined && state.only?.at === job.steps.length - 1) {
    job.steps[state.only.at] = { ...only, runner: state.only.text }
  }
  // A step's runner text holds its command, and each matrix value it names, in quotes, which a matrix value with a
  // quote would end. The line that names the job's state names every key.
  const quoted = job.steps.flatMap((step) => [step.command, step.cwd, String(step.runner)]).flatMap(matrixReferences)
  if (matrix.variants.some((variant) => quoted.some((used) => variant[used]?.includes("'")))) {
    note(job, "shell", `${name} puts a matrix value holding a quote into a script`)
  }
  return [fillReferencedKeys(job, matrix)]
}

/**
 * Reads the jobs of a workflow in this repository that a job calls. The
 * calling job stays as a job with no step that needs them, so a job that
 * needs it waits for them all. `undefined` when the workflow cannot be read.
 */
const readCalled = (
  workflow: WorkflowContext,
  job: Draft,
  raw: Record<string, unknown>,
  uses: string,
  scope: Expressions,
  writes: ReadonlyArray<string>
): ReadonlyArray<Draft> | undefined => {
  // A matrix of calls runs the workflow once per variant, each with its own values: that is not read here.
  const path = uses.startsWith("./") && raw["strategy"] === undefined ? normalizeDirectory(uses) : undefined
  const text = path === undefined || workflow.depth >= 4 ? undefined : workflow.facts.read?.(path)
  const parsed = text === undefined ? undefined : parseYaml(text)
  const called = parsed !== undefined && "value" in parsed ? leaveCacheEmpty(parsed.value) : undefined
  const on = isRecord(called) ? called["on"] : undefined
  const call = isRecord(on) ? on["workflow_call"] : undefined
  if (
    path === undefined || !isRecord(called) || !isRecord(called["jobs"]) || !isRecord(on) || !("workflow_call" in on)
  ) {
    return undefined
  }
  const holder = draft({ id: job.id, source, file: path, name: job.name })
  const inputs = calledInputs(isRecord(call) ? call["inputs"] : undefined, raw["with"], scope)
  const context: WorkflowContext = {
    ...workflow,
    file: path,
    prefix: `${job.id}/`,
    // The calling workflow's variables do not reach a workflow it calls.
    env: withEnv(noEnv, called["env"], holder, "the workflow", expressions(outside(workflow), inputs), false),
    inputs,
    defaults: readDefaults(called, { shell: undefined, cwd: undefined }),
    // "Reusing workflows: Access and permissions": a called workflow can write what its calling job can and what
    // its own `permissions` keep of that, never more.
    writes: called["permissions"] === undefined || writes.length === 0 ? writes : writeScopes(called["permissions"]),
    needs: job.needs,
    // What keeps the calling job out keeps every job it calls out.
    called: job.unsupported.filter((entry) => entry.feature === "condition" || entry.feature === "malformed-job")
      .map((entry) => [entry.feature, entry.detail.slice(entry.detail.indexOf(": ") + 2)] as const),
    depth: workflow.depth + 1
  }
  const jobs = Object.entries(called["jobs"]).flatMap(([key, entry]) => inherit(readJob(context, key, entry), holder))
  return [{ ...job, needs: jobs.map((entry) => entry.id) }, ...jobs]
}

/** Copies what is wrong with a workflow's own variables onto each of its jobs, once. */
const inherit = (jobs: ReadonlyArray<Draft>, holder: Draft): ReadonlyArray<Draft> => {
  for (const job of jobs) {
    for (const entry of holder.unsupported) {
      if (!job.unsupported.some((held) => held.feature === entry.feature && held.detail === entry.detail)) {
        job.unsupported.push(entry)
      }
    }
  }
  return jobs
}

/** What an expression outside any job reads, such as one in the workflow's own `env:`. */
const outside = (workflow: Pick<WorkflowContext, "event" | "facts" | "name">): Shape => ({
  facts: workflow.facts,
  event: workflow.event,
  key: "",
  workflow: workflow.name,
  matrix: noMatrix,
  textKeys: new Set()
})

/**
 * Reads a workflow. A file that is not a workflow adds no jobs, only the
 * reason. `facts` says what the repository is and gives the files a step or
 * job names: without them an expression that reads the repository's name or
 * its default branch, and a step that uses a local action, leave their job
 * out.
 *
 * @category readers
 * @since 0.1.0
 * @throws {never}
 */
export const readWorkflow = (file: string, text: string, facts: Facts = {}): Parsed => {
  const base = file.slice(file.lastIndexOf("/") + 1)
  const parsed = parseYaml(text)
  if ("problem" in parsed) return fileProblem(file, "malformed-file", parsed.problem)
  // A remote build cache's credentials are left empty, as they are for a pull request from a fork.
  const workflow = leaveCacheEmpty(parsed.value)
  if (!isRecord(workflow) || !isRecord(workflow["jobs"])) {
    return fileProblem(file, "malformed-file", "it has no jobs mapping")
  }
  const { filters, release, triggers } = readTriggers(workflow["on"])
  const toolchains: Array<Toolchain> = []
  const holder = draft({ id: base, source, file, name: base })
  const name = typeof workflow["name"] === "string" ? workflow["name"] : file
  const on: unknown = workflow["on"]
  const event = eventOf(
    isRecord(on) ? on : Object.fromEntries(triggers.map((trigger) => [trigger, null])),
    facts.defaultBranch
  )
  // A push, a pull request and a merge group give a workflow no inputs: each reads as `null`.
  const inputs = fields(() => undefined)
  const context: WorkflowContext = {
    file,
    prefix: `${base}:`,
    name,
    facts,
    event,
    triggers,
    filters,
    release,
    writes: writeScopes(workflow["permissions"]),
    env: withEnv(
      noEnv,
      workflow["env"],
      holder,
      "the workflow",
      expressions(outside({ event, facts, name }), inputs),
      false
    ),
    inputs,
    defaults: readDefaults(workflow, { shell: undefined, cwd: undefined }),
    toolchains,
    needs: [],
    called: [],
    depth: 0
  }
  const jobs = Object.entries(workflow["jobs"]).flatMap(([key, job]) => inherit(readJob(context, key, job), holder))
  return { jobs, toolchains, unsupported: [] }
}
