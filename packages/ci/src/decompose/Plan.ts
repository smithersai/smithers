/**
 * Decides what one CI step becomes: one step per package, the same step
 * with its inputs named, or the step as it was.
 *
 * A step is narrowed only when every command in it is understood. One
 * command that runs a task over several packages is replaced by one command
 * per package. Anything else keeps its command and gains the union of what
 * its commands read. A step with a command nothing here recognizes is
 * returned whole.
 *
 * @since 0.1.0
 */

import type { Closure } from "../contract/Closure.ts"
import { isComplete } from "../contract/Closure.ts"
import { type Job, type Step, treeOrder } from "../contract/Inventory.ts"
import { executorOf, type Invocation, type Known, type Pattern, recognize, turbo } from "./Runners.ts"
import { type Command, commands, quote } from "./Shell.ts"
import { type Config, defines, rootRuns, walk } from "./Turbo.ts"
import type { Graph, Package, Reach, Workspace } from "./Workspace.ts"

/**
 * One script run found in a step.
 *
 * - `replace`: where its words sit in the step's command, when they can be
 *   replaced by a per-package command.
 * - `before`: text a replacement starts with, the assignments of a root
 *   script's own command.
 *
 * @category models
 * @since 0.1.0
 */
export interface Run {
  readonly invocation: Invocation
  readonly replace: readonly [start: number, end: number] | undefined
  readonly before: string
}

/**
 * Every command of a step, understood: its script runs and the Zig build
 * steps it runs. Every other command in it reads no file.
 *
 * @category models
 * @since 0.1.0
 */
export interface Understood {
  readonly runs: ReadonlyArray<Run>
  readonly zig: ReadonlyArray<string>
}

/**
 * What a step becomes.
 *
 * @category models
 * @since 0.1.0
 */
export type Decision =
  | { readonly kind: "whole" }
  | { readonly kind: "scope"; readonly inputs: ReadonlyArray<string> }
  | { readonly kind: "split"; readonly parts: ReadonlyArray<Part> }

/**
 * One package's share of a split step.
 *
 * @category models
 * @since 0.1.0
 */
export interface Part {
  readonly name: string
  readonly command: string
  readonly inputs: ReadonlyArray<string>
}

/**
 * What the decision is made from. `turbo` is `undefined` when the
 * repository has no readable Turborepo configuration.
 *
 * @category models
 * @since 0.1.0
 */
export interface Facts {
  readonly workspace: Workspace
  readonly graph: Graph
  readonly turbo: Config | undefined
}

/**
 * The glob that names every file of the repository.
 *
 * @category constants
 * @since 0.1.0
 */
export const everything = "**"

const settings = /^[-+][A-Za-z]+$/
const fileTest = /^-(?:[a-mo-yA-Z]|nt|ot|ef)$/
// A variable a package manager reads as a setting, such as `npm_config_workspaces`.
const setting = /^(?:npm|pnpm)_config_/i
const shells = new Set(["bash", "sh"])
const shellFlags = /^(?:--noprofile|--norc|[-+][eux]+o?|pipefail)$/

// True for a command that reads no file of the repository.
const inert = (command: Command, words: ReadonlyArray<string>): boolean => {
  const [head, ...rest] = words
  switch (head) {
    case undefined:
    case ":":
    case "true":
    case "echo":
    case "printf":
    case "wait":
      return true
    case "set":
      return rest.every((word, index) => settings.test(word) || /^[-+][A-Za-z]*o$/.test(rest[index - 1] ?? ""))
    case "exit":
      return rest.length <= 1
    case "export":
      return rest.every((word) => /^[A-Za-z_][A-Za-z0-9_]*(?:=|$)/.test(word))
    case "[":
    case "[[":
    case "test":
      return !rest.some((word) => fileTest.test(word))
    case "tee":
      return command.joint === "|"
    default:
      return false
  }
}

// The inner script of `bash -c '<script>'`, when the command is only that.
const innerScript = (command: Command): string | undefined => {
  const words = command.words
  const flag = words.findIndex((word) => word.text === "-c")
  if (!shells.has((words[0] as { text: string }).text) || flag < 1 || flag !== words.length - 2) return undefined
  if (!words.slice(1, flag).every((word) => word.literal && shellFlags.test(word.text))) return undefined
  const script = words[flag + 1] as { text: string; literal: boolean }
  return script.literal ? script.text : undefined
}

const zigStep = (words: ReadonlyArray<string>): string | undefined => {
  if (words[0] !== "zig" || words[1] !== "build" || words.length > 3) return undefined
  const step = words[2] ?? "install"
  return step.startsWith("-") ? undefined : step
}

const enter = (cwd: string, directory: string): string | undefined => {
  if (directory.startsWith("/") || directory.startsWith("~") || directory === "-") return undefined
  const parts = cwd === "" ? [] : cwd.split("/")
  for (const segment of directory.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment !== "..") parts.push(segment)
    else if (parts.pop() === undefined) return undefined
  }
  return parts.join("/")
}

// Follows a root script to the command it runs: `pnpm run test` where the
// root's `test` is `turbo run test`. The script must be one plain command
// with no hooks around it, or what it reads is unknown. `extra` holds the
// words the step passes on, which a package manager adds to the command.
const rootScript = (
  workspace: Workspace,
  name: string,
  extra: ReadonlyArray<string>,
  known: Known,
  seen: ReadonlySet<string>
): Run | undefined => {
  const scripts = workspace.rootScripts
  const body = scripts[name]
  if (body === undefined || seen.has(name) || body.includes(">")) return undefined
  if (Object.hasOwn(scripts, `pre${name}`) || Object.hasOwn(scripts, `post${name}`)) return undefined
  const parsed = commands(body)
  const command = parsed?.[0]
  if (parsed?.length !== 1 || command === undefined || command.background) return undefined
  if (command.words.some((word) => !word.literal) || command.assignments.some(([, value]) => !value.literal)) {
    return undefined
  }
  const words = [...command.words.map((word) => word.text), ...extra]
  const before = command.assignments.map(([variable, value]) => `${variable}=${quote(value.text)} `).join("")
  const invocation = words[0] === "turbo"
    ? turbo([...executorOf[workspace.manager], "turbo"], words.slice(1))
    : recognize(words, "", known)
  if (invocation === undefined) return undefined
  if (invocation.selection.kind !== "directory") return { invocation, replace: undefined, before }
  if (invocation.selection.directory !== "") return undefined
  const inner = rootScript(workspace, invocation.tasks[0] as string, invocation.args, known, new Set([...seen, name]))
  return inner === undefined ? undefined : { ...inner, before: `${before}${inner.before}` }
}

const understandList = (
  list: ReadonlyArray<Command>,
  start: string,
  nested: boolean,
  workspace: Workspace | undefined,
  known: Known,
  out: { readonly runs: Array<Run>; readonly zig: Array<string> }
): boolean => {
  let cwd = start
  let entered = false
  for (const command of list) {
    const words = command.words.map((word) => word.text)
    // After `cd a || b`, `b` runs where the `cd` did not go.
    if (entered && command.joint === "||") return false
    entered = false
    // A setting given as a variable can change which packages every later command runs in.
    const assigned = [...command.assignments.map(([name]) => name), ...(words[0] === "export" ? words.slice(1) : [])]
    if (assigned.some((name) => setting.test(name))) return false
    if (inert(command, words)) continue
    const literal = command.words.every((word) => word.literal)
    const plain = !command.conditional && !command.piped && !command.background && command.joint !== "|"
    if (words[0] === "cd") {
      const next = words.length === 2 && literal && plain ? enter(cwd, words[1] as string) : undefined
      if (next === undefined) return false
      cwd = next
      entered = true
      continue
    }
    const script = innerScript(command)
    if (script !== undefined) {
      const inner = commands(script)
      if (inner === undefined || !understandList(inner, cwd, true, workspace, known, out)) return false
      continue
    }
    if (!literal || command.assignments.some(([, value]) => !value.literal)) return false
    const step = zigStep(words)
    if (step !== undefined) {
      // Zig finds `build.zig` in the directory it starts in; only the root's is read.
      if (cwd !== "") return false
      out.zig.push(step)
      continue
    }
    const invocation = recognize(words, cwd, known)
    if (invocation === undefined || workspace === undefined) return false
    const replace = plain && !nested && command.start !== undefined
      ? [command.start, command.end as number] as const
      : undefined
    if (invocation.selection.kind !== "directory") {
      // A command over many packages is read from the root only.
      if (cwd !== "") return false
      out.runs.push({ invocation, replace, before: "" })
    } else if (invocation.selection.directory !== "") {
      out.runs.push({ invocation, replace, before: "" })
    } else {
      const inner = rootScript(workspace, invocation.tasks[0] as string, invocation.args, known, new Set())
      if (inner === undefined) return false
      out.runs.push({ ...inner, replace })
    }
  }
  return true
}

/**
 * Reads every command of a step. `undefined` when one of them is not
 * understood: a program this reader does not know, a flag it does not know,
 * or shell syntax it does not read. A step whose command or directory still
 * holds a `${{ … }}` expression is not understood, nor is one that gives a
 * package manager a setting through a variable. `wrappers` are the files the
 * repository's owner says stand for `turbo`.
 *
 * @throws {never}
 * @category planning
 * @since 0.1.0
 */
export const understand = (
  step: Step,
  workspace: Workspace | undefined,
  wrappers: ReadonlyArray<string> = []
): Understood | undefined => {
  if (step.cwd.includes("${{") || Object.keys(step.env).some((name) => setting.test(name))) return undefined
  const cwd = enter("", step.cwd)
  const list = commands(step.command)
  const out = { runs: [] as Array<Run>, zig: [] as Array<string> }
  const known = { wrappers, rootScripts: Object.keys(workspace?.rootScripts ?? {}) }
  if (cwd === undefined || list === undefined || !understandList(list, cwd, false, workspace, known, out)) {
    return undefined
  }
  return out.runs.length + out.zig.length === 0 ? undefined : { runs: out.runs, zig: [...new Set(out.zig)].sort() }
}

const segmentSource = (segment: string, star: string): string =>
  segment.split("*").map((part) => part.replace(/[.+^$()|/]/g, "\\$&")).join(star)

const matches = (pattern: Pattern, candidate: Package): boolean => {
  if (pattern.name !== undefined && new RegExp(`^${segmentSource(pattern.name, ".*")}$`).test(candidate.name)) {
    return true
  }
  if (pattern.directory === undefined) return false
  const source = pattern.directory.split("/").map((segment) =>
    segment === "**" ? "(?:[^/]+/)*" : `${segmentSource(segment, "[^/]*")}/`
  ).join("")
  return new RegExp(`^${source}$`).test(`${candidate.directory}/`)
}

// Text in a script that reaches packages no name or path gives away: a
// tool that works on the whole workspace or the history, a package manager
// told to run in other packages, a command substitution, or a variable that
// holds a directory.
const wide = new RegExp(
  [
    String.raw`(?:^|[\s;&|()'"=])(?:turbo|nx|lerna|wsrun|git)(?=$|[\s;&|()'"])`,
    String
      .raw`(?:^|[\s;&|()'"=])(?:pnpm|npm|yarn|bun)\s[^;&|]*?(?:--filter|-F|-r|--recursive|--workspaces?|-ws|-w|workspaces?)(?=$|[\s=;&|'"])`,
    String.raw`\$\(|\x60|\$\{?(?:INIT_CWD|PWD|OLDPWD|HOME)\b|~/`
  ].join("|")
)

// True when a package's script, with its hooks and the scripts it names, may
// read beyond what the package's files mention.
const reachesWide = (owner: Package, script: string): boolean => {
  const pending = [script, `pre${script}`, `post${script}`]
  const seen = new Set<string>()
  while (pending.length > 0) {
    const name = pending.pop() as string
    const body = owner.scripts[name]
    if (body === undefined || seen.has(name)) continue
    seen.add(name)
    if (wide.test(body)) return true
    const tokens = new Set(body.split(/[^A-Za-z0-9_:.@/-]+/))
    for (const other of Object.keys(owner.scripts)) if (tokens.has(other)) pending.push(other)
  }
  return false
}

interface Entry {
  readonly owner: Package
  /** The packages the per-package command names. */
  readonly names: ReadonlyArray<string>
  readonly everything: boolean
  readonly reaches: ReadonlyArray<Reach>
  readonly globs: ReadonlyArray<string>
}

const selected = (workspace: Workspace, graph: Graph, invocation: Invocation): ReadonlyArray<Package> | undefined => {
  const selection = invocation.selection
  if (selection.kind === "all") return workspace.packages
  if (selection.kind === "directory") {
    const owner = graph.ownerOf(selection.directory)
    return owner?.directory === selection.directory ? [owner] : undefined
  }
  const found = new Set<Package>()
  for (const pattern of selection.patterns) {
    const matched = workspace.packages.filter((candidate) => matches(pattern, candidate))
    // A selector that matches nothing may mean something this reader does not model.
    if (matched.length === 0) return undefined
    for (const candidate of matched) found.add(candidate)
  }
  return workspace.packages.filter((candidate) => found.has(candidate))
}

const declaredClosure = (graph: Graph, start: Package): ReadonlySet<string> => {
  const seen = new Set<string>()
  const pending = [start]
  while (pending.length > 0) {
    const next = pending.pop() as Package
    if (seen.has(next.name)) continue
    seen.add(next.name)
    for (const name of next.dependencies) pending.push(graph.named(name) as Package)
  }
  return seen
}

// The packages a run starts in, each with what its own command reads.
const entriesOf = (facts: Facts, invocation: Invocation): ReadonlyArray<Entry> | undefined => {
  const { graph, workspace } = facts
  const chosen = selected(workspace, graph, invocation)
  if (chosen === undefined) return undefined
  if (invocation.runner === "turbo") {
    const config = facts.turbo
    if (config === undefined || !invocation.tasks.every((task) => defines(config, task))) return undefined
    // The root package's own task reads the whole repository and is not modelled.
    if (invocation.tasks.some((task) => rootRuns(config, task))) return undefined
    return chosen.flatMap((owner): ReadonlyArray<Entry> => {
      const walked = walk(config, workspace, owner, invocation.tasks)
      if (walked.scripts.length === 0) return []
      return [{
        owner,
        names: [owner.name],
        everything: walked.root || walked.scripts.some(([reached, script]) => reachesWide(reached, script)),
        // A wrapper is a file of some package: the step reads it and what it mentions.
        reaches: [owner, ...walked.packages, ...(invocation.program === undefined ? [] : [invocation.program])].map((
          reached
        ) => graph.reachOf(reached)),
        globs: [...config.globalDependencies, ...walked.globs]
      }]
    })
  }
  const script = invocation.tasks[0] as string
  // pnpm and npm read settings that change which packages a run selects.
  if ((invocation.runner === "pnpm" || invocation.runner === "npm") && workspace.orchestrated) return undefined
  const having = chosen.filter((candidate) => Object.hasOwn(candidate.scripts, script))
  if (invocation.strict && having.length !== chosen.length) return undefined
  const single = invocation.selection.kind === "directory"
  // Bun and pnpm also run the root package's script when a selector matches its name.
  if (
    !single && invocation.runner !== "npm" && Object.hasOwn(workspace.rootScripts, script) &&
    (invocation.selection.kind === "all"
      ? invocation.runner === "bun"
      : invocation.selection.patterns.some((pattern) =>
        matches(pattern, { name: workspace.rootName ?? "", directory: "", scripts: {}, dependencies: [] })
      ))
  ) return undefined
  const runnable = new Set(having.map((candidate) => candidate.name))
  return having.map((owner): Entry => {
    // Nothing says this task does not need its dependencies' task first, as
    // a build does, so each package's command runs them too.
    const names = having.length === 1
      ? [owner.name]
      : [...declaredClosure(graph, owner)].filter((name) => runnable.has(name)).sort()
    return {
      owner,
      names,
      everything: names.some((name) => reachesWide(graph.named(name) as Package, script)),
      reaches: [graph.reachOf(owner)],
      globs: []
    }
  })
}

// Text a glob reader would not take as a plain path.
const magic = /[*?[\]{}\\]|[@+!]\(|^[!#]/

/**
 * The inputs of one or more reaches: the files outside every package, each
 * reached package's directory, each single file, and the extra globs. One
 * entry, `**`, when a path cannot be written as a glob.
 *
 * @throws {never}
 * @category planning
 * @since 0.1.0
 */
export const inputsOf = (
  outside: ReadonlyArray<string>,
  reaches: ReadonlyArray<Reach>,
  globs: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const directories = new Set(reaches.flatMap((reach) => [...reach.packages]))
  const files = new Set(reaches.flatMap((reach) => [...reach.files]))
  if ([...directories, ...files].some((path) => magic.test(path))) return [everything]
  const whole = [
    ...new Set([...outside.filter((glob) => glob.endsWith("/**")), ...[...directories].map((path) => `${path}/**`)])
  ]
  const covered = (path: string): boolean => whole.some((glob) => glob !== path && path.startsWith(glob.slice(0, -2)))
  return [...new Set([...outside, ...whole, ...files, ...globs])].filter((path) => !covered(path)).sort()
}

/**
 * The inputs of a Zig build step's closure: its files, and each directory it
 * reads whole. `undefined` when the closure is incomplete, so the step may
 * read anything.
 *
 * @throws {never}
 * @category planning
 * @since 0.1.0
 */
export const closureInputs = (closure: Closure | undefined): ReadonlyArray<string> | undefined =>
  closure === undefined || !isComplete(closure)
    ? undefined
    : [
      ...closure.files.map((file) => file.path),
      ...(closure.directories ?? []).map((directory) => `${directory.replace(/\/$/, "")}/**`)
    ]

// Where each job stands in the run of its working tree. The jobs of one Justfile, and of any source but GitHub
// Actions, run one after another in one directory, in `Inventory.treeOrder`. A GitHub job has a checkout of its
// own: it is the first and the last job in it.
const placesOf = (jobs: ReadonlyArray<Job>): (job: Job) => { readonly first: boolean; readonly last: boolean } => {
  const places = new Map<string, { readonly first: boolean; readonly last: boolean }>()
  for (const order of treeOrder(jobs).values()) {
    for (const [index, id] of order.entries()) places.set(id, { first: index === 0, last: index === order.length - 1 })
  }
  return (job) => places.get(job.id) ?? { first: true, last: true }
}

/**
 * The steps a later step relies on: every step but a job's last, and the
 * last step of a job that another job runs after in the same working tree.
 * The generator makes each of them a target that always runs, so splitting
 * one would only run it more times.
 *
 * @throws {never}
 * @category planning
 * @since 0.1.0
 */
export const followed = (jobs: ReadonlyArray<Job>): ReadonlySet<Step> => {
  const found = new Set<Step>()
  const place = placesOf(jobs)
  for (const job of jobs) {
    // GitHub jobs run on separate machines; every other source shares one tree.
    const needed = !place(job).last ||
      jobs.some((other) => other.source !== "github-actions" && other.needs.includes(job.id))
    for (const [index, step] of job.steps.entries()) {
      if (needed || index < job.steps.length - 1) found.add(step)
    }
  }
  return found
}

/**
 * The steps that follow another step in one working tree: every step but a
 * job's first, and every step of a job that runs after another in a tree
 * they share. Such a step can read what the earlier step wrote, and no
 * input names that, so it is never split or scoped.
 *
 * @throws {never}
 * @category planning
 * @since 0.1.0
 */
export const preceded = (jobs: ReadonlyArray<Job>): ReadonlySet<Step> => {
  const found = new Set<Step>()
  const place = placesOf(jobs)
  for (const job of jobs) {
    // GitHub jobs run on separate machines; every other source shares one tree.
    const after = !place(job).first || (job.source !== "github-actions" && job.needs.length > 0)
    for (const [index, step] of job.steps.entries()) {
      if (after || index > 0) found.add(step)
    }
  }
  return found
}

/**
 * The same understanding with no run to replace, so the step keeps its
 * command and only gains inputs.
 *
 * @throws {never}
 * @category planning
 * @since 0.1.0
 */
export const keepCommand = (understood: Understood): Understood => ({
  ...understood,
  runs: understood.runs.map((run) => ({ ...run, replace: undefined }))
})

/**
 * Decides what a step becomes.
 *
 * - One script run over several packages, alone in the step, splits into
 *   one part per package that has work.
 * - Any other understood step keeps its command and gains the union of what
 *   its runs and Zig build steps read.
 * - A step with a run that cannot be resolved, or a Zig step whose closure
 *   is missing or incomplete, stays whole.
 *
 * `facts` is `undefined` when the repository has no JavaScript workspace;
 * `zig` holds the closure of each Zig build step by name.
 *
 * @throws {never}
 * @category planning
 * @since 0.1.0
 */
export const decide = (
  step: Step,
  understood: Understood,
  facts: Facts | undefined,
  zig: ReadonlyMap<string, Closure>
): Decision => {
  const resolved: Array<ReadonlyArray<Entry>> = []
  for (const run of understood.runs) {
    const entries = facts === undefined ? undefined : entriesOf(facts, run.invocation)
    if (entries === undefined || entries.length === 0) return { kind: "whole" }
    resolved.push(entries)
  }
  const outside = facts?.graph.outside ?? []
  const inputs = (entries: ReadonlyArray<Entry>): ReadonlyArray<string> =>
    entries.some((entry) => entry.everything)
      ? [everything]
      : inputsOf(outside, entries.flatMap((entry) => entry.reaches), entries.flatMap((entry) => entry.globs))
  const run = understood.runs[0]
  const entries = resolved[0]
  if (
    understood.runs.length === 1 && understood.zig.length === 0 && run?.replace !== undefined &&
    entries !== undefined && entries.length > 1
  ) {
    const [start, end] = run.replace
    return {
      kind: "split",
      parts: entries.map((entry) => ({
        name: entry.owner.name,
        command: `${step.command.slice(0, start)}${run.before}${
          run.invocation.render(entry.names).map(quote).join(" ")
        }${step.command.slice(end)}`,
        inputs: inputs([entry])
      }))
    }
  }
  const read: Array<string> = resolved.length === 0 ? [] : [...inputs(resolved.flat())]
  for (const name of understood.zig) {
    const closed = closureInputs(zig.get(name))
    if (closed === undefined) return { kind: "whole" }
    read.push(...closed)
  }
  // No inputs would mean the step reads nothing, which no step does.
  if (read.length === 0) return { kind: "whole" }
  return { kind: "scope", inputs: read.includes(everything) ? [everything] : [...new Set(read)].sort() }
}
