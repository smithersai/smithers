/**
 * The ACP client against a real agent process: the deterministic test agent
 * in `fixtures/acp-test-agent.mjs`, spawned with Node and spoken to over its
 * stdio. Protocol edge cases an honest agent never sends (a malformed
 * permission request, a response with no result) are fed as lines through a
 * transport value, which is the client's whole input.
 */
import { Acp } from "@smthrs/agent"
import { Cause, Effect, Exit, Fiber, Option, Queue, Stream } from "effect"
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

const FIXTURE = fileURLToPath(new URL("./fixtures/acp-test-agent.mjs", import.meta.url))

let root = ""
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "acp-client-"))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** The test agent as a child process, and the transport over its stdio. Killed with the scope. */
const agent = (env: Record<string, string> = {}) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      spawn(process.execPath, [FIXTURE], {
        env: { ...process.env, ACP_TEST_AGENT_STATE: join(root, "state"), ...env },
        stdio: ["pipe", "pipe", "inherit"]
      })
    ),
    (child) => Effect.sync(() => void child.kill("SIGKILL"))
  ).pipe(Effect.map((child) => ({
    child,
    transport: {
      incoming: Stream.fromAsyncIterable(createInterface({ input: child.stdout }), (error) => error),
      send: (line: string) =>
        Effect.tryPromise(() =>
          new Promise<void>((done, fail) => child.stdin.write(`${line}\n`, (error) => error ? fail(error) : done()))
        )
    } satisfies Acp.Transport<unknown>
  })))

/** A client of a fresh test agent, recording every update it streams. */
const connect = (options: { readonly env?: Record<string, string>; readonly permission?: Acp.Permission } = {}) =>
  Effect.gen(function*() {
    const updates: Array<Acp.Update> = []
    const { child, transport } = yield* agent(options.env)
    const client = yield* Acp.make(transport, {
      onUpdate: (update) => Effect.sync(() => void updates.push(update)),
      permission: options.permission,
      clientInfo: { name: "acp-test", version: "1.0.0" }
    })
    return { child, client, updates }
  })

const run = <A, E>(effect: Effect.Effect<A, E, import("effect/Scope").Scope>) =>
  Effect.runPromise(Effect.scoped(effect))
const runExit = <A, E>(effect: Effect.Effect<A, E, import("effect/Scope").Scope>) =>
  Effect.runPromiseExit(Effect.scoped(effect))

const texts = (updates: ReadonlyArray<Acp.Update>) =>
  updates.flatMap((update) => Option.toArray(Acp.messageText(update)))

const failureOf = <E>(exit: Exit.Exit<unknown, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const failure = Cause.findErrorOption(exit.cause)
  if (Option.isNone(failure)) throw new Error("expected a typed failure")
  return failure.value
}

describe("Acp against the test agent", () => {
  test("initializes, opens a session, and runs a prompt turn to end_turn with its updates", async () => {
    const result = await run(Effect.gen(function*() {
      const { client, updates } = yield* connect()
      const initialized = yield* client.initialize
      const session = yield* client.newSession(root)
      const stop = yield* client.prompt(session, "add the line `alpha` to `NOTES.md`")
      return { initialized, stop, updates, session }
    }))
    expect(result.initialized).toEqual({ protocolVersion: 1, loadSession: true })
    expect(result.stop).toBe("end_turn")
    expect(readFileSync(join(root, "NOTES.md"), "utf8")).toBe("alpha\n")
    const kinds = result.updates.map((update) => update.kind)
    expect(kinds).toEqual([
      "agent_message_chunk",
      "tool_call",
      "tool_call_update",
      "agent_message_chunk",
      "usage_update"
    ])
    expect(result.updates.every((update) => update.sessionId === result.session)).toBe(true)
    expect(texts(result.updates)).toEqual(["Working through 1 instructions.", "Done."])
    const usage = result.updates.flatMap((update) => Option.toArray(Acp.usage(update)))
    expect(usage).toEqual([{ contextTokens: 1234, costUsd: 0 }])
  })

  test("cancel ends a turn in the middle of a tool call with stop reason cancelled", async () => {
    const stop = await run(Effect.gen(function*() {
      const { client, updates } = yield* connect()
      yield* client.initialize
      const session = yield* client.newSession(root)
      const turn = yield* Effect.forkChild(client.prompt(session, "run `sleep 30`"))
      while (!updates.some((update) => update.kind === "tool_call")) yield* Effect.sleep(10)
      yield* client.cancel(session)
      const stop = yield* Fiber.join(turn)
      expect(updates.find((update) => update.kind === "tool_call_update")?.update.status).toBe("failed")
      return stop
    }))
    expect(stop).toBe("cancelled")
  })

  test("loads a session it ran before and continues its pending instructions", async () => {
    const state = { session: "" }
    await run(Effect.gen(function*() {
      const { client } = yield* connect()
      yield* client.initialize
      state.session = yield* client.newSession(root)
      expect(yield* client.prompt(state.session, "refuse\nadd the line `beta` to `NOTES.md`")).toBe("refusal")
    }))
    const stop = await run(Effect.gen(function*() {
      const { client } = yield* connect()
      yield* client.initialize
      yield* client.loadSession(state.session, root)
      return yield* client.prompt(state.session, "Continue")
    }))
    expect(stop).toBe("end_turn")
    expect(readFileSync(join(root, "NOTES.md"), "utf8")).toBe("beta\n")
  })

  test("answers permission requests by policy, and cancelled when no option fits", async () => {
    const allow = await run(Effect.gen(function*() {
      const { client, updates } = yield* connect()
      yield* client.initialize
      const session = yield* client.newSession(root)
      yield* client.prompt(
        session,
        "ask permission\nask permission reject_once,allow_always,allow_once\nask permission other"
      )
      return texts(updates)
    }))
    expect(allow).toContain("permission: allow_once-0")
    expect(allow).toContain("permission: allow_always-1")
    expect(allow).toContain("permission: cancelled")
    const reject = await run(Effect.gen(function*() {
      const { client, updates } = yield* connect({ permission: "reject" })
      yield* client.initialize
      const session = yield* client.newSession(root)
      yield* client.prompt(session, "ask permission\nask permission allow_once,reject_always")
      return texts(updates)
    }))
    expect(reject).toContain("permission: reject_once-1")
    expect(reject).toContain("permission: reject_always-1")
  })

  test("refuses file system requests as method not found, and passes leaked text on unchanged", async () => {
    const said = await run(Effect.gen(function*() {
      const { client, updates } = yield* connect()
      yield* client.initialize
      const session = yield* client.newSession(root)
      yield* client.prompt(session, "read a file\nleak sentinel-123")
      return texts(updates)
    }))
    expect(said).toContain("fs: -32601")
    expect(said).toContain("sentinel-123")
  })

  test("skips lines that aren't messages, updates that aren't updates, and responses to nothing", async () => {
    const stop = await run(Effect.gen(function*() {
      const { client } = yield* connect()
      yield* client.initialize
      const session = yield* client.newSession(root)
      return yield* client.prompt(session, "say garbage\nadd the line `after` to `NOTES.md`")
    }))
    expect(stop).toBe("end_turn")
    expect(readFileSync(join(root, "NOTES.md"), "utf8")).toBe("after\n")
  })

  test("an agent that exits mid-turn fails the turn and every later request closed", async () => {
    const errors = await run(Effect.gen(function*() {
      const { client } = yield* connect()
      yield* client.initialize
      const session = yield* client.newSession(root)
      const turn = yield* Effect.flip(client.prompt(session, "exit"))
      const later = yield* Effect.flip(client.newSession(root))
      return [turn, later]
    }))
    expect(errors.map((error) => [error.code, error.method])).toEqual([["closed", "session/prompt"], [
      "closed",
      "session/new"
    ]])
  })

  test("a result the protocol doesn't allow fails protocol; an error answer fails remote with its code", async () => {
    const badInitialize = await runExit(Effect.gen(function*() {
      const { client } = yield* connect({ env: { ACP_TEST_AGENT_MODE: "bad-initialize" } })
      return yield* client.initialize
    }))
    expect(failureOf(badInitialize)).toMatchObject({ code: "protocol", method: "initialize" })
    const errors = await run(Effect.gen(function*() {
      const { client } = yield* connect({ env: { ACP_TEST_AGENT_NO_LOAD: "1" } })
      expect((yield* client.initialize).loadSession).toBe(false)
      const load = yield* Effect.flip(client.loadSession("no-such-session", root))
      const session = yield* client.newSession(root)
      const prompt = yield* Effect.flip(client.prompt(session, "answer badly"))
      const unknown = yield* Effect.flip(client.prompt("no-such-session", "hello"))
      return { load, prompt, unknown }
    }))
    expect(errors.load).toMatchObject({ code: "remote", method: "session/load", rpcCode: -32002 })
    expect(errors.prompt).toMatchObject({ code: "protocol", method: "session/prompt" })
    expect(errors.unknown).toMatchObject({ code: "remote", rpcCode: -32002 })
  })
})

describe("Acp at the edges of the protocol", () => {
  /** A transport fed `lines` one at a time, after each line the client sends, and recording what it sends. */
  const scripted = (answers: ReadonlyArray<string | undefined>) => {
    const sent: Array<string> = []
    let next = 0
    let push: ((line: string) => void) | undefined
    const incoming = Stream.callback<string>((queue) =>
      Effect.sync(() => {
        push = (line) => void Queue.offerUnsafe(queue, line)
      })
    )
    const transport: Acp.Transport = {
      incoming,
      send: (line) =>
        Effect.sync(() => {
          sent.push(line)
          const id = (JSON.parse(line) as { id?: number }).id
          const answer = answers[next++]
          if (answer !== undefined) push?.(answer.replace("$ID", String(id)))
        })
    }
    return { transport, sent, push: (line: string) => push?.(line) }
  }

  test("a response with no result answers null, and a response under a string id is dropped", async () => {
    const script = scripted([`{"jsonrpc":"2.0","id":"$ID"}`, `{"jsonrpc":"2.0","id":$ID}`])
    const result = await run(Effect.gen(function*() {
      const client = yield* Acp.make(script.transport, { onUpdate: () => Effect.void })
      const first = yield* Effect.forkChild(client.loadSession("s", "/"))
      yield* Effect.sleep(20)
      // The string-id answer settled nothing; this load gets the bare answer.
      yield* client.loadSession("s", "/")
      yield* Fiber.interrupt(first)
      return script.sent.length
    }))
    expect(result).toBe(2)
  })

  test("blank lines and answers to ids it never sent are skipped; a malformed permission request is answered cancelled; an update handler's failure is dropped", async () => {
    const script = scripted([])
    const answered = await run(Effect.gen(function*() {
      yield* Acp.make(script.transport, { onUpdate: () => Effect.die(new Error("handler")) })
      yield* Effect.sleep(10)
      script.push("")
      script.push(`{"jsonrpc":"2.0","id":"not-ours","result":{}}`)
      script.push(`{"jsonrpc":"2.0","id":7,"method":"session/request_permission","params":{"options":"no"}}`)
      script.push(
        `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"plan"}}}`
      )
      while (script.sent.length === 0) yield* Effect.sleep(5)
      return JSON.parse(script.sent[0]!) as unknown
    }))
    expect(answered).toEqual({ jsonrpc: "2.0", id: 7, result: { outcome: { outcome: "cancelled" } } })
  })

  test("a transport that can't send fails the request closed; a failed input stream closes the client", async () => {
    const unwritable = await runExit(Effect.gen(function*() {
      const client = yield* Acp.make({ incoming: Stream.never, send: () => Effect.fail("broken") }, {
        onUpdate: () => Effect.void
      })
      return yield* client.newSession("/")
    }))
    expect(failureOf(unwritable)).toMatchObject({ code: "closed", method: "session/new" })
    const failed = await runExit(Effect.gen(function*() {
      const client = yield* Acp.make({ incoming: Stream.fail("eof"), send: () => Effect.void }, {
        onUpdate: () => Effect.void
      })
      yield* Effect.sleep(10)
      return yield* client.initialize
    }))
    expect(failureOf(failed)).toMatchObject({ code: "closed", method: "initialize" })
  })

  test("messageText and usage read only their own kinds", () => {
    const of = (kind: string, update: Record<string, unknown>): Acp.Update => ({ sessionId: "s", kind, update })
    expect(Acp.messageText(of("plan", { content: { type: "text", text: "x" } }))).toEqual(Option.none())
    expect(Acp.messageText(of("agent_message_chunk", { content: { type: "image", data: "" } }))).toEqual(Option.none())
    expect(Acp.messageText(of("agent_message_chunk", { content: "text" }))).toEqual(Option.none())
    expect(Acp.messageText(of("agent_message_chunk", { content: { type: "text", text: "hi" } }))).toEqual(
      Option.some("hi")
    )
    expect(Acp.usage(of("plan", { used: 1 }))).toEqual(Option.none())
    expect(Acp.usage(of("usage_update", { used: "1" }))).toEqual(Option.none())
    expect(Acp.usage(of("usage_update", { used: 5, size: 9 }))).toEqual(
      Option.some({ contextTokens: 5, costUsd: undefined })
    )
    expect(Acp.usage(of("usage_update", { used: 5, cost: { amount: 2, currency: "EUR" } }))).toEqual(
      Option.some({ contextTokens: 5, costUsd: undefined })
    )
  })
})
