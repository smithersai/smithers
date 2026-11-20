/**
 * When a tool run's result may be reused.
 *
 * A test runner, a type checker and a linter each start a program that can
 * read any file it can reach. Their declared inputs key the result, so a read
 * the declaration does not name would leave the key unchanged while the
 * verdict moved. Only a run confined to its declared reads proves there was
 * none. This module holds that policy: which rules it covers, which modes of
 * them have a complete contract, how a run gets its evidence, and what one
 * confined attempt that failed is remembered as.
 *
 * @since 1.0.0
 */

import type * as ExecSandbox from "@smthrs/targets/ExecSandbox"
import type * as WorkspaceDeclaration from "@smthrs/targets/WorkspaceDeclaration"
import { createHash, randomBytes } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"

/**
 * The rules whose result is reused only with evidence.
 *
 * @category policies
 * @since 1.0.0
 */
export const rules: ReadonlySet<string> = new Set(["Vitest", "NodeTest", "Typecheck", "EsLint", "Dprint", "TsBuild"])

/**
 * How a run gets its evidence.
 *
 * `declared`: the workspace confines its build, so the run is confined the
 * way every other tool run is and a failure is the target's failure.
 * `attempt`: the workspace turned build confinement off, so the run is tried
 * confined first; a red attempt runs again unconfined, and that second run
 * is the verdict.
 *
 * @category models
 * @since 1.0.0
 */
export interface Evidence {
  readonly mode: "declared" | "attempt"
}

/**
 * Why a rule's attrs select a mode without a complete contract, or nothing
 * when the mode is complete.
 *
 * @category policies
 * @since 1.0.0
 */
export const incomplete = (rule: string, attrs: unknown): string | undefined => {
  const value = attrs as { readonly buildMode?: unknown; readonly incremental?: unknown; readonly fix?: unknown }
  if (rule === "Typecheck" && (value.buildMode === true || value.incremental === true)) {
    return "build and incremental modes write build info that is not a declared output"
  }
  if ((rule === "EsLint" || rule === "Dprint") && value.fix === true) return "fix mode rewrites its sources"
  return undefined
}

/**
 * Decides how one planned node of an evidence rule gets its evidence, or says
 * why its result is never reused.
 *
 * @category policies
 * @since 1.0.0
 */
export const decide = (node: {
  readonly rule: string
  readonly attrs: unknown
  readonly sandbox: ExecSandbox.Policy | undefined
  readonly mechanism: WorkspaceDeclaration.SandboxDeclaration | undefined
  readonly services: number
  /** Why the installed dependency trees could not be identified, if they could not. */
  readonly installed: string | undefined
  /** The declaration's own `cache` attr; `false` keeps every run as the workspace declares it. */
  readonly cache: unknown
}): Evidence | { readonly reason: string } => {
  if (node.cache === false) return { reason: "the target declares cache: false" }
  const mode = incomplete(node.rule, node.attrs)
  if (mode !== undefined) return { reason: mode }
  if (node.installed !== undefined) return { reason: node.installed }
  if (node.sandbox === "none") return { reason: "the target declares sandbox: \"none\", so no run of it is confined" }
  if (typeof node.sandbox === "object" && node.sandbox.network !== undefined && node.sandbox.network !== false) {
    return { reason: "the target opens the network, which no key covers" }
  }
  if (node.services > 0) return { reason: "the target uses services, which run outside its confinement" }
  return { mode: node.mechanism !== undefined && node.mechanism._tag === "SandboxNone" ? "attempt" : "declared" }
}

/**
 * Whether a decision grants evidence.
 *
 * @category guards
 * @since 1.0.0
 */
export const isEvidence = (decision: Evidence | { readonly reason: string }): decision is Evidence => "mode" in decision

/**
 * The identity of what a node declares: its label, rule, sandbox policy,
 * declared inputs as written (a glob's pattern, never the files it matches),
 * dependencies, installed trees and the programs a suite declares it starts.
 * A confined attempt that failed is remembered under it, so adding a file
 * under a declared glob or editing a source does not try again, and declaring
 * the missing input or program does.
 *
 * @category attempts
 * @since 1.0.0
 */
export const declarationIdentity = (declaration: {
  readonly label: string
  readonly rule: string
  readonly sandbox: ExecSandbox.Policy | undefined
  /** Each declared input as its declaration wrote it. */
  readonly inputs: ReadonlyArray<unknown>
  readonly dependencies: ReadonlyArray<string>
  /** Paths the rule itself reads beside its declared inputs. */
  readonly reads: ReadonlyArray<string>
  readonly installedTrees: ReadonlyArray<string>
  /** The names of the programs a suite declares it starts (`Vitest` `tools`). */
  readonly tools?: ReadonlyArray<string> | undefined
}): string =>
  createHash("sha256").update(JSON.stringify([
    declaration.label,
    declaration.rule,
    declaration.sandbox ?? null,
    declaration.inputs,
    [...declaration.dependencies].sort(),
    [...declaration.reads].sort(),
    [...declaration.installedTrees].sort(),
    // Absent, the identity is the one a declaration without programs always had.
    ...(declaration.tools === undefined || declaration.tools.length === 0 ? [] : [[...declaration.tools].sort()])
  ])).digest("hex")

/**
 * How long a failed confined attempt is remembered. A suite that cannot run
 * confined pays for one extra run a day; one that failed by chance is tried
 * again the next day.
 *
 * @category constants
 * @since 1.0.0
 */
export const attemptMemoryMs = 24 * 60 * 60 * 1000

/** The format tag a remembered attempt carries; any other tag is ignored. */
const format = "smthrs-confined-attempt/1"

/**
 * Where one declaration's failed confined attempt is remembered:
 * `<cache directory>/evidence/<identity>.json`.
 *
 * @category attempts
 * @since 1.0.0
 */
export const attemptPath = (root: string, cacheDirectory: string, identity: string): string =>
  NodePath.join(root, ...cacheDirectory.split("/"), "evidence", `${identity}.json`)

/**
 * When a confined attempt of this declaration failed, if it did within
 * {@link attemptMemoryMs}: the attempt is made again that long after it. A
 * missing, unreadable, malformed or expired record answers `undefined`.
 *
 * @category attempts
 * @since 1.0.0
 */
export const attemptFailedAt = async (
  root: string,
  cacheDirectory: string,
  identity: string,
  now: number = Date.now()
): Promise<number | undefined> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(await Fs.readFile(attemptPath(root, cacheDirectory, identity), "utf8"))
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const record = parsed as { readonly format?: unknown; readonly at?: unknown }
  return record.format === format && typeof record.at === "number" && now >= record.at &&
      now - record.at < attemptMemoryMs
    ? record.at
    : undefined
}

/**
 * Whether a confined attempt of this declaration failed within
 * {@link attemptMemoryMs}. A missing, unreadable, malformed or expired record
 * answers no, and the run is attempted confined.
 *
 * @category attempts
 * @since 1.0.0
 */
export const attemptFailed = async (
  root: string,
  cacheDirectory: string,
  identity: string,
  now: number = Date.now()
): Promise<boolean> => await attemptFailedAt(root, cacheDirectory, identity, now) !== undefined

/**
 * Remembers that a confined attempt of this declaration failed while the same
 * run passed unconfined. `output` is the end of the attempt's failure, the
 * text a failed target prints.
 *
 * @category attempts
 * @since 1.0.0
 */
export const rememberFailedAttempt = async (
  root: string,
  cacheDirectory: string,
  identity: string,
  record: {
    readonly label: string
    readonly denied: ReadonlyArray<string>
    readonly output: ReadonlyArray<string>
  },
  now: number = Date.now()
): Promise<void> => {
  await remember(attemptPath(root, cacheDirectory, identity), { format, at: now, ...record })
}

/** Writes one remembered fact whole: a reader finds the earlier one or this one, never a part. */
const remember = async (file: string, fact: object): Promise<void> => {
  await Fs.mkdir(NodePath.dirname(file), { recursive: true })
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`
  try {
    await Fs.writeFile(temporary, JSON.stringify(fact), { flag: "wx" })
    await Fs.rename(temporary, file)
  } catch (cause) {
    await Fs.rm(temporary, { force: true })
    throw cause
  }
}

/** The format tag a remembered reach outside carries; any other tag is ignored. */
const outsideFormat = "smthrs-reached-outside/1"

/**
 * Where it is remembered that a declaration's recorded run reached outside
 * itself: `<cache directory>/evidence/<identity>.outside.json`.
 *
 * @category attempts
 * @since 1.0.0
 */
export const outsidePath = (root: string, cacheDirectory: string, identity: string): string =>
  NodePath.join(root, ...cacheDirectory.split("/"), "evidence", `${identity}.outside.json`)

/**
 * Why a recorded run of this declaration stored nothing within
 * {@link attemptMemoryMs}: it reached the network or a program outside the
 * run, and `reason` says which. A run that does so stores nothing whether its
 * reads are recorded or not, so for a day it runs without the recording.
 * `undefined` when nothing is remembered: the record is missing, unreadable,
 * malformed, expired, or from a clock that has since moved back.
 *
 * @category attempts
 * @since 1.0.0
 */
export const reachedOutside = async (
  root: string,
  cacheDirectory: string,
  identity: string,
  now: number = Date.now()
): Promise<string | undefined> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(await Fs.readFile(outsidePath(root, cacheDirectory, identity), "utf8"))
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const record = parsed as { readonly format?: unknown; readonly at?: unknown; readonly reason?: unknown }
  return record.format === outsideFormat && typeof record.at === "number" && typeof record.reason === "string" &&
      now >= record.at && now - record.at < attemptMemoryMs
    ? record.reason
    : undefined
}

/**
 * Remembers that a recorded run of this declaration reached outside itself,
 * and how. A later remembering replaces it.
 *
 * @category attempts
 * @since 1.0.0
 */
export const rememberReachedOutside = (
  root: string,
  cacheDirectory: string,
  identity: string,
  record: { readonly label: string; readonly reason: string },
  now: number = Date.now()
): Promise<void> => remember(outsidePath(root, cacheDirectory, identity), { format: outsideFormat, at: now, ...record })

/**
 * The lines of a failed confined run's output that name a path its
 * confinement closed, at most `limit` of them. The text may be a rendered
 * failure, whose line breaks are written as the two characters `\\n`.
 *
 * @category attempts
 * @since 1.0.0
 */
export const deniedLines = (text: string, limit = 5): ReadonlyArray<string> => {
  const lines = new Set<string>()
  for (const line of text.split(/\n|\\n/)) {
    const match = /^sandbox: (.+ (?:is outside the declared (?:read|write) set|was denied inside the declared set))/
      .exec(line.trim())
    if (match !== null) lines.add(match[1]!)
    // A program the run did not declare says so on its own error output,
    // which a tool's failure may quote anywhere in a line.
    for (const undeclared of line.matchAll(/sandbox: ([^\s"'\\]+ is not declared: declare it in tools)/g)) {
      lines.add(undeclared[1]!)
    }
  }
  return [...lines].slice(0, limit)
}

/** The tag of a stored result that carries what its confined run read beyond its key. */
const kind = "evidence"

/**
 * A stored result beside the measured content of every dependency output its
 * confined run could read. A dependency's key names its declaration, not the
 * bytes its run left on disk, so those bytes are measured when the result is
 * stored and again before it answers.
 *
 * @category results
 * @since 1.0.0
 */
export interface Record {
  readonly kind: "evidence"
  readonly reads: ReadonlyArray<readonly [path: string, digest: string]>
  readonly result: unknown
}

/**
 * Wraps a result with the dependency outputs its run could read.
 *
 * @category results
 * @since 1.0.0
 */
export const record = (
  reads: ReadonlyArray<readonly [string, string]>,
  result: unknown
): Record => ({ kind, reads: reads.map(([path, digest]) => [path, digest] as const), result })

/**
 * Decodes a stored {@link Record}; any other shape is `undefined`.
 *
 * @category results
 * @since 1.0.0
 */
export const decode = (output: unknown): Record | undefined => {
  if (typeof output !== "object" || output === null) return undefined
  const value = output as { readonly kind?: unknown; readonly reads?: unknown }
  if (value.kind !== kind || !Object.hasOwn(value, "result") || !Array.isArray(value.reads)) return undefined
  const reads: Array<readonly [string, string]> = []
  for (const read of value.reads) {
    if (!Array.isArray(read) || read.length !== 2 || typeof read[0] !== "string" || typeof read[1] !== "string") {
      return undefined
    }
    reads.push([read[0], read[1]])
  }
  return { kind, reads, result: (output as { readonly result: unknown }).result }
}
