import { Data, Result } from "effect"
import { decodeJevConfig, isRepoPath, type JevConfig, type JevConfigError } from "../../src/features/jev/config.ts"
import { FLOW_NAME, flowPath, workflowPaths } from "./RepoFlow.ts"

// A repository's workflows and Jev config in a checkout on disk (docs/features/ci.md#repository-flows).
//
//   .smithers/workflows/<name>.vibe     first
//   .smithers/workflows/<name>.ts       then
//   .smithers/flows/<name>/flow.ts      the older layout, read only when neither above exists
//
// Every repository path is walked one segment at a time from the real checkout with `lstat`. A symlink is followed
// only when its real target lies under the real checkout. Only a segment that genuinely does not exist (`ENOENT` on a
// real directory) counts as absent. A dangling or looping link, a wrong file type, an unreadable entry or an escape
// refuses the lookup, so an invalid preferred entry never falls back to a lower-priority workflow or Jev config.
//
// A file is consumed once: opened by its real path with `O_NOFOLLOW`, checked regular with `fstat`, its device and
// inode matched to the entry the walk reached through real directories, read from that descriptor, and the walk
// repeated afterwards. A swap of the file or of any ancestor between check and read refuses with `changed`. A
// directory is confined the same way before it is listed. Errors carry the repository path and a fixed detail, never
// an absolute path or a name read outside the checkout.

/** What `lstat` and `fstat` report. `node:fs` `Stats` satisfies it. */
export interface FileStat {
  readonly dev: number | bigint
  readonly ino: number | bigint
  readonly isFile: () => boolean
  readonly isDirectory: () => boolean
  readonly isSymbolicLink: () => boolean
}

/** The checkout reads this module needs, a subset of `node:fs`. A runner passes `node:fs` itself. */
export interface CheckoutFiles {
  readonly lstatSync: (path: string) => FileStat
  readonly realpathSync: (path: string) => string
  readonly readdirSync: (path: string) => ReadonlyArray<string>
  readonly openSync: (path: string, flags: number) => number
  readonly fstatSync: (fd: number) => FileStat
  readonly readFileSync: (fd: number, encoding: "utf8") => string
  readonly closeSync: (fd: number) => void
  readonly constants: { readonly O_RDONLY: number; readonly O_NOFOLLOW?: number; readonly O_NONBLOCK?: number }
}

/** Where a workflow came from: the `.smithers/workflows/` layout or the older `.smithers/flows/` one. */
export type WorkflowSource = "workflows" | "flows"

export interface DiscoveredWorkflow {
  readonly name: string
  readonly source: WorkflowSource
  /** The repository path, as `./<path>`. */
  readonly path: string
  /** The real file under the real checkout, for display. A loader consumes `text`, never reopens this. */
  readonly file: string
  /** The text read from the one descriptor discovery opened and checked. */
  readonly text: string
}

export type WorkflowDiscoveryErrorCode =
  | "invalid_name"
  | "not_found"
  | "path_escape"
  | "invalid_entry"
  | "not_regular"
  | "unreadable"
  | "changed"

export class WorkflowDiscoveryError extends Data.TaggedError("WorkflowDiscoveryError")<{
  readonly code: WorkflowDiscoveryErrorCode
  /** The repository path asked for, as `./<path>`, or the workflow name. */
  readonly path: string
  /** A fixed description, never a filesystem path. */
  readonly detail: string
}> {}

const WORKFLOWS_DIR = "./.smithers/workflows"
const FLOWS_DIR = "./.smithers/flows"
const WORKFLOW_FILE = /^([a-z0-9][a-z0-9_-]{0,63})\.(vibe|ts)$/

/** The files a workflow `name` may live in, in lookup order. */
export const workflowCandidates = (name: string): ReadonlyArray<{ readonly source: WorkflowSource; readonly path: string }> =>
  workflowPaths(name).map((path, index) => ({ source: index < 2 ? "workflows" : "flows", path: `./${path}` }))

type Refusal<A> = Result.Result<A, WorkflowDiscoveryError>

const refuse = <A>(code: WorkflowDiscoveryErrorCode, path: string, detail: string): Refusal<A> =>
  Result.fail(new WorkflowDiscoveryError({ code, path, detail }))

const errno = (error: unknown): string => {
  const code = typeof error === "object" && error !== null ? (error as { readonly code?: unknown }).code : undefined
  return typeof code === "string" && /^E[A-Z]+$/.test(code) ? code : "unknown"
}

const inside = (root: string, real: string) => real.startsWith(`${root}/`)

/** The real checkout, which must be a directory. */
const realRoot = (checkout: string, files: CheckoutFiles): Refusal<string> => {
  try {
    const root = files.realpathSync(checkout).replace(/\/+$/, "")
    return files.lstatSync(root).isDirectory() ? Result.succeed(root) : refuse("unreadable", ".", "the checkout is not a directory")
  } catch (error) {
    return refuse("unreadable", ".", `the checkout does not resolve (${errno(error)})`)
  }
}

/** What a repository path names: nothing, or a regular file or directory at a real path under the checkout. */
type Entry =
  | { readonly kind: "missing" }
  | { readonly kind: "file" | "directory"; readonly real: string }

/**
 * Walks `path` from the real checkout one segment at a time. `missing` only for `ENOENT` on a segment whose parent is
 * a real directory under the checkout. Every other failure refuses.
 */
const probe = (root: string, path: string, files: CheckoutFiles): Refusal<Entry> => {
  if (!isRepoPath(path)) return refuse("path_escape", path, "not a repository path")
  const segments = path.slice(2).split("/")
  let current = root
  for (const [index, segment] of segments.entries()) {
    const at = `${current}/${segment}`
    let stat: FileStat
    try {
      stat = files.lstatSync(at)
    } catch (error) {
      const code = errno(error)
      return code === "ENOENT" ? Result.succeed({ kind: "missing" }) : refuse("unreadable", path, `cannot inspect an entry (${code})`)
    }
    current = at
    if (stat.isSymbolicLink()) {
      let real: string
      try {
        real = files.realpathSync(at)
      } catch (error) {
        return refuse("invalid_entry", path, `a symlink does not resolve (${errno(error)})`)
      }
      if (!inside(root, real)) return refuse("path_escape", path, "resolves outside the checkout")
      try {
        stat = files.lstatSync(real)
      } catch (error) {
        return refuse("unreadable", path, `cannot inspect an entry (${errno(error)})`)
      }
      current = real
    }
    const last = index === segments.length - 1
    if (!last && !stat.isDirectory()) return refuse("invalid_entry", path, "an ancestor is not a directory")
    if (last) {
      if (stat.isFile()) return Result.succeed({ kind: "file", real: current })
      if (stat.isDirectory()) return Result.succeed({ kind: "directory", real: current })
      return refuse("not_regular", path, "not a regular file or directory")
    }
  }
  return refuse("path_escape", path, "not a repository path")
}

/**
 * The device and inode of the checkout and every segment of `real` under it, each reached as a real directory, the
 * last a regular file or a directory as `want` says. Refuses `changed` when an entry is now a symlink or another type.
 */
const identities = (root: string, real: string, want: "file" | "directory", path: string, files: CheckoutFiles): Refusal<ReadonlyArray<string>> => {
  const ids: Array<string> = []
  const segments = real.slice(root.length + 1).split("/")
  let current = root
  for (let index = -1; index < segments.length; index += 1) {
    if (index >= 0) current = `${current}/${segments[index]}`
    let stat: FileStat
    try {
      stat = files.lstatSync(current)
    } catch {
      return refuse("changed", path, "the checkout changed while it was read")
    }
    const last = index === segments.length - 1
    const ok = !stat.isSymbolicLink() && (last && want === "file" ? stat.isFile() : stat.isDirectory())
    if (!ok) return refuse("changed", path, "the checkout changed while it was read")
    ids.push(`${stat.dev}:${stat.ino}`)
  }
  return Result.succeed(ids)
}

const same = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => a.length === b.length && a.every((id, index) => id === b[index])

/** Reads the regular file at `real` from one descriptor, bound to the entry the walk reached. */
const readBound = (root: string, real: string, path: string, files: CheckoutFiles): Refusal<string> => {
  const before = identities(root, real, "file", path, files)
  if (Result.isFailure(before)) return Result.fail(before.failure)
  const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = files.constants
  let fd: number
  try {
    fd = files.openSync(real, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch (error) {
    const code = errno(error)
    return code === "ELOOP" ? refuse("changed", path, "the checkout changed while it was read") : refuse("unreadable", path, `cannot open (${code})`)
  }
  try {
    let stat: FileStat
    try {
      stat = files.fstatSync(fd)
    } catch (error) {
      return refuse("unreadable", path, `cannot inspect the open file (${errno(error)})`)
    }
    if (!stat.isFile()) return refuse("not_regular", path, "not a regular file")
    if (`${stat.dev}:${stat.ino}` !== before.success.at(-1)) return refuse("changed", path, "the checkout changed while it was read")
    let text: string
    try {
      text = files.readFileSync(fd, "utf8")
    } catch (error) {
      return refuse("unreadable", path, `cannot read (${errno(error)})`)
    }
    const after = identities(root, real, "file", path, files)
    if (Result.isFailure(after)) return Result.fail(after.failure)
    if (!same(before.success, after.success)) return refuse("changed", path, "the checkout changed while it was read")
    return Result.succeed(text)
  } finally {
    try {
      files.closeSync(fd)
    } catch {
      // A descriptor that fails to close was still read once. Nothing else uses it.
    }
  }
}

/** Opens a regular file at a repository path. `undefined` when it genuinely does not exist. */
const readFile = (root: string, path: string, files: CheckoutFiles): Refusal<{ readonly real: string; readonly text: string } | undefined> => {
  const entry = probe(root, path, files)
  if (Result.isFailure(entry)) return Result.fail(entry.failure)
  if (entry.success.kind === "missing") return Result.succeed(undefined)
  if (entry.success.kind === "directory") return refuse("not_regular", path, "not a regular file")
  const real = entry.success.real
  const text = readBound(root, real, path, files)
  return Result.isFailure(text) ? Result.fail(text.failure) : Result.succeed({ real, text: text.success })
}

/** The entry names of a directory at a repository path, confined before it is listed. None when it does not exist. */
const listDirectory = (root: string, path: string, files: CheckoutFiles): Refusal<ReadonlyArray<string>> => {
  const entry = probe(root, path, files)
  if (Result.isFailure(entry)) return Result.fail(entry.failure)
  if (entry.success.kind === "missing") return Result.succeed([])
  if (entry.success.kind === "file") return refuse("invalid_entry", path, "not a directory")
  const real = entry.success.real
  const before = identities(root, real, "directory", path, files)
  if (Result.isFailure(before)) return Result.fail(before.failure)
  let names: ReadonlyArray<string>
  try {
    names = files.readdirSync(real)
  } catch (error) {
    return refuse("unreadable", path, `cannot list (${errno(error)})`)
  }
  const after = identities(root, real, "directory", path, files)
  if (Result.isFailure(after)) return Result.fail(after.failure)
  if (!same(before.success, after.success)) return refuse("changed", path, "the checkout changed while it was read")
  return Result.succeed(names)
}

const discoverIn = (root: string, name: string, files: CheckoutFiles): Refusal<DiscoveredWorkflow> => {
  if (!FLOW_NAME.test(name)) return refuse("invalid_name", name, "not a workflow name")
  for (const candidate of workflowCandidates(name)) {
    const read = readFile(root, candidate.path, files)
    if (Result.isFailure(read)) return Result.fail(read.failure)
    if (read.success === undefined) continue
    return Result.succeed({ name, source: candidate.source, path: candidate.path, file: read.success.real, text: read.success.text })
  }
  return refuse("not_found", name, "no workflow file")
}

/**
 * Finds workflow `name` in a checkout and reads it: the first candidate that exists. A candidate that exists but is
 * invalid, unreadable or escapes refuses the lookup instead of falling back.
 */
export const discoverWorkflow = (checkout: string, name: string, files: CheckoutFiles): Refusal<DiscoveredWorkflow> => {
  if (!FLOW_NAME.test(name)) return refuse("invalid_name", name, "not a workflow name")
  const root = realRoot(checkout, files)
  return Result.isFailure(root) ? Result.fail(root.failure) : discoverIn(root.success, name, files)
}

/**
 * Every workflow in a checkout, by name. A name in both layouts is the `.smithers/workflows/` one. Each directory is
 * confined before it is listed, and an entry that is invalid or escapes refuses the whole listing: a listing never
 * quietly omits a workflow the repository declares.
 */
export const listWorkflows = (checkout: string, files: CheckoutFiles): Refusal<ReadonlyArray<DiscoveredWorkflow>> => {
  const rooted = realRoot(checkout, files)
  if (Result.isFailure(rooted)) return Result.fail(rooted.failure)
  const root = rooted.success
  const names = new Set<string>()
  const workflows = listDirectory(root, WORKFLOWS_DIR, files)
  if (Result.isFailure(workflows)) return Result.fail(workflows.failure)
  for (const entry of workflows.success) {
    const match = WORKFLOW_FILE.exec(entry)
    // `<name>.test.ts` and `<name>.d.ts` hold a dot in the name, so the pattern skips them.
    if (match !== null) names.add(match[1]!)
  }
  const flows = listDirectory(root, FLOWS_DIR, files)
  if (Result.isFailure(flows)) return Result.fail(flows.failure)
  for (const entry of flows.success) {
    if (!FLOW_NAME.test(entry)) continue
    const flow = probe(root, `./${flowPath(entry)}`, files)
    if (Result.isFailure(flow)) return Result.fail(flow.failure)
    if (flow.success.kind !== "missing") names.add(entry)
  }
  const found: Array<DiscoveredWorkflow> = []
  for (const name of [...names].sort()) {
    const workflow = discoverIn(root, name, files)
    if (Result.isFailure(workflow)) return Result.fail(workflow.failure)
    found.push(workflow.success)
  }
  return Result.succeed(found)
}

/** Where a repository declares its Jev config, in lookup order. */
export const JEV_CONFIG_PATHS = ["./.smithers/jev.config.json", "./.smithers/jev.config.ts"] as const

/** A decoded Jev config and the text of every file it names, keyed by repository path. */
export interface LoadedJevConfig {
  readonly path: string
  readonly config: JevConfig
  readonly files: Readonly<Record<string, string>>
}

/** Why a Jev config was not loaded: unparseable, a `.ts` config with no evaluator, or a refused file. */
export type JevLoadError =
  | JevConfigError
  | WorkflowDiscoveryError
  | JevConfigUnreadable

export class JevConfigUnreadable extends Data.TaggedError("JevConfigUnreadable")<{
  readonly path: string
  readonly detail: string
}> {}

/** Every repository path a config names: each evaluator's script, schema or template, and each decision's examples. */
export const jevPaths = (config: JevConfig): ReadonlyArray<string> => {
  const paths = new Set<string>()
  for (const decision of Object.values(config.decisions)) {
    for (const evaluator of decision.evaluators) {
      if (evaluator.use === "script") paths.add(evaluator.script)
      if (evaluator.use === "schema") paths.add(evaluator.schema)
      if (evaluator.use === "template") paths.add(evaluator.template)
    }
    if (decision.examples !== undefined) paths.add(decision.examples)
  }
  return [...paths].sort()
}

/**
 * Loads a checkout's Jev config. The first config path that exists is read once; one that exists but is invalid
 * refuses, so a broken `.json` never falls through to an executable `.ts`. JSON parses directly. A `.ts` config goes
 * only through `evaluate`, which a caller provides from its sandboxed realm and which receives the source text read
 * here, never a path to reopen. The result is decoded by `decodeJevConfig`, and only then is each file it names read
 * the same bound way. `undefined` when the repository declares none.
 */
export const loadJevConfig = (
  checkout: string,
  files: CheckoutFiles,
  options: { readonly evaluate?: (source: string, path: string) => unknown } = {},
): Result.Result<LoadedJevConfig | undefined, JevLoadError> => {
  const rooted = realRoot(checkout, files)
  if (Result.isFailure(rooted)) return Result.fail(rooted.failure)
  const root = rooted.success
  let found: { readonly path: string; readonly text: string } | undefined
  for (const path of JEV_CONFIG_PATHS) {
    const entry = probe(root, path, files)
    if (Result.isFailure(entry)) return Result.fail(entry.failure)
    if (entry.success.kind === "missing") continue
    if (path.endsWith(".ts") && options.evaluate === undefined) {
      return Result.fail(new JevConfigUnreadable({ path, detail: "a .ts config needs an evaluator" }))
    }
    const read = readFile(root, path, files)
    if (Result.isFailure(read)) return Result.fail(read.failure)
    if (read.success === undefined) return refuse("changed", path, "the checkout changed while it was read")
    found = { path, text: read.success.text }
    break
  }
  if (found === undefined) return Result.succeed(undefined)
  let input: unknown
  try {
    input = found.path.endsWith(".json") ? JSON.parse(found.text) : options.evaluate!(found.text, found.path)
  } catch {
    return Result.fail(new JevConfigUnreadable({ path: found.path, detail: "does not parse" }))
  }
  const decoded = decodeJevConfig(input)
  if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
  const texts: Record<string, string> = {}
  for (const named of jevPaths(decoded.success)) {
    const read = readFile(root, named, files)
    if (Result.isFailure(read)) return Result.fail(read.failure)
    if (read.success === undefined) return refuse("not_found", named, "a file the config names does not exist")
    texts[named] = read.success.text
  }
  return Result.succeed({ path: found.path, config: decoded.success, files: texts })
}
