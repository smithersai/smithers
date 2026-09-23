import * as NodeServices from "@effect/platform-node/NodeServices"
import * as StandardFlows from "@smthrs/agent/StandardFlows"
import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import * as Cell from "@smthrs/harness/Cell"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import { HarnessError } from "@smthrs/harness/HarnessError"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import { describe, expect, it } from "bun:test"
import { Effect, Exit, Fiber } from "effect"
import type * as FileSystem from "effect/FileSystem"
import type * as Path from "effect/Path"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as Approvals from "../src/approvals.ts"
import * as Runtime from "../src/runtime.ts"

const cwd = "/work/repo"

const descriptors = Effect.gen(function*() {
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path | ChildProcessSpawner>()
  const catalog = yield* FlowBinding.catalog([
    StandardFlows.filesystem(services),
    StandardFlows.shell(services),
    Runtime.source({ publish() {}, delegate() {}, read() {}, list() {} })
  ])
  return catalog.descriptors
}).pipe(Effect.provide(NodeServices.layer), Effect.runSync)

let ordinal = 0
const callOf = (flow: string, input: Record<string, unknown>) => {
  const descriptor = descriptors.find((each) => each.name === flow)
  if (descriptor === undefined) throw new Error(`no flow ${flow}`)
  return Cell.callOf(descriptor, {
    input: input as never,
    identity: new Cell.CallIdentity({
      session: "s",
      frame: 0,
      cell: "c",
      ordinal: ordinal++,
      declaration: "d",
      layers: []
    })
  })
}

const inputs: Record<string, Record<string, unknown>> = {
  read: { path: "a.js" },
  ls: { path: "." },
  glob: { pattern: "*.js" },
  grep: { pattern: "x" },
  write: { path: "a.js", content: "x" },
  edit: { path: "a.js", oldString: "a", newString: "b" },
  apply_patch: { input: "*** Begin Patch\n*** Update File: a.js\n*** End Patch" },
  bash: { command: "ls" },
  "ui.publish": { id: "p", title: "P", summary: "s", rows: [] },
  "agent.delegate": { id: "w", title: "W", prompt: "go" },
  "tab.read": { id: "w" },
  "tab.list": {}
}

/** Runs `effect` against a real attended store rooted at `cwd`. */
const withStore = <A, E>(
  mode: Approvals.Mode,
  effect: (grants: GrantStore.Service) => Effect.Effect<A, E>
): Promise<A> =>
  Effect.gen(function*() {
    return yield* effect(yield* GrantStore.GrantStore)
  }).pipe(Effect.provide(Approvals.layer(cwd, mode)), Effect.scoped, Effect.runPromise)

const settledPending = (grants: GrantStore.Service, count: number) =>
  Effect.gen(function*() {
    for (let attempt = 0; attempt < 200; attempt++) {
      const list = yield* grants.list
      if (list.length === count) return Approvals.pending(list)
      yield* Effect.sleep("5 millis")
    }
    return yield* Effect.die(new Error(`never reached ${count} pending`))
  })

describe("classification", () => {
  it("asks for exactly the flows that change files or run commands", () => {
    const asked = descriptors.filter((descriptor) =>
      Approvals.requests(callOf(descriptor.name, inputs[descriptor.name] ?? {}), cwd, "chat").length > 0
    ).map((descriptor) => descriptor.name).sort()
    const silent = descriptors.filter((descriptor) =>
      Approvals.requests(callOf(descriptor.name, inputs[descriptor.name] ?? {}), cwd, "chat").length === 0
    ).map((descriptor) => descriptor.name).sort()
    expect(asked).toEqual(["apply_patch", "bash", "edit", "write"])
    expect(silent).toEqual(["agent.delegate", "glob", "grep", "ls", "read", "tab.list", "tab.read", "ui.publish"])
    expect(asked.length + silent.length).toBe(descriptors.length)
  })

  it("counts network egress as consequential and a model call as not", () => {
    expect(Approvals.consequential(Capability.make("net:get", "https://example.com"), cwd)).toBe(true)
    expect(Approvals.consequential(Capability.make("net:post", "https://example.com"), cwd)).toBe(true)
    expect(Approvals.consequential(Capability.make("model:call", "openai"), cwd)).toBe(false)
    expect(Approvals.consequential(Capability.make("fs:read", "/etc/passwd"), cwd)).toBe(false)
  })
})

describe("resource narrowing", () => {
  it("names the file an edit touches, inside the workspace", () => {
    const [request] = Approvals.requests(callOf("edit", { path: "src/a.js", oldString: "a", newString: "b" }), cwd, "t1")
    expect(Capability.format(request!.capability)).toBe(`fs:write:${cwd}/src/a.js`)
    expect(request!.meta).toEqual({ flow: "edit", subject: "src/a.js", source: "t1" })
  })

  it("marks a write outside the workspace irreversible, with no always", async () => {
    const pending = await withStore("ask", (grants) =>
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(
          Approvals.authorize(grants, { cwd, source: "chat" })(callOf("write", { path: "/etc/hosts", content: "x" }))
        )
        const pending = yield* settledPending(grants, 1)
        yield* Fiber.interrupt(fiber)
        return pending
      }))
    expect(pending[0]!.tier).toBe("irreversible")
    expect(pending[0]!.always).toBe(false)
  })

  it("keys bash on the flow and shows the command", async () => {
    const [request] = Approvals.requests(callOf("bash", { command: "rm -rf build" }), cwd, "chat")
    expect(Capability.format(request!.capability)).toBe("proc:spawn:bash")
    expect(request!.meta.subject).toBe("rm -rf build")
    const pending = await withStore("ask", (grants) =>
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(
          Approvals.authorize(grants, { cwd, source: "chat" })(callOf("bash", { command: "rm -rf build" }))
        )
        const pending = yield* settledPending(grants, 1)
        yield* Fiber.interrupt(fiber)
        return pending
      }))
    expect(pending[0]).toMatchObject({ flow: "bash", subject: "rm -rf build", always: true, source: "chat" })
  })

  it("asks once per file an apply_patch touches", () => {
    const patch = "*** Begin Patch\n*** Update File: a.js\n*** Delete File: b.js\n*** End Patch"
    const requests = Approvals.requests(callOf("apply_patch", { input: patch }), cwd, "chat")
    expect(requests.map((request) => Capability.format(request.capability))).toEqual([
      `fs:write:${cwd}/a.js`,
      `fs:write:${cwd}/b.js`
    ])
  })
})

describe("the attended store", () => {
  const edit = (path = "src/a.js") => callOf("edit", { path, oldString: "a", newString: "b" })

  it("suspends a consequential call until y, and y is not remembered", async () => {
    const result = await withStore("ask", (grants) =>
      Effect.gen(function*() {
        const authorize = Approvals.authorize(grants, { cwd, source: "t1" })
        const first = yield* Effect.forkChild(authorize(edit()))
        const [pending] = yield* settledPending(grants, 1)
        yield* Approvals.reply(grants, pending!, "once", cwd)
        const firstExit = yield* Fiber.await(first)
        const second = yield* Effect.forkChild(authorize(edit()))
        const again = yield* settledPending(grants, 1)
        yield* Fiber.interrupt(second)
        return { pending, firstExit, again }
      }))
    expect(result.pending).toMatchObject({ flow: "edit", subject: "src/a.js", source: "t1", always: true })
    expect(Exit.isSuccess(result.firstExit)).toBe(true)
    expect(result.again).toHaveLength(1)
  })

  it("n fails the call with a denial the harness hands to the cell", async () => {
    const exit = await withStore("ask", (grants) =>
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(Approvals.authorize(grants, { cwd, source: "chat" })(edit()))
        const [pending] = yield* settledPending(grants, 1)
        yield* Approvals.reply(grants, pending!, "deny", cwd)
        return yield* Fiber.await(fiber)
      }))
    expect(Exit.isFailure(exit)).toBe(true)
    const error = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
    const failure = error !== undefined && "error" in error ? error.error : undefined
    expect(failure).toBeInstanceOf(HarnessError)
    expect((failure as HarnessError).cause).toBeInstanceOf(Permission.PermissionDenied)
    expect((failure as HarnessError).message).toBe("Denied: edit src/a.js")
  })

  it("a allows the rest of the workspace for the session, and nothing outside it", async () => {
    const result = await withStore("ask", (grants) =>
      Effect.gen(function*() {
        const authorize = Approvals.authorize(grants, { cwd, source: "chat" })
        const first = yield* Effect.forkChild(authorize(edit()))
        const [pending] = yield* settledPending(grants, 1)
        yield* Approvals.reply(grants, pending!, "run", cwd)
        yield* Fiber.join(first)
        yield* authorize(edit("lib/other.js"))
        const listed = (yield* grants.list).length
        const outside = yield* Effect.forkChild(authorize(edit("/tmp/elsewhere.js")))
        const stillAsks = yield* settledPending(grants, 1)
        yield* Fiber.interrupt(outside)
        return { listed, stillAsks }
      }))
    expect(result.listed).toBe(0)
    expect(result.stillAsks[0]!.subject).toBe("/tmp/elsewhere.js")
  })

  it("drops a request whose caller stopped waiting", async () => {
    const after = await withStore("ask", (grants) =>
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(Approvals.authorize(grants, { cwd, source: "chat" })(edit()))
        yield* settledPending(grants, 1)
        yield* Fiber.interrupt(fiber)
        return yield* grants.list
      }))
    expect(after).toEqual([])
  })

  it("deny mode refuses at once and never queues", async () => {
    const started = Date.now()
    const result = await withStore("deny", (grants) =>
      Effect.gen(function*() {
        const authorize = Approvals.authorize(grants, { cwd, source: "chat" })
        const edited = yield* Effect.exit(authorize(edit()))
        const ran = yield* Effect.exit(authorize(callOf("bash", { command: "ls" })))
        return { edited, ran, listed: yield* grants.list }
      }))
    expect(Date.now() - started).toBeLessThan(1000)
    for (const exit of [result.edited, result.ran]) {
      expect(Exit.isFailure(exit)).toBe(true)
      const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
      const failure = reason !== undefined && "error" in reason ? reason.error as HarnessError : undefined
      expect(failure?.cause).toBeInstanceOf(Permission.PermissionDenied)
    }
    expect(result.listed).toEqual([])
  })

  it("lets a read through without asking", async () => {
    await withStore("ask", (grants) =>
      Approvals.authorize(grants, { cwd, source: "chat" })(callOf("read", { path: "a.js" })))
  })
})

describe("mode", () => {
  it("asks interactively and denies in print mode by default", () => {
    expect(Approvals.mode({}, { print: false })).toBe("ask")
    expect(Approvals.mode({}, { print: true })).toBe("deny")
  })

  it("accepts ask, all and deny, and refuses ask in print mode", () => {
    for (const value of ["ask", "all", "deny"] as const) {
      expect(Approvals.mode({ SMITHERS_TUI_APPROVE: value }, { print: false })).toBe(value)
    }
    expect(Approvals.mode({ SMITHERS_TUI_APPROVE: "all" }, { print: true })).toBe("all")
    expect(Approvals.mode({ SMITHERS_TUI_APPROVE: "deny" }, { print: true })).toBe("deny")
    expect(Approvals.mode({ SMITHERS_TUI_APPROVE: "ask" }, { print: true })).toEqual({
      error: "SMITHERS_TUI_APPROVE=ask needs the interactive TUI"
    })
  })

  it("refuses anything else", () => {
    expect(Approvals.mode({ SMITHERS_TUI_APPROVE: "yes" }, { print: false })).toEqual({
      error: "SMITHERS_TUI_APPROVE must be ask, all or deny"
    })
  })
})

describe("key", () => {
  const pending = (always: boolean): Approvals.Pending => ({
    requestId: "permission-1",
    flow: "edit",
    subject: "a.js",
    source: "chat",
    action: "fs:write",
    tier: "compensable",
    always
  })
  const state = (overrides: Partial<Parameters<typeof Approvals.key>[1]> = {}) => ({
    draft: "",
    shift: false,
    ctrl: false,
    meta: false,
    pending: [pending(true)],
    ...overrides
  })

  it("answers y, n and a from an empty editor while a request waits", () => {
    expect(Approvals.key("y", state())).toBe("once")
    expect(Approvals.key("n", state())).toBe("deny")
    expect(Approvals.key("a", state())).toBe("run")
    expect(Approvals.key("x", state())).toBeUndefined()
  })

  it("never takes a key when nothing waits, the editor has text, or a modifier is held", () => {
    expect(Approvals.key("y", state({ pending: [] }))).toBeUndefined()
    expect(Approvals.key("y", state({ draft: "h" }))).toBeUndefined()
    expect(Approvals.key("y", state({ shift: true }))).toBeUndefined()
    expect(Approvals.key("y", state({ ctrl: true }))).toBeUndefined()
    expect(Approvals.key("y", state({ meta: true }))).toBeUndefined()
  })

  it("offers a only where the store can grant it", () => {
    expect(Approvals.key("a", state({ pending: [pending(false)] }))).toBeUndefined()
  })
})
