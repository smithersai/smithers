/** Capture actual before/after file contents at the executable flow boundary. */
import type * as Cell from "@smthrs/harness/Cell"
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as ApplyPatch from "@smthrs/std/ApplyPatch"
import * as Bash from "@smthrs/std/Bash"
import { createTwoFilesPatch } from "diff"
import { Effect, Schema } from "effect"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { resolve } from "node:path"
import * as Subprocess from "./subprocess.ts"

export interface Patch {
  readonly path: string
  readonly patch: string
}
export interface Receipt {
  readonly call: string
  readonly patches: ReadonlyArray<Patch>
}
export const identity = (call: Cell.CallIdentity): string =>
  JSON.stringify([call.session, call.frame, call.cell, call.ordinal, call.declaration, call.layers])
const maxBytes = 512_000
/** A text file's content; `null` when absent, `undefined` when unreadable, binary or large. */
export const read = async (path: string): Promise<string | null | undefined> => {
  try {
    if ((await stat(path)).size > maxBytes) return undefined
    const bytes = await readFile(path)
    if (bytes.includes(0)) return undefined
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === "ENOENT" || code === "ENOTDIR" ? null : undefined
  }
}
/** A file's permission bits; `undefined` when absent or unreadable. */
export const mode = async (path: string): Promise<number | undefined> => {
  try {
    return (await stat(path)).mode & 0o777
  } catch {
    return undefined
  }
}
interface FileState {
  readonly digest: string | null | undefined
  readonly text: string | null | undefined
  readonly mode: number | undefined
}
/** Read a candidate before or after the call; a digest covers binary and large files too. */
const fileState = async (path: string): Promise<FileState> => {
  try {
    const info = await stat(path)
    const hash = createHash("sha256")
    let text: string | null | undefined
    if (info.size <= maxBytes) {
      const bytes = await readFile(path)
      hash.update(bytes)
      try {
        text = bytes.includes(0) ? undefined : new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      } catch {
        text = undefined
      }
    } else {
      for await (const chunk of createReadStream(path)) hash.update(chunk)
    }
    return { digest: hash.digest("hex"), text, mode: info.mode & 0o777 }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === "ENOENT" || code === "ENOTDIR"
      ? { digest: null, text: null, mode: undefined }
      : { digest: undefined, text: undefined, mode: undefined }
  }
}
/**
 * `null` is an absent file: its side of the patch is `/dev/null`, so creation and deletion reverse.
 * A deletion carries the file's `mode` as git's `deleted file mode` header, so undo restores it.
 */
export const patch = (path: string, before: string | null, after: string | null, deletedMode?: number): Patch | undefined => {
  if (before === after) return undefined
  const body = createTwoFilesPatch(
    before === null ? "/dev/null" : `a/${path}`,
    after === null ? "/dev/null" : `b/${path}`,
    before ?? "",
    after ?? "",
    "",
    "",
    { context: 3, timeout: 100, maxEditLength: 10_000 }
  )
  if (body === undefined) return { path, patch: `Diff too large: ${path}` }
  return after !== null || deletedMode === undefined
    ? { path, patch: body }
    : {
      path,
      patch: `diff --git a/${path} b/${path}\ndeleted file mode ${(0o100000 | deletedMode).toString(8)}\n${body.replace(/^=+\n/, "")}`
    }
}
/**
 * The files a write flow's input names; `undefined` when it names them in a
 * form this reads no further, such as a patch `apply_patch` would refuse.
 */
export const touched = (flow: string, input: unknown): string[] | undefined => {
  if (input === null || typeof input !== "object") return []
  const value = input as Record<string, unknown>
  if ((flow === "edit" || flow === "write") && typeof value.path === "string") return [value.path]
  if (flow === "apply_patch" && typeof value.input === "string") {
    const named = ApplyPatch.paths(value.input)
    return named === undefined ? undefined : [...named]
  }
  return []
}
export const paths = (flow: string, input: unknown): string[] => touched(flow, input) ?? []
const command = async (
  program: string,
  cwd: string,
  args: string[],
  env: Record<string, string> = {}
): Promise<string | undefined> => {
  try {
    const child = Subprocess.spawn([program, ...args], {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...env }
    })
    const timer = setTimeout(() => child.kill(), 5000)
    try {
      const decoder = new TextDecoder()
      let output = ""
      const reader = child.stdout.getReader()
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        output += decoder.decode(value, { stream: true })
        if (output.length > 4_000_000) {
          child.kill()
          return undefined
        }
      }
      output += decoder.decode()
      return await child.exited === 0 ? output : undefined
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return undefined
  }
}
const git = (cwd: string, args: string[], env?: Record<string, string>) => command("git", cwd, args, env)
export const splitPatch = (diff: string): Patch[] =>
  diff.split(/(?=^diff --git )/m).filter((part) => part.trim() !== "").map((patch) => {
    const added = patch.match(/^\+\+\+ (?:b\/)?(.+)$/m)?.[1]
    const removed = patch.match(/^--- (?:a\/)?(.+)$/m)?.[1]
    const path = (added === "/dev/null" ? removed : added) ?? removed ??
      patch.match(/^diff --git a\/.+ b\/(.+)$/m)?.[1] ?? "Changes"
    return { path: path.replace(/\t.*$/, ""), patch }
  })
const unavailable: Patch = { path: "Changes", patch: "Diff unavailable or too large." }

const changedPatch = (path: string, old: FileState, next: FileState): Patch | undefined => {
  if (old.digest === undefined || next.digest === undefined ||
      (old.digest === next.digest && old.mode === next.mode)) return undefined
  if (old.text === undefined || next.text === undefined) return { path, patch: `Binary or large file: ${path}` }
  const diff = patch(path, old.text, next.text, next.text !== null ? undefined : old.mode)
  if (diff !== undefined) return diff
  return { path, patch: `diff --git a/${path} b/${path}\nold mode ${(0o100000 | (old.mode ?? 0)).toString(8)}\nnew mode ${(0o100000 | (next.mode ?? 0)).toString(8)}\n` }
}

/**
 * Candidate files in the working tree, including untracked paths, without
 * staging or consulting HEAD. Ignored files are not candidates for receipts.
 */
const gitPaths = async (cwd: string): Promise<string[] | undefined> => {
  const output = await git(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."])
  return output === undefined ? undefined : [...new Set(output.split("\0").filter(Boolean))]
}
const states = async (cwd: string, paths: ReadonlyArray<string>): Promise<Map<string, FileState>> => {
  const found = new Map<string, FileState>()
  for (let at = 0; at < paths.length; at += 64) {
    const batch = await Promise.all(paths.slice(at, at + 64).map(async (path) => [path, await fileState(resolve(cwd, path))] as const))
    for (const [path, state] of batch) found.set(path, state)
  }
  return found
}

/** A bash call's changes against pre-call files, relative to `cwd`; no receipt outside a repository. */
const shell = (binding: FlowBinding.Binding, call: Cell.Call, cwd: string, onPatch: (receipt: Receipt) => void) =>
  Effect.gen(function*() {
    const jj = Subprocess.which("jj") !== null
      ? (yield* Effect.promise(() => command("jj", cwd, ["log", "--no-graph", "-r", "@", "-T", "commit_id"])))?.trim()
      : undefined
    if (jj) {
      const result = yield* binding.run(call)
      const diff = yield* Effect.promise(() => command("jj", cwd, ["diff", "--from", jj, "--git", "--color=never"]))
      const patches = diff === undefined ? [unavailable] : splitPatch(diff)
      if (patches.length > 0) yield* Effect.sync(() => onPatch({ call: identity(call.identity), patches }))
      return result
    }
    const candidates = yield* Effect.promise(() => gitPaths(cwd))
    if (candidates === undefined) return yield* binding.run(call)
    const before = yield* Effect.promise(() => states(cwd, candidates))
    const result = yield* binding.run(call)
    const afterPaths = yield* Effect.promise(() => gitPaths(cwd))
    if (afterPaths === undefined) return result
    const after = yield* Effect.promise(() => states(cwd, [...new Set([...candidates, ...afterPaths])]))
    const patches = [...after].flatMap(([path, next]) => {
      const old = before.get(path) ?? { digest: null, text: null, mode: undefined }
      const diff = changedPatch(path, old, next)
      return diff === undefined ? [] : [diff]
    })
    if (patches.length > 0) yield* Effect.sync(() => onPatch({ call: identity(call.identity), patches }))
    return result
  })

/** A write flow's changes: the files its input names, read before and after. */
const named = (binding: FlowBinding.Binding, call: Cell.Call, cwd: string, onPatch: (receipt: Receipt) => void) =>
  Effect.gen(function*() {
    const files = paths(call.flowName, call.input)
    const before = yield* Effect.promise(() => states(cwd, files))
    const result = yield* binding.run(call)
    const patches: Patch[] = []
    let additional = 0
    for (const path of files) {
      const old = before.get(path)
      const next = yield* Effect.promise(() => fileState(resolve(cwd, path)))
      const diff = changedPatch(path, old ?? { digest: null, text: null, mode: undefined }, next)
      if (diff === undefined) continue
      if (patches.length >= 200) {
        additional++
        continue
      }
      patches.push(diff)
    }
    if (additional > 0) {
      patches.push({
        path: "More changes",
        patch: `${additional} additional files; diff capture limited to 200 files.`
      })
    }
    // Empty is meaningful: a rejected/no-op write must not show a proposed edit as real.
    if (patches.length > 0) yield* Effect.sync(() => onPatch({ call: identity(call.identity), patches }))
    return result
  })

/** Wrap the existing bindings, without introducing another tool or execution model. */
export const capture = (
  source: FlowBinding.Source,
  cwd: string,
  onPatch: (receipt: Receipt) => void
): FlowBinding.Source => ({
  ...source,
  bindings: () =>
    source.bindings().pipe(Effect.map((bindings) =>
      bindings.map((binding) => ({
        ...binding,
        run: (call: Cell.Call) =>
          call.flowName === "bash" && Schema.decodeUnknownResult(Bash.Input)(call.input)._tag === "Success"
            ? shell(binding, call, cwd, onPatch)
            : named(binding, call, cwd, onPatch)
      }))
    ))
})
