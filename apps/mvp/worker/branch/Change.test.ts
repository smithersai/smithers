// A working copy's change read from its machine (worker/branch/Change.ts) over a test `Machines`, an injected Effect
// service that answers each tool call as a branch's machine does: the change, and each reason it can't be committed.
import type { SandboxTools } from "@smthrs/sandbox"
import { Cause, Effect, Exit, Layer } from "effect"
import { describe, expect, test } from "vitest"
import { base64Of, ChangeRefused, ChangeUnavailable, collect } from "./Change.ts"
import { Machines } from "./Machines.ts"

const BASE = "a".repeat(40)

/** A machine whose status lists `entries` and whose reads answer `files`; `fail` names a tool that fails with a tag. */
const machine = (
  entries: ReadonlyArray<{ readonly path: string; readonly index: string; readonly worktree: string }>,
  files: Readonly<Record<string, string>>,
  options: { readonly fail?: { readonly tool: string; readonly tag: string }; readonly truncated?: boolean } = {},
) => {
  const calls: Array<{ readonly callId: string; readonly call: SandboxTools.Call }> = []
  const layer = Layer.succeed(Machines, Machines.of({
    tool: (_branch, _owner, callId, call) =>
      Effect.suspend((): Effect.Effect<{ readonly result: SandboxTools.Result; readonly generation: number }> => {
        calls.push({ callId, call })
        if (options.fail?.tool === call.tool) return Effect.fail({ _tag: options.fail.tag } as never)
        if (call.tool === "status") return Effect.succeed({ result: { tool: "status", branch: null, entries: [...entries] }, generation: 1 })
        if (call.tool === "read") {
          const content = files[call.path]!
          return Effect.succeed({
            result: { tool: "read", path: call.path, content, bytes: new TextEncoder().encode(content).length, truncated: options.truncated ?? false },
            generation: 1,
          })
        }
        return Effect.die("unused")
      }),
    commands: () => Effect.die("unused") as never,
    sleepIfIdle: () => Effect.die("unused"),
  }))
  return { calls, layer }
}

/** The change read, or the error it failed with. */
const read = async (fake: ReturnType<typeof machine>, limits: { readonly maxFiles?: number; readonly maxBytes?: number } = {}) => {
  const exit = await Effect.runPromise(Effect.exit(collect({
    branch: { branchId: "b", owner: "acme", name: "widgets", branch: "try-1", namespace: "ephemeral" },
    ownerId: "maya",
    base: BASE,
    maxFiles: limits.maxFiles ?? 50,
    maxBytes: limits.maxBytes ?? 1024,
    callId: (name) => Effect.succeed(`call:${name}`),
  }).pipe(Effect.provide(fake.layer))))
  return Exit.isSuccess(exit) ? exit.value : Cause.squash(exit.cause)
}

describe("Change.collect", () => {
  test("reads every changed file whole and every deleted path, against the base, with stable call ids", async () => {
    const fake = machine(
      [
        { path: "README.md", index: " ", worktree: "M" },
        { path: "new.md", index: "?", worktree: "?" },
        { path: "gone.md", index: " ", worktree: "D" },
        { path: "staged-gone.md", index: "D", worktree: " " },
      ],
      { "README.md": "héllo\n", "new.md": "new\n" },
    )
    expect(await read(fake)).toEqual({
      additions: [{ path: "README.md", contents: base64Of("héllo\n") }, { path: "new.md", contents: base64Of("new\n") }],
      deletions: ["gone.md", "staged-gone.md"],
    })
    expect(fake.calls.map(({ callId, call }) => [callId, call.tool === "status" ? call.base : call.tool])).toEqual([
      ["call:status", BASE],
      ["call:read:README.md", "read"],
      ["call:read:new.md", "read"],
    ])
  })

  test.each<readonly [string, ReturnType<typeof machine>, { readonly maxFiles?: number; readonly maxBytes?: number }, string]>([
    ["nothing changed", machine([], {}), {}, "empty"],
    ["more files than allowed", machine([{ path: "a", index: "?", worktree: "?" }, { path: "b", index: "?", worktree: "?" }], { a: "", b: "" }), { maxFiles: 1 }, "too_large"],
    ["more bytes than allowed", machine([{ path: "a", index: "?", worktree: "?" }], { a: "12345" }), { maxBytes: 4 }, "too_large"],
    ["a file read only in part", machine([{ path: "a", index: "?", worktree: "?" }], { a: "x" }, { truncated: true }), {}, "too_large"],
    ["a refused call", machine([], {}, { fail: { tool: "status", tag: "@smthrs/sandbox/SandboxTools/ToolRefused" } }), {}, "refused"],
    ["a checkout that failed", machine([{ path: "a", index: "?", worktree: "?" }], {}, { fail: { tool: "read", tag: "@smthrs/mvp/branch/CheckoutFailed" } }), {}, "refused"],
  ])("%s is refused %s", async (_, fake, limits, reason) => {
    expect(await read(fake, limits)).toEqual(new ChangeRefused({ reason: reason as ChangeRefused["reason"] }))
  })

  test.each(["@smthrs/mvp/branch/SandboxUnavailable", "@smthrs/sandbox/SandboxTools/ToolLost", "@smthrs/mvp/branch/SandboxStartTimedOut"])(
    "a machine that can't answer (%s) is unavailable, for the step to try again",
    async (tag) => {
      expect(await read(machine([], {}, { fail: { tool: "status", tag } }))).toEqual(new ChangeUnavailable())
    },
  )

  test("base64 of UTF-8, in chunks, for a file larger than one chunk", () => {
    expect(base64Of("é\n")).toBe(btoa(String.fromCharCode(0xc3, 0xa9, 0x0a)))
    const big = "é".repeat(0x9000)
    expect(base64Of(big)).toBe(Buffer.from(big, "utf8").toString("base64"))
  })
})
