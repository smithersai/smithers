import { SandboxTools } from "@smthrs/sandbox"
import { Effect, Schema } from "effect"
import { Machines } from "./Machines.ts"
import type { SandboxBranch } from "./Sandboxes.ts"

// A working copy's change, read whole from its branch's machine (docs/features/branch-publish.md#publish,
// docs/features/todos.md#the-run): every file that differs from an immutable base commit, local commits included, each
// changed file's contents base64 and each deleted path, within a count and a size. Publish and the `todo` run commit
// what this reads. Nothing here writes: a step that runs again reads again, and its writes are found by their keys.

/** The change: each changed file base64, as `createCommitOnBranch` takes it, and each deleted path. */
export const Change = Schema.Struct({
  additions: Schema.Array(Schema.Struct({ path: Schema.String, contents: Schema.String })),
  deletions: Schema.Array(Schema.String),
})
export type Change = typeof Change.Type

/**
 * Why a change can't be committed: nothing differs from the base (`empty`), more files or bytes than allowed or a file
 * the tools would only read in part (`too_large`), or the machine refused the call or couldn't check the branch out
 * (`refused`). Not retried.
 */
export class ChangeRefused extends Schema.TaggedError<ChangeRefused>()("@smthrs/mvp/branch/ChangeRefused", {
  reason: Schema.Literals(["empty", "too_large", "refused"]),
}) {}

/** The machine couldn't answer, or lost the call: a step tries again. */
export class ChangeUnavailable extends Schema.TaggedError<ChangeUnavailable>()("@smthrs/mvp/branch/ChangeUnavailable", {}) {}

/** Text as base64 of its UTF-8 bytes, as `createCommitOnBranch` takes a file's contents. */
export const base64Of = (text: string): string => {
  const bytes = new TextEncoder().encode(text)
  let binary = ""
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary)
}

/** A git status entry that says the file is gone from the working copy. */
const deleted = (entry: { readonly index: string; readonly worktree: string }) => entry.worktree === "D" || entry.index === "D"

/** What `collect` reads with: the machine, as whom, the base, the limits, and each tool call's stable id. */
export interface Collecting {
  readonly branch: SandboxBranch
  /** The person whose own user runs the tools. */
  readonly ownerId: string
  /** The commit the change is measured from. */
  readonly base: string
  readonly maxFiles: number
  readonly maxBytes: number
  /** The id of the step's call `name` (`status`, `read:<path>`): the same every time the step runs. */
  readonly callId: (name: string) => Effect.Effect<string>
}

/** Reads the change from the machine as `collecting` says. */
export const collect = (collecting: Collecting) =>
  Effect.gen(function* () {
    const machines = yield* Machines
    const tool = (name: string, call: SandboxTools.Call) =>
      Effect.flatMap(collecting.callId(name), (callId) => machines.tool(collecting.branch, collecting.ownerId, callId, call)).pipe(
        Effect.map((ran) => ran.result),
        Effect.mapError((error) =>
          error._tag === "@smthrs/sandbox/SandboxTools/ToolRefused" || error._tag === "@smthrs/mvp/branch/CheckoutFailed"
            ? new ChangeRefused({ reason: "refused" })
            : new ChangeUnavailable()
        ),
      )
    // A tool answers its own call's result.
    const { entries } = (yield* tool("status", { tool: "status", base: collecting.base })) as typeof SandboxTools.StatusResult.Type
    if (entries.length === 0) return yield* new ChangeRefused({ reason: "empty" })
    if (entries.length > collecting.maxFiles) return yield* new ChangeRefused({ reason: "too_large" })
    const additions: Array<{ readonly path: string; readonly contents: string }> = []
    const deletions: Array<string> = []
    let bytes = 0
    for (const entry of entries) {
      if (deleted(entry)) {
        deletions.push(entry.path)
        continue
      }
      const read = (yield* tool(`read:${entry.path}`, { tool: "read", path: entry.path })) as typeof SandboxTools.ReadResult.Type
      if (read.truncated) return yield* new ChangeRefused({ reason: "too_large" })
      bytes += read.bytes
      additions.push({ path: entry.path, contents: base64Of(read.content) })
    }
    if (bytes > collecting.maxBytes) return yield* new ChangeRefused({ reason: "too_large" })
    return { additions, deletions } satisfies Change
  }).pipe(Effect.withSpan("branch.change.collect"))
