/** Capture actual before/after file contents at the executable flow boundary. */
import type * as Cell from "@smthrs/harness/Cell"
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as ApplyPatch from "@smthrs/std/ApplyPatch"
import { createTwoFilesPatch } from "diff"
import { Effect } from "effect"
import { copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
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

/**
 * The working tree under `cwd` as a git tree, staged into a private copy of
 * the repository's index: git's stat cache rereads only files that changed,
 * and the real index and HEAD are untouched. `undefined` outside a repository.
 */
const gitSnapshot = async (cwd: string, index: string): Promise<string | undefined> => {
  const env = { GIT_INDEX_FILE: index }
  if ((await git(cwd, ["add", "-A", "--", "."], env)) === undefined) return undefined
  const tree = (await git(cwd, ["write-tree"], env))?.trim()
  return tree === "" ? undefined : tree
}
const gitIndex = async (cwd: string): Promise<{ readonly index: string; readonly dispose: () => Promise<void> } | undefined> => {
  const real = (await git(cwd, ["rev-parse", "--git-path", "index"]))?.trim()
  if (real === undefined || real === "") return undefined
  const folder = await mkdtemp(join(tmpdir(), "smithers-capture-"))
  const index = join(folder, "index")
  try {
    await copyFile(resolve(cwd, real), index)
  } catch { /* A repository with nothing staged yet has no index. */ }
  return { index, dispose: () => rm(folder, { recursive: true, force: true }) }
}

/** A bash call's changes: the VCS's own before/after diff, relative to `cwd`; no receipt outside a repository. */
const shell = (binding: FlowBinding.Binding, call: Cell.Call, cwd: string, onPatch: (receipt: Receipt) => void) =>
  Effect.gen(function*() {
    const jj = Subprocess.which("jj") !== null
      ? (yield* Effect.promise(() => command("jj", cwd, ["log", "--no-graph", "-r", "@", "-T", "commit_id"])))?.trim()
      : undefined
    if (jj) {
      const result = yield* binding.run(call)
      const diff = yield* Effect.promise(() => command("jj", cwd, ["diff", "--from", jj, "--git", "--color=never"]))
      yield* Effect.sync(() => onPatch({ call: identity(call.identity), patches: diff === undefined ? [unavailable] : splitPatch(diff) }))
      return result
    }
    const scratch = yield* Effect.promise(() => gitIndex(cwd))
    const before = scratch === undefined ? undefined : yield* Effect.promise(() => gitSnapshot(cwd, scratch.index))
    if (scratch === undefined || before === undefined) {
      if (scratch !== undefined) yield* Effect.promise(scratch.dispose)
      return yield* binding.run(call)
    }
    return yield* binding.run(call).pipe(
      Effect.tap(() =>
        Effect.promise(async () => {
          const after = await gitSnapshot(cwd, scratch.index)
          const diff = after === undefined
            ? undefined
            : await git(cwd, ["diff", "--no-color", "--no-ext-diff", "--no-renames", "--relative", before, after])
          onPatch({ call: identity(call.identity), patches: diff === undefined ? [unavailable] : splitPatch(diff) })
        })
      ),
      Effect.ensuring(Effect.promise(scratch.dispose))
    )
  })

/** A write flow's changes: the files its input names, read before and after. */
const named = (binding: FlowBinding.Binding, call: Cell.Call, cwd: string, onPatch: (receipt: Receipt) => void) =>
  Effect.gen(function*() {
    const files = paths(call.flowName, call.input)
    const before = new Map(
      yield* Effect.promise(() =>
        Promise.all(files.slice(0, 200).map(async (path) => [path, await read(resolve(cwd, path))] as const))
      )
    )
    const modes = new Map(
      yield* Effect.promise(() =>
        Promise.all(files.slice(0, 200).map(async (path) => [path, await mode(resolve(cwd, path))] as const))
      )
    )
    const result = yield* binding.run(call)
    const patches: Patch[] = []
    for (const path of files.slice(0, 200)) {
      const old = before.get(path)
      const next = yield* Effect.promise(() => read(resolve(cwd, path)))
      if (old === undefined || next === undefined || (old !== null && old.length > maxBytes)) {
        patches.push({ path, patch: `Binary or large file: ${path}` })
      } else {
        const diff = patch(path, old, next, next !== null ? undefined : modes.get(path))
        if (diff !== undefined) patches.push(diff)
      }
    }
    if (files.length > 200) {
      patches.push({
        path: "More changes",
        patch: `${files.length - 200} additional files; diff capture limited to 200 files.`
      })
    }
    // Empty is meaningful: a rejected/no-op write must not show a proposed edit as real.
    if (files.length > 0) yield* Effect.sync(() => onPatch({ call: identity(call.identity), patches }))
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
          call.flowName === "bash" ? shell(binding, call, cwd, onPatch) : named(binding, call, cwd, onPatch)
      }))
    ))
})
