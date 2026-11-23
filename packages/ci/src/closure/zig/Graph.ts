/**
 * The step graph of a Zig build, read from `zig build --print-configuration`.
 *
 * A step's inputs come from two places. What it declares in `build.zig`, such
 * as a file passed to a command, is in the configuration and is read here.
 * What a compile step reads is known only to the compiler and is read from its
 * cache manifest, not here.
 *
 * @since 0.1.0
 */

import * as Zon from "./Zon.ts"

/**
 * One step of the build.
 *
 * @category models
 * @since 0.1.0
 */
export interface Step {
  readonly index: number
  readonly name: string
  /** The step's kind as Zig names it: `compile`, `run`, `top_level` and so on. */
  readonly kind: string
  readonly deps: ReadonlyArray<number>
  /** Paths the step declares, relative to the directory holding `build.zig`. */
  readonly paths: ReadonlyArray<string>
  /** Reasons the step's inputs cannot be listed. Empty when they can. */
  readonly open: ReadonlyArray<string>
  /** True when the step runs a test binary. */
  readonly test: boolean
}

/**
 * Every step, and the names `zig build` accepts.
 *
 * @category models
 * @since 0.1.0
 */
export interface Graph {
  readonly steps: ReadonlyArray<Step>
  /** The index of each step `zig build <name>` can be asked for. */
  readonly named: ReadonlyMap<string, number>
}

/** The step kinds of Zig 0.17.1 (`Configuration.Step.Tag`). Any other kind is reported, not followed. */
const kinds = new Set([
  "check_file",
  "compile",
  "config_header",
  "fail",
  "find_program",
  "fmt",
  "install_artifact",
  "install_dir",
  "install_file",
  "objcopy",
  "options",
  "run",
  "top_level",
  "translate_c",
  "update_source_files",
  "write_file"
])

const text = (value: Zon.Zon | undefined): string | undefined => typeof value === "string" ? value : undefined

/**
 * Walks a step's data for every path it names. A path is a struct whose flags
 * carry one of `LazyPath`'s three tags.
 */
const collect = (value: Zon.Zon | undefined, paths: Array<string>, open: Array<string>): void => {
  if (typeof value !== "object" || value === null) return
  if (Array.isArray(value)) {
    for (const item of value) collect(item, paths, open)
    return
  }
  const tag = text(Zon.field(Zon.field(value, "flags"), "tag"))
  const path = text(Zon.field(value, "sub_path"))
  if (tag === "source_path" && path !== undefined) {
    // A path in another package prints its owner as a number the configuration text never explains.
    if (Zon.field(value, "owner") === "root") paths.push(path)
    else open.push(`a path in another package: ${path}`)
    return
  }
  if (tag === "relative" && path !== undefined) {
    open.push(`a path outside the build: ${path}`)
    return
  }
  for (const item of Object.values(value)) collect(item, paths, open)
}

/**
 * Zig's own rule for a command it reruns every time (`Maker/Step/Run.zig`):
 * marked as having side effects, wired to the terminal, or writing nothing the
 * build can see.
 */
const sideEffects = (extended: Zon.Zon | undefined): boolean => {
  const flags = Zon.field(extended, "flags")
  if (Zon.field(flags, "has_side_effects") === true) return true
  const stdio = Zon.field(flags, "stdio")
  if (stdio === "inherit") return true
  if (stdio !== "infer_from_args") return false
  const writes = Zon.list(Zon.field(extended, "args")).some((arg) =>
    text(Zon.field(Zon.field(arg, "flags"), "tag"))?.startsWith("output_") === true
  )
  return !writes && Zon.field(extended, "captured_stdout") === null && Zon.field(extended, "captured_stderr") === null
}

const step = (value: Zon.Zon, index: number): Step | undefined => {
  const name = text(Zon.field(value, "name"))
  const extended = Zon.field(value, "extended")
  const flags = Zon.field(extended, "flags")
  const kind = text(Zon.field(flags, "tag"))
  if (name === undefined || kind === undefined) return undefined
  const paths: Array<string> = []
  const open: Array<string> = []
  if (!kinds.has(kind)) open.push(`a step of a kind this strategy does not know: ${kind}`)
  if (kind === "run" && sideEffects(extended)) open.push("a command Zig reruns every time")
  const raw = Zon.field(value, "deps")
  const deps = Zon.list(raw).filter((dep) => typeof dep === "number")
  if (!Array.isArray(raw) || deps.length !== raw.length) open.push("the step has unreadable dependencies")
  collect(extended, paths, open)
  return {
    index,
    name,
    kind,
    deps,
    paths,
    open,
    test: kind === "run" && Zon.field(flags, "stdio") === "zig_test"
  }
}

/**
 * Reads the step graph from parsed configuration text.
 *
 * @param configuration - The value `zig build --print-configuration` printed.
 * @returns The graph, or `undefined` when the value is not a configuration.
 * @throws {never}
 *
 * @category parsing
 * @since 0.1.0
 */
export const read = (configuration: Zon.Zon): Graph | undefined => {
  const steps: Array<Step> = []
  const values = Zon.list(Zon.field(configuration, "steps"))
  for (const [index, value] of values.entries()) {
    const read = step(value, index)
    if (read === undefined) return undefined
    if (read.deps.some((dep) => !Number.isInteger(dep) || dep < 0 || dep >= values.length)) {
      steps.push({ ...read, open: [...read.open, "a dependency has no step"] })
    } else steps.push(read)
  }
  if (steps.length === 0) return undefined
  const named = new Map<string, number>()
  const names = Zon.field(configuration, "top_level_steps")
  if (typeof names === "object" && names !== null && !Array.isArray(names)) {
    for (const [name, index] of Object.entries(names)) {
      if (typeof index !== "number" || !Number.isInteger(index) || steps[index] === undefined) return undefined
      named.set(name, index)
    }
  }
  return { steps, named }
}

const reachable = (graph: Graph, index: number): Set<number> => {
  const seen = new Set<number>()
  const queue = [index]
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    const found = graph.steps[next]
    if (found === undefined || seen.has(next)) continue
    seen.add(next)
    for (const dep of found.deps) queue.push(dep)
  }
  return seen
}

/**
 * The step itself and every step it depends on, in index order.
 *
 * @throws {never}
 *
 * @category accessors
 * @since 0.1.0
 */
export const reach = (graph: Graph, index: number): ReadonlyArray<Step> => {
  const seen = reachable(graph, index)
  return graph.steps.filter((candidate) => seen.has(candidate.index))
}

/**
 * The step a name refers to: first a name `zig build` accepts, then a step's
 * own name when exactly one step has it.
 *
 * @throws {never}
 *
 * @category accessors
 * @since 0.1.0
 */
export const find = (graph: Graph, name: string): Step | undefined => {
  const named = graph.named.get(name)
  if (named !== undefined) return graph.steps[named]
  const matches = graph.steps.filter((candidate) => candidate.name === name)
  return matches.length === 1 ? matches[0] : undefined
}

/**
 * The named steps a step only groups, or nothing when it does more than
 * group. A step groups when `zig build` accepts its name, it does no work of
 * its own, and each step it depends on is one `zig build` accepts by name.
 * `zig build <name>` then runs exactly what `zig build` of each of them
 * runs, so they can be run apart. A group inside a group is opened too.
 *
 * @param graph - The step graph.
 * @param index - The step's index.
 * @returns The names, each once, in the order the steps list them. Empty for
 * a step that groups fewer than two.
 * @throws {never}
 *
 * @category accessors
 * @since 0.1.0
 */
export const grouped = (graph: Graph, index: number): ReadonlyArray<string> => {
  const unclear = (step: Step) => step.open.some((reason) => reason !== "a command Zig reruns every time")
  if (reach(graph, index).some(unclear)) return []
  const names = new Map([...graph.named].map(([name, at]) => [at, name]))
  const group = (at: number): ReadonlyArray<number> | undefined => {
    const found = graph.steps[at]
    if (found === undefined || found.kind !== "top_level" || !names.has(at) || found.deps.length === 0) return undefined
    return found.deps.every((dep) => names.has(dep)) ? found.deps : undefined
  }
  const roots = group(index)
  if (roots === undefined) return []
  const pending = [...roots].reverse()
  const seen = new Set([index])
  const inside: Array<string> = []
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (seen.has(at)) continue
    seen.add(at)
    const deps = group(at)
    if (deps === undefined) inside.push(names.get(at)!)
    else for (let i = deps.length - 1; i >= 0; i--) pending.push(deps[i]!)
  }
  if (inside.length < 2) return []
  const exclusive = new Set<number>()
  for (const name of inside) {
    for (const at of reachable(graph, graph.named.get(name)!)) {
      const step = graph.steps[at]!
      if (step.kind !== "run" && step.kind !== "update_source_files") continue
      if (exclusive.has(step.index)) return []
      exclusive.add(step.index)
    }
  }
  return inside
}
