/** Capture actual before/after file contents at the executable flow boundary. */
import type * as Cell from "@smthrs/harness/Cell"
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import { createTwoFilesPatch } from "diff"
import { Effect } from "effect"
import { readFile, stat } from "node:fs/promises"
import { resolve } from "node:path"

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
export const paths = (flow: string, input: unknown): string[] => {
  if (input === null || typeof input !== "object") return []
  const value = input as Record<string, unknown>
  if ((flow === "edit" || flow === "write") && typeof value.path === "string") return [value.path]
  if (flow === "apply_patch" && typeof value.input === "string") {
    return [
      ...new Set(
        [...value.input.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map((match) =>
          match[1]!.trim()
        )
      )
    ]
  }
  return []
}
const command = async (program: string, cwd: string, args: string[]): Promise<string | undefined> => {
  try {
    const child = Bun.spawn([program, ...args], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }
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
const git = (cwd: string, args: string[]) => command("git", cwd, args)
export const splitPatch = (diff: string): Patch[] =>
  diff.split(/(?=^diff --git )/m).filter((part) => part.trim() !== "").map((patch) => {
    const added = patch.match(/^\+\+\+ (?:b\/)?(.+)$/m)?.[1]
    const removed = patch.match(/^--- (?:a\/)?(.+)$/m)?.[1]
    const path = (added === "/dev/null" ? removed : added) ?? removed ??
      patch.match(/^diff --git a\/.+ b\/(.+)$/m)?.[1] ?? "Changes"
    return { path: path.replace(/\t.*$/, ""), patch }
  })
const changed = async (cwd: string, revision: string): Promise<string[]> => {
  const [tracked, untracked] = await Promise.all([
    git(cwd, ["diff", "--name-only", "-z", revision, "--"]),
    git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])
  ])
  return [...new Set(`${tracked ?? ""}${untracked ?? ""}`.split("\0").filter(Boolean))]
}
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
          Effect.gen(function*() {
            const jj = call.flowName === "bash" && Bun.which("jj") !== null
              ? (yield* Effect.promise(() => command("jj", cwd, ["log", "--no-graph", "-r", "@", "-T", "commit_id"])))
                ?.trim()
              : undefined
            const revision = call.flowName === "bash" && !jj
              ? (yield* Effect.promise(() => git(cwd, ["rev-parse", "--verify", "HEAD"])))?.trim()
              : undefined
            const files = revision === undefined
              ? paths(call.flowName, call.input)
              : yield* Effect.promise(() => changed(cwd, revision))
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
            if (jj) {
              const diff = yield* Effect.promise(() =>
                command("jj", cwd, ["diff", "--from", jj, "--git", "--color=never"])
              )
              yield* Effect.sync(() =>
                onPatch({
                  call: identity(call.identity),
                  patches: diff === undefined
                    ? [{ path: "Changes", patch: "Diff unavailable or too large." }]
                    : splitPatch(diff)
                })
              )
              return result
            }
            const afterFiles = revision === undefined
              ? files
              : [...new Set([...files, ...yield* Effect.promise(() => changed(cwd, revision))])]
            const patches: Patch[] = []
            for (const path of afterFiles.slice(0, 200)) {
              const old = before.has(path)
                ? before.get(path)
                : yield* Effect.promise(async () => (await git(cwd, ["show", `${revision}:${path}`])) ?? null)
              const next = yield* Effect.promise(() => read(resolve(cwd, path)))
              if (old === undefined || next === undefined || (old !== null && old.length > maxBytes)) {
                patches.push({ path, patch: `Binary or large file: ${path}` })
              } else {
                const deleted = next !== null ? undefined : modes.has(path) || revision === undefined
                  ? modes.get(path)
                  : yield* Effect.promise(async () => {
                    const entry = await git(cwd, ["ls-tree", revision, "--", path])
                    const bits = entry === undefined ? Number.NaN : parseInt(entry, 8)
                    return Number.isNaN(bits) ? undefined : bits & 0o777
                  })
                const diff = patch(path, old, next, deleted)
                if (diff !== undefined) patches.push(diff)
              }
            }
            if (afterFiles.length > 200) {
              patches.push({
                path: "More changes",
                patch: `${afterFiles.length - 200} additional files; diff capture limited to 200 files.`
              })
            }
            // Empty is meaningful: a rejected/no-op write must not show a proposed edit as real,
            // and a shell call observed by the VCS that changed nothing is captured, not unknown.
            if (afterFiles.length > 0 || revision !== undefined) yield* Effect.sync(() => onPatch({ call: identity(call.identity), patches }))
            return result
          })
      }))
    ))
})
