import * as NodeServices from "@effect/platform-node/NodeServices"
import type * as FlowEngineLike from "@smthrs/agent/FlowEngineLike"
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import { HarnessError } from "@smthrs/harness/HarnessError"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as ModelRequest from "@smthrs/model/ModelRequest"
import type * as Route from "@smthrs/model/Route"
import * as Registry from "@smthrs/registry/Registry"
import { Cause, Effect, Layer, Stream } from "effect"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import * as Driver from "../src/Driver.ts"
import * as EngineDriver from "../src/EngineDriver.ts"
import * as Events from "../src/Events.ts"
import * as Ids from "../src/Ids.ts"
import * as Protocol from "../src/Protocol.ts"
import * as Store from "../src/Store.ts"
import * as Turns from "../src/Turns.ts"
import { until } from "./Harness.ts"

const prepared: Route.PreparedRequest = {
  routeId: "route-a",
  protocolId: "test-protocol",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}

const route: FlowEngineLike.RouteResolver = { prepare: () => Effect.succeed(prepared) }

/** The scripted model: one reply per call, each the JavaScript of one cell. */
const script = {
  replies: [] as Array<string>,
  requests: [] as Array<ModelRequest.ModelRequest>,
  calls: 0,
  /** How long a model call takes; a steer needs a frame that is not over before it lands. */
  delayMs: 0
}

const model = Model.make({
  stream: (request) =>
    Stream.suspend(() => {
      script.calls += 1
      script.requests.push(request)
      const reply = script.replies.shift() ?? `ctx.done("scripted")`
      const events = Stream.fromIterable([
        ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell" }),
        ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "cell", text: "```cell\n" + reply + "\n```" }),
        ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
        ModelEvent.ModelEvent.Usage({ inputTokens: 3, outputTokens: 5 }),
        ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
      ])
      return Stream.concat(Stream.drain(Stream.fromEffect(Effect.sleep(`${script.delayMs} millis`))), events)
    })
})

/** A seat whose provider refuses every call: an account with no credit. */
const refused = "You exceeded your current quota, please check your plan and billing details."
const dead = Model.make({
  stream: () =>
    Stream.fail(
      new ModelError({ code: "quota_exceeded", httpStatus: 429, providerCode: "insufficient_quota", message: refused })
    )
})

const seats = SeatResolver.layer({
  resolve: (id) =>
    id === "broken:seat"
      ? Effect.fail(new Seat.SeatUnresolved({ seat: id, message: `Seat ${id} names no provider` }))
      : id === "openai:dead"
      ? Effect.succeed(
        Seat.make({
          id,
          modelId: "dead-model",
          model: dead,
          route,
          contextWindowTokens: SeatResolver.contextWindowTokensFor("dead-model")
        })
      )
      : Effect.succeed(
        Seat.make({
          id,
          modelId: "test-model",
          model,
          route,
          contextWindowTokens: SeatResolver.contextWindowTokensFor("test-model")
        })
      )
})

const host: EngineDriver.Host = {
  platform: NodeServices.layer,
  seats,
  registry: Layer.succeed(Registry.Registry, Registry.makeNoop())
}

const bashCell = (command: string): string =>
  `const r = await ctx.call("bash", { mode: "unhermetic", command: ${JSON.stringify(command)} })
console.log(JSON.stringify(r))
ctx.done(r.ok === false ? "refused " + r.error.code : "ran " + r.stdout.trim())`

const doneCell = `ctx.done("done")`

const recorder = () => {
  const events: Array<AgentEvent.AgentEvent> = []
  const outcomes: Array<Driver.Outcome> = []
  const sink: Driver.Sink = {
    event: (event) => Effect.sync(() => void events.push(event)),
    closed: (outcome) => Effect.sync(() => void outcomes.push(outcome))
  }
  return { events, outcomes, sink }
}

const started = (events: ReadonlyArray<AgentEvent.AgentEvent>, flow: string) =>
  events.filter((event) => event._tag === "cell-call-started" && event.call.flowName === flow)

const settledCalls = (events: ReadonlyArray<AgentEvent.AgentEvent>, flow: string) =>
  events.filter((event): event is AgentEvent.CellCallSettled =>
    event._tag === "cell-call-settled" && event.flowName === flow
  )

const printed = (events: ReadonlyArray<AgentEvent.AgentEvent>): string =>
  events.flatMap((event) => event._tag === "cell-printed" ? [event.text] : []).join("\n")

const answer = (events: ReadonlyArray<AgentEvent.AgentEvent>): string =>
  events.flatMap((event) => event._tag === "resolved" ? [event.message.content] : [])
    .flat()
    .flatMap((part) => part.type === "text" ? [part.text] : [])
    .join("")

const permissionOf = (events: ReadonlyArray<AgentEvent.AgentEvent>): string =>
  (events.find((event) => event._tag === "permission-required") as AgentEvent.PermissionRequired).request.requestId

const directories: Array<string> = []
const scratch = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "smithers-opencode-engine-"))
  directories.push(directory)
  return directory
}

afterEach(() => {
  script.replies = []
  script.requests = []
  script.calls = 0
  script.delayMs = 0
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/**
 * A Jev that reads every completion claim as done and modest, and answers
 * nothing else.
 *
 * The harness's completion brake never falls back: a claim nothing could
 * judge fails the turn as `completion_unjudged`, so a case about anything
 * else needs a transport that lets the completion stand. Every other
 * question still fails as `unreachable`, which is what a host with no
 * gateway key gives the cell's own classify doors.
 */
const judging = Evaluator.layerScripted((request) =>
  "complete" in request.questions && "overclaims" in request.questions
    ? { complete: { probability: 0.99 }, overclaims: { probability: 0.01 } }
    : Effect.fail(
      new Evaluator.EvaluatorError({ code: "unreachable", message: "No evaluator is installed on this host" })
    )
)

const options = (directory: string, extra: Partial<EngineDriver.Options> = {}): EngineDriver.Options => ({
  directory,
  seat: "scripted:test",
  host,
  maxFrames: 4,
  evaluator: judging,
  ...extra
})

/** One process's lifetime over the directory: the scope closes when the body returns. */
const process_ = <A, E>(
  directory: string,
  body: (driver: Driver.Service, store: Store.Service) => Effect.Effect<A, E>,
  extra: Partial<EngineDriver.Options> = {}
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const driver = yield* Driver.Driver
      const store = yield* Store.Store
      return yield* body(driver, store)
    }).pipe(Effect.provide(EngineDriver.layer(options(directory, extra))), Effect.scoped)
  )

const input = (sessionID: string, messageID: string, prompt = "go"): Driver.StartInput => ({
  sessionID,
  messageID,
  prompt
})

const wait = (check: () => boolean) => Effect.promise(() => until(async () => check(), 30_000))

/** The engine's own row for an execution, read off the file the next process will find. */
const engineRow = (
  directory: string,
  id: string
): { readonly status: string; readonly waiting: string | null; readonly token: string | null } => {
  const database = new DatabaseSync(join(directory, ".smithers", "opencode.sqlite"), { readOnly: true })
  try {
    const row = database.prepare("SELECT status, waiting_reason, waiting_token FROM flows_runs WHERE run_id = ?").get(
      id
    ) as { status: string; waiting_reason: string | null; waiting_token: string | null } | undefined
    return { status: row?.status ?? "missing", waiting: row?.waiting_reason ?? null, token: row?.waiting_token ?? null }
  } finally {
    database.close()
  }
}

/** How many descriptors this process holds open on the engine database file. */
const connections = (directory: string): number => {
  const file = join(directory, ".smithers", "opencode.sqlite")
  return execFileSync("lsof", ["-p", String(process.pid)], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.endsWith(file))
    .length
}

/** Whether a process whose command line carries the marker is alive. */
const alive = (marker: string): boolean => {
  try {
    return execFileSync("pgrep", ["-f", marker], { encoding: "utf8" }).trim() !== ""
  } catch {
    return false
  }
}

describe("EngineDriver", { timeout: 90_000 }, () => {
  it("parks on bash, runs the call once after Allow once, and refuses a second turn while busy", async () => {
    const directory = scratch()
    const log = recorder()
    script.replies = [bashCell("echo hi")]
    const result = await process_(directory, (driver, store) =>
      Effect.gen(function*() {
        yield* driver.start(input("ses_a", "msg_a"), log.sink)
        const parked = [...log.outcomes]
        const busy = yield* Effect.flip(driver.start(input("ses_a", "msg_b"), log.sink))
        const open = yield* store.listTurns()
        const wrong = yield* Effect.flip(
          driver.permission({ sessionID: "ses_a", permissionID: "per_nope", response: "once" })
        )
        const unknown = yield* Effect.flip(
          driver.permission({ sessionID: "ses_other", permissionID: "per_nope", response: "once" })
        )
        yield* driver.permission({ sessionID: "ses_a", permissionID: permissionOf(log.events), response: "once" })
        return {
          parked,
          busy,
          open,
          wrong,
          unknown,
          grants: yield* store.listGrants("ses_a"),
          left: yield* store.listTurns()
        }
      }), { limits: { memoryBytes: 64 * 1024 * 1024, steps: 5_000_000 } })
    expect(result.parked).toEqual([{ _tag: "suspended" }])
    expect(result.busy.code).toBe("busy")
    expect(result.open.map((turn) => turn.messageID)).toEqual(["msg_a"])
    expect(result.wrong.code).toBe("unknown_permission")
    expect(result.unknown.code).toBe("unknown_session")
    expect(log.outcomes).toEqual([{ _tag: "suspended" }, { _tag: "completed" }])
    // The call is announced before the hook refuses it and again when the
    // replay reaches it; it runs, and settles, once.
    expect(started(log.events, "bash").length).toBeGreaterThanOrEqual(2)
    expect(settledCalls(log.events, "bash").map((event) => event.result.outcome)).toEqual(["success"])
    expect(answer(log.events)).toBe("ran hi")
    expect(script.calls).toBe(1)
    expect(result.grants).toEqual([{ sessionID: "ses_a", kind: "once", key: permissionOf(log.events) }])
    expect(result.left).toEqual([])
    const request = permissionOf(log.events)
    expect(request.startsWith("per_a_0_")).toBe(true)
    // The pieces the engine never calls in a turn still have to answer.
    expect(EngineDriver.turnFlow.body({ session: "s", input: "{}" })).toBeDefined()
    expect(await Effect.runPromise(EngineDriver.inertJj.snapshot())).toEqual({ changeId: "opencode" })
    expect(await Effect.runPromise(EngineDriver.inertJj.restore())).toBeUndefined()
    expect(await Effect.runPromise(EngineDriver.inertJj.diff())).toBe("")
  })

  it("opens the engine database once, for the engine, the queue, and the store together", async () => {
    const directory = scratch()
    const opened = await process_(directory, (_driver, store) =>
      Effect.gen(function*() {
        // A store read and a queue-backed steer both go through the one connection.
        yield* store.listTurns()
        return connections(directory)
      }))
    expect(opened).toBe(1)
  })

  it("remembers Allow always for the card's pattern, across turns and across a restart", async () => {
    const directory = scratch()
    const first = recorder()
    const second = recorder()
    const other = recorder()
    script.replies = [bashCell("echo one"), bashCell("echo two"), bashCell("rm -rf /tmp/nonexistent-smithers-xyz")]
    await process_(directory, (driver) =>
      Effect.gen(function*() {
        yield* driver.start(input("ses_b", "msg_1"), first.sink)
        yield* driver.permission({ sessionID: "ses_b", permissionID: permissionOf(first.events), response: "always" })
        yield* driver.start(input("ses_b", "msg_2"), second.sink)
        // The answer covered `echo *`, what the card showed: another command asks again.
        yield* driver.start(input("ses_b", "msg_rm"), other.sink)
        yield* driver.permission({ sessionID: "ses_b", permissionID: permissionOf(other.events), response: "reject" })
      }))
    expect(first.outcomes).toEqual([{ _tag: "suspended" }, { _tag: "completed" }])
    expect(second.outcomes).toEqual([{ _tag: "completed" }])
    expect(second.events.some((event) => event._tag === "permission-required")).toBe(false)
    expect(answer(second.events)).toBe("ran two")
    expect(other.outcomes).toEqual([{ _tag: "suspended" }, { _tag: "completed" }])
    expect(answer(other.events)).toBe("refused capability_refused")

    const third = recorder()
    script.replies = [bashCell("echo three")]
    const grants = await process_(directory, (driver, store) =>
      Effect.gen(function*() {
        yield* driver.start(input("ses_b", "msg_3"), third.sink)
        return yield* store.listGrants()
      }))
    expect(third.outcomes).toEqual([{ _tag: "completed" }])
    expect(answer(third.events)).toBe("ran three")
    expect(grants).toEqual([
      { sessionID: "ses_b", kind: "always", key: "bash echo *" },
      { sessionID: "ses_b", kind: "reject", key: permissionOf(other.events) }
    ])
    expect(EngineDriver.alwaysKey(directory, "bash", { command: "  cat package.json" })).toBe("bash cat *")
    expect(EngineDriver.alwaysKey(directory, "bash", { command: "" })).toBe("bash *")
    expect(EngineDriver.alwaysKey(directory, "read", { path: `${directory}/a.txt` })).toBe("read *")
  })

  it("reports a seat the provider refused with the seat, the code, the status, and the provider's words", async () => {
    const directory = scratch()
    const log = recorder()
    await process_(directory, (driver) => driver.start(input("ses_dead", "msg_dead"), log.sink), {
      seat: "openai:dead"
    })
    expect(log.outcomes).toEqual([{
      _tag: "failed",
      message: `quota_exceeded (HTTP 429) from openai:dead: ${refused}`,
      provider: { seat: "openai:dead", providerID: "openai", code: "quota_exceeded", status: 429, message: refused }
    }])
    expect(script.calls).toBe(0)
    // The engine's JSON projection of the same failure reads the same way.
    const projected = EngineDriver.failedOutcome(
      "anthropic:claude",
      Cause.fail({
        _tag: "HarnessError",
        code: "model_failed",
        message: "The cell frame failed",
        cause: { _tag: "flows/model/ModelError", code: "authentication", httpStatus: 401, message: "invalid x-api-key" }
      })
    )
    expect(projected).toMatchObject({
      message: "authentication (HTTP 401) from anthropic:claude: invalid x-api-key",
      provider: { providerID: "anthropic", code: "authentication", status: 401 }
    })
    const noStatus = EngineDriver.failedOutcome(
      "local",
      Cause.fail(
        new HarnessError({
          code: "model_failed",
          message: "x",
          cause: new ModelError({ code: "transport", message: "socket hang up" })
        })
      )
    )
    expect(noStatus).toMatchObject({
      message: "transport from local: socket hang up",
      provider: { providerID: "local" }
    })
    expect(EngineDriver.failedOutcome("s", Cause.fail(new Error("boom")))).toEqual({ _tag: "failed", message: "boom" })
    expect(EngineDriver.failedOutcome("s", Cause.fail({ code: "odd" }))).toEqual({
      _tag: "failed",
      message: "{\"code\":\"odd\"}"
    })
    expect(
      EngineDriver.seatFailureLine({
        seat: "openai:dead",
        providerID: "openai",
        code: "quota_exceeded",
        status: 429,
        message: refused
      })
    ).toBe(
      `Seat openai:dead refused the model call (quota_exceeded, HTTP 429): ${refused} Pass --seat provider:model or set SMITHERS_SEAT to run on another seat.`
    )
    expect(EngineDriver.seatFailureLine({ seat: "local", providerID: "local", code: "transport", message: "down" }))
      .toBe(
        "Seat local refused the model call (transport): down Pass --seat provider:model or set SMITHERS_SEAT to run on another seat."
      )
  })

  it("settles a rejected call as a failure the cell reads, and the turn goes on", async () => {
    const directory = scratch()
    const log = recorder()
    script.replies = [bashCell("echo nope")]
    await process_(directory, (driver) =>
      Effect.gen(function*() {
        yield* driver.start(input("ses_c", "msg_c"), log.sink)
        yield* driver.permission({ sessionID: "ses_c", permissionID: permissionOf(log.events), response: "reject" })
      }))
    expect(log.outcomes).toEqual([{ _tag: "suspended" }, { _tag: "completed" }])
    expect(printed(log.events)).toContain("\"code\":\"capability_refused\"")
    expect(printed(log.events)).toContain("permission_denied")
    // The harness appends its generic `capability_refused` hint ("This run
    // cannot reach that flow") beside the message; the message says the
    // hint is about the flow, not this call, and that the flow stays open.
    expect(printed(log.events)).toContain(EngineDriver.deniedMessage("bash").replace(/"/g, "\\\""))
    expect(EngineDriver.deniedMessage("bash")).toBe(
      "permission_denied: the person rejected this bash call. Do not retry it; do the work another way or explain what you would have run. The generic hint beside this message is about the flow, not this call: the flow stays available for commands the person allows."
    )
    expect(answer(log.events)).toBe("refused capability_refused")
    const settled = log.events.find((event) => event._tag === "cell-call-settled") as AgentEvent.CellCallSettled
    expect(settled.result.outcome).toBe("failure")
  })

  it("arms the read-only cap for this host and teaches the model to answer in the cell that has the answer", async () => {
    const directory = scratch()
    const log = recorder()
    // A model that prints instead of calling ctx.done: every frame reads
    // as read-only, the cap demands at the host's value, and the run is
    // stopped at twice that instead of spending the frame budget.
    script.replies = Array.from({ length: 40 }, (_, frame) => `console.log("B ${"#".repeat(frame + 1)}")`)
    await process_(directory, (driver) =>
      Effect.gen(function*() {
        yield* driver.start(input("ses_ro", "msg_ro", "Say B"), log.sink)
        yield* wait(() => log.outcomes.length === 1)
      }), { maxFrames: 40 })
    const armed = log.events.find((event): event is AgentEvent.DisciplineArmed => event._tag === "discipline-armed")!
    expect(armed.readOnlyCap).toBe(EngineDriver.readOnlyCap)
    expect(EngineDriver.readOnlyCap).toBe(6)
    const demand = log.events.find((event): event is AgentEvent.ReadOnlyDemandIssued =>
      event._tag === "read-only-demand-issued"
    )!
    expect(demand.cap).toBe(EngineDriver.readOnlyCap)
    expect(log.outcomes).toEqual([{ _tag: "failed", message: expect.stringContaining("read-only budget of 6") }])
    expect(script.calls).toBe(EngineDriver.readOnlyCap * 2)
    // The host's teaching is in the system context of the first request,
    // ahead of the task, and says when to call ctx.done.
    const first = JSON.stringify(script.requests[0])
    expect(first).toContain(JSON.stringify(EngineDriver.hostTeaching).slice(1, -1))
    expect(first.indexOf(EngineDriver.hostTeaching.slice(0, 40))).toBeLessThan(first.indexOf("The task for this run"))
    expect(EngineDriver.hostTeaching).toContain("ctx.done")
    expect(EngineDriver.hostTeaching).toContain("Never run a command the person did not ask for")
    const systemTexts = (script.requests[0] as unknown as { system?: ReadonlyArray<{ text: string }> }).system
      ?.map((part) => part.text.slice(0, 48)) ?? []
    expect(systemTexts.some((text) => EngineDriver.hostTeaching.startsWith(text))).toBe(true)
  })

  it("interrupts a running turn and leaves no shell process behind", async () => {
    const directory = scratch()
    const log = recorder()
    const marker = `sleep 30.${Date.now() % 100_000}`
    script.replies = [bashCell(marker)]
    const result = await process_(directory, (driver) =>
      Effect.gen(function*() {
        yield* Effect.forkDetach(driver.start(input("ses_d", "msg_d"), log.sink))
        yield* wait(() => started(log.events, "bash").length === 1)
        yield* Effect.promise(() => until(async () => alive(marker)))
        const none = yield* driver.steer("ses_nobody", "x")
        const started_ = Date.now()
        const interrupted = yield* driver.interrupt("ses_d")
        yield* wait(() => log.outcomes.length === 1)
        const closedMs = Date.now() - started_
        yield* Effect.promise(() => until(async () => !alive(marker)))
        const again = yield* driver.interrupt("ses_d")
        return { none, interrupted, again, closedMs }
      }), { asks: [] })
    expect(result).toMatchObject({ none: false, interrupted: true, again: false })
    expect(log.outcomes).toEqual([{ _tag: "interrupted" }])
    // The sink hears the interrupt as soon as the body is gone, not after a
    // ten second wait for a result a cancelled run never publishes.
    expect(result.closedMs).toBeLessThan(3000)
  })

  it("interrupts a parked turn", async () => {
    const directory = scratch()
    const log = recorder()
    script.replies = [bashCell("echo parked")]
    const result = await process_(directory, (driver, store) =>
      Effect.gen(function*() {
        yield* driver.start(input("ses_e", "msg_e"), log.sink)
        const started_ = Date.now()
        const interrupted = yield* driver.interrupt("ses_e")
        return { interrupted, interruptMs: Date.now() - started_, left: yield* store.listTurns() }
      }))
    expect(result).toMatchObject({ interrupted: true, left: [] })
    expect(result.interruptMs).toBeLessThan(3000)
    expect(log.outcomes).toEqual([{ _tag: "suspended" }, { _tag: "interrupted" }])
  })

  it("aborts a parked turn through the composition: card rejected, cell settled, no waiting row", async () => {
    const directory = scratch()
    const session: Protocol.Session = {
      id: "ses_park",
      slug: "quiet-harbor",
      projectID: "p",
      directory,
      path: "",
      title: "New session - now",
      version: "test",
      agent: "smithers",
      model: { id: "test", providerID: "scripted" },
      cost: 0,
      tokens: Protocol.noTokens,
      time: { created: 1, updated: 1 }
    }
    // One hub layer, shared by the composition and the test, so the test
    // reads the stream the turn published on.
    const hub = Events.layer({ directory, project: "p" })
    const stack = Layer.mergeAll(
      Turns.layer({ directory, agent: "smithers", model: { providerID: "scripted", modelID: "test" } }),
      hub
    ).pipe(
      Layer.provideMerge(Layer.mergeAll(hub, EngineDriver.layer(options(directory, {})), Evaluator.layerUnavailable()))
    )
    const tools = (list: ReadonlyArray<Store.MessageWithParts>) =>
      list.flatMap((message) => message.parts.filter((part): part is Protocol.ToolPart => part.type === "tool"))

    script.replies = [bashCell("echo parked")]
    const parked = await Effect.runPromise(
      Effect.gen(function*() {
        const turns = yield* Turns.Turns
        const store = yield* Store.Store
        const hub = yield* Events.Events
        yield* store.putSession(session)
        yield* turns.prompt({ sessionID: "ses_park", parts: [{ type: "text", text: "echo parked" }] })
        yield* Effect.promise(() =>
          until(
            () => Effect.runPromise(Effect.map(store.listPermissions("ses_park"), (list) => list.length === 1)),
            30_000
          )
        )
        const request = (yield* store.listPermissions("ses_park"))[0]!
        const before = (yield* hub.replay()).length
        const aborted = yield* turns.abort("ses_park")
        yield* Effect.promise(() =>
          until(
            () =>
              Effect.runPromise(
                Effect.map(
                  store.listMessages("ses_park"),
                  (list) =>
                    list.some((message) => message.info.role === "assistant" && message.info.finish !== undefined)
                )
              ),
            30_000
          )
        )
        const list = yield* store.listMessages("ses_park")
        return {
          aborted,
          request,
          list,
          after: (yield* hub.replay()).slice(before).map((envelope) => envelope.payload),
          pending: yield* store.listPermissions("ses_park"),
          left: yield* store.listTurns(),
          status: yield* turns.status(),
          // The engine records the cancel on its own loop, so the row is
          // polled rather than read once.
          row: yield* Effect.gen(function*() {
            const id = Ids.reply(list.find((message) => message.info.role === "user")!.info.id)
            yield* Effect.promise(() => until(async () => engineRow(directory, id).waiting === null, 30_000))
            return engineRow(directory, id)
          })
        }
      }).pipe(Effect.provide(stack), Effect.scoped)
    )
    expect(parked.aborted).toBe(true)
    // The card comes down on the stream before the turn ends there.
    const replied = parked.after.findIndex((event) => event.type === "permission.replied")
    expect(replied).toBeGreaterThanOrEqual(0)
    expect(parked.after[replied]!.properties).toEqual({
      sessionID: "ses_park",
      requestID: parked.request.id,
      reply: "reject"
    })
    expect(parked.after.findIndex((event) => event.type === "session.idle")).toBeGreaterThan(replied)
    expect(parked.pending).toEqual([])
    expect(parked.left).toEqual([])
    expect(parked.status).toEqual({})
    expect((parked.list[1]!.info as Protocol.AssistantMessage).error?.name).toBe("MessageAbortedError")
    expect(tools(parked.list).every((part) => part.state.status !== "running")).toBe(true)
    expect(tools(parked.list).filter((part) => part.state.status === "error").map((part) => part.tool)).toEqual([
      "cell",
      "bash"
    ])
    // The engine holds no row that would re-drive the turn after the abort.
    expect(parked.row).toEqual({ status: "cancelled", waiting: null, token: null })
  })

  it("settles a turn the engine cannot resume instead of leaving the session busy", async () => {
    const directory = scratch()
    const rewrite = (statement: string) =>
      Effect.sync(() => {
        const database = new DatabaseSync(join(directory, ".smithers", "opencode.sqlite"), { timeout: 5000 })
        try {
          database.exec(`PRAGMA foreign_keys = OFF; ${statement}`)
        } finally {
          database.close()
        }
      })
    const gone = recorder()
    const closed = recorder()
    script.replies = [bashCell("echo gone"), bashCell("echo closed")]
    await process_(directory, (driver) =>
      Effect.gen(function*() {
        yield* driver.start(input("ses_g", "msg_g"), gone.sink)
        yield* driver.start(input("ses_h", "msg_h"), closed.sink)
      }))
    expect(gone.outcomes).toEqual([{ _tag: "suspended" }])
    expect(closed.outcomes).toEqual([{ _tag: "suspended" }])
    // The next process holds nothing in memory for either park: what the
    // rows say is all the engine has.
    const goneAgain = recorder()
    const closedAgain = recorder()
    const result = await process_(directory, (driver) =>
      Effect.gen(function*() {
        yield* driver.resumeOnBoot((turn) =>
          Effect.succeed(turn.sessionID === "ses_g" ? goneAgain.sink : closedAgain.sink)
        )
        // One row vanished: the resume drives nothing, and nothing else would settle the turn.
        yield* rewrite("DELETE FROM flows_runs WHERE run_id = 'msg_g'")
        // The other was cancelled by another process before the person answered.
        yield* rewrite("UPDATE flows_runs SET status = 'cancelled' WHERE run_id = 'msg_h'")
        yield* driver.permission({ sessionID: "ses_g", permissionID: permissionOf(gone.events), response: "once" })
        yield* driver.permission({ sessionID: "ses_h", permissionID: permissionOf(closed.events), response: "once" })
        return { gone: yield* driver.interrupt("ses_g"), closed: yield* driver.interrupt("ses_h") }
      }))
    expect(result).toEqual({ gone: false, closed: false })
    expect(goneAgain.outcomes.map((outcome) => outcome._tag)).toEqual(["failed"])
    expect(closedAgain.outcomes.map((outcome) => outcome._tag)).toEqual(["interrupted"])
    expect(script.calls).toBe(2)
  })

  it("drains a steer at a frame boundary and carries the tail into a follow-up", async () => {
    const directory = scratch()
    const log = recorder()
    script.replies = [`console.log("thinking")`, `console.log("still")`, doneCell]
    script.delayMs = 300
    const steered = await process_(directory, (driver) =>
      Effect.gen(function*() {
        yield* Effect.forkDetach(driver.start(input("ses_f", "msg_f"), log.sink))
        yield* wait(() => log.events.some((event) => event._tag === "cell-produced"))
        const steered = yield* driver.steer("ses_f", "Also say STEERED.")
        yield* wait(() => log.outcomes.length === 1)
        return steered
      }))
    expect(steered).toBe(true)
    expect(log.outcomes).toEqual([{ _tag: "completed" }])
    const drained = log.events.filter((event) => event._tag === "steering-drained") as Array<AgentEvent.SteeringDrained>
    expect(drained.map((event) => event.messages.length)).toContain(1)
    expect(JSON.stringify(script.requests.at(-1))).toContain("Also say STEERED.")

    const follow = recorder()
    script.replies = [doneCell]
    await process_(
      directory,
      (driver) =>
        driver.start({ ...input("ses_f", "msg_g", "and now?"), history: "Person: hi\n\nAssistant: hello" }, follow.sink)
    )
    expect(follow.outcomes).toEqual([{ _tag: "completed" }])
    const request = JSON.stringify(script.requests.at(-1))
    expect(request).toContain("The conversation so far")
    expect(request).toContain("Person: hi")
    expect(request).toContain("and now?")
    expect(EngineDriver.task({ ...input("s", "m", "p"), history: "" })).toBe("p")
  })

  it("re-drives a turn that was running when the process stopped, without a second model call", async () => {
    const directory = scratch()
    const first = recorder()
    const marker = `sleep 1.${Date.now() % 100_000}`
    script.replies = [bashCell(marker)]
    await process_(directory, (driver) =>
      Effect.gen(function*() {
        yield* Effect.forkDetach(driver.start(input("ses_g", "msg_h"), first.sink))
        yield* wait(() => started(first.events, "bash").length === 1)
      }), { asks: [] })
    await until(async () => first.outcomes.length === 1)
    expect(first.outcomes).toEqual([{ _tag: "suspended" }])
    expect(script.calls).toBe(1)
    expect(engineRow(directory, "msg_h")).toEqual({ status: "suspended", waiting: "released", token: null })

    const second = recorder()
    const opened: Array<Driver.StartInput> = []
    const left = await process_(directory, (driver, store) =>
      Effect.gen(function*() {
        yield* driver.resumeOnBoot((turn) => Effect.sync(() => (opened.push(turn), second.sink)))
        yield* wait(() => second.outcomes.length === 1)
        return yield* store.listTurns()
      }), { asks: [] })
    expect(opened.map((turn) => turn.messageID)).toEqual(["msg_h"])
    expect(second.outcomes).toEqual([{ _tag: "completed" }])
    expect(settledCalls(second.events, "bash").length).toBe(1)
    expect(script.calls).toBe(1)
    expect(left).toEqual([])
  })

  it("re-drives the turns that were parked when the process stopped, once the person answers", async () => {
    const directory = scratch()
    const first = recorder()
    const other = recorder()
    script.replies = [bashCell("echo later"), bashCell("echo also")]
    await process_(directory, (driver) =>
      Effect.gen(function*() {
        yield* driver.start(input("ses_h", "msg_i"), first.sink)
        yield* driver.start(input("ses_o", "msg_o"), other.sink)
      }))
    expect(first.outcomes).toEqual([{ _tag: "suspended" }])
    expect(other.outcomes).toEqual([{ _tag: "suspended" }])
    const request = permissionOf(first.events)
    const otherRequest = permissionOf(other.events)

    const second = recorder()
    const secondOther = recorder()
    const grants = await process_(directory, (driver, store) =>
      Effect.gen(function*() {
        // The turns composition stores the card the app shows; a card that
        // was never stored still resumes, under the flow the driver asks for.
        yield* store.putPermission({
          id: request,
          sessionID: "ses_h",
          permission: "bash",
          patterns: ["echo later"],
          metadata: {},
          always: ["echo *"],
          tool: { messageID: "msg_i", callID: "c" }
        })
        yield* driver.resumeOnBoot((turn) =>
          Effect.succeed(turn.sessionID === "ses_h" ? second.sink : secondOther.sink)
        )
        const steered = yield* driver.steer("ses_h", "hurry")
        expect(steered).toBe(true)
        yield* driver.permission({ sessionID: "ses_h", permissionID: request, response: "once" })
        yield* driver.permission({ sessionID: "ses_o", permissionID: otherRequest, response: "always" })
        return yield* store.listGrants("ses_o")
      }))
    expect(second.outcomes).toEqual([{ _tag: "completed" }])
    expect(settledCalls(second.events, "bash").length).toBe(1)
    expect(printed(second.events)).toContain("later")
    // The steer admitted while the run was parked was delivered on resume,
    // which bounces the frame's completion into one more frame: two model
    // calls before the restart, one after.
    expect(script.calls).toBe(3)
    expect(JSON.stringify(script.requests.at(-1))).toContain("hurry")
    expect(answer(second.events)).toBe("scripted")
    expect(secondOther.outcomes).toEqual([{ _tag: "completed" }])
    expect(answer(secondOther.events)).toBe("ran also")
    expect(grants).toEqual([{ sessionID: "ses_o", kind: "always", key: "bash *" }])
  })

  it("lets the engine re-drive a released turn on its own, then settles it at the next boot", async () => {
    const directory = scratch()
    const first = recorder()
    const marker = `sleep 1.${Date.now() % 100_000}`
    script.replies = [bashCell(marker)]
    await process_(directory, (driver) =>
      Effect.gen(function*() {
        yield* Effect.forkDetach(driver.start(input("ses_i", "msg_j"), first.sink))
        yield* wait(() => started(first.events, "bash").length === 1)
      }), { asks: [] })
    await until(async () => first.outcomes.length === 1)
    expect(engineRow(directory, "msg_j")).toEqual({ status: "suspended", waiting: "released", token: null })

    // No host opens a sink: the engine's own sweep wakes the released run
    // within a heartbeat, the body waits `attachTimeout` for one, and runs
    // without.
    const open = await process_(directory, (_driver, store) =>
      Effect.gen(function*() {
        yield* Effect.promise(() => until(async () => engineRow(directory, "msg_j").status === "completed", 20_000))
        return yield* store.listTurns()
      }), { asks: [], attachTimeout: "200 millis" })
    expect(open.map((turn) => turn.messageID)).toEqual(["msg_j"])
    expect(script.calls).toBe(1)

    const third = recorder()
    const left = await process_(directory, (driver, store) =>
      Effect.gen(function*() {
        yield* driver.resumeOnBoot(() => Effect.succeed(third.sink))
        return yield* store.listTurns()
      }), { asks: [] })
    expect(third.outcomes).toEqual([{ _tag: "completed" }])
    expect(left).toEqual([])

    // The same again, but this time the host opens the sink while the body
    // the sweep re-drove is still waiting for one: it attaches to it.
    const fourth = recorder()
    script.replies = [bashCell(`sleep 1.${Date.now() % 100_000}`)]
    await process_(directory, (driver) =>
      Effect.gen(function*() {
        yield* Effect.forkDetach(driver.start(input("ses_i", "msg_k"), fourth.sink))
        yield* wait(() => started(fourth.events, "bash").length === 1)
      }), { asks: [] })
    await until(async () => fourth.outcomes.length === 1)
    const fifth = recorder()
    await process_(directory, (driver, store) =>
      Effect.gen(function*() {
        yield* Effect.sleep("1500 millis")
        yield* driver.resumeOnBoot(() => Effect.succeed(fifth.sink))
        yield* wait(() => fifth.outcomes.length === 1)
        expect(yield* store.listTurns()).toEqual([])
      }), { asks: [], attachTimeout: "20 seconds" })
    expect(fifth.outcomes).toEqual([{ _tag: "completed" }])
    expect(settledCalls(fifth.events, "bash").length).toBe(1)

    // And once more with the shell behind a permission: the body the sweep
    // re-drove parks with nobody to ask, and the next boot finds the park.
    const sixth = recorder()
    script.replies = [bashCell("echo asked")]
    await process_(directory, (driver) =>
      Effect.gen(function*() {
        yield* Effect.forkDetach(driver.start(input("ses_i", "msg_l"), sixth.sink))
        yield* wait(() => started(sixth.events, "bash").length === 1)
      }), { asks: [] })
    await until(async () => sixth.outcomes.length === 1)
    await process_(
      directory,
      () => Effect.promise(() => until(async () => engineRow(directory, "msg_l").waiting === "approval", 20_000)),
      {
        attachTimeout: "200 millis"
      }
    )
    const seventh = recorder()
    await process_(directory, (driver, store) =>
      Effect.gen(function*() {
        yield* driver.resumeOnBoot(() => Effect.succeed(seventh.sink))
        yield* driver.permission({
          sessionID: "ses_i",
          permissionID: engineRow(directory, "msg_l").token!,
          response: "once"
        })
        expect(yield* store.listTurns()).toEqual([])
      }))
    expect(seventh.outcomes).toEqual([{ _tag: "completed" }])
    expect(answer(seventh.events)).toBe("ran asked")
  })

  it("reports a lost turn, a failed turn, and a same-id re-execution from the engine's published result", async () => {
    const directory = scratch()
    const lost = recorder()
    const failed = recorder()
    const again = recorder()
    const down = recorder()
    const result = await process_(directory, (driver, store) =>
      Effect.gen(function*() {
        yield* store.putTurn(input("ses_j", "msg_lost"))
        yield* driver.resumeOnBoot(() => Effect.succeed(lost.sink))
        const afterLost = yield* store.listTurns()
        yield* driver.start(input("ses_k", "msg_k"), failed.sink)
        // The same id again: the engine answers from its row, the body never runs.
        yield* driver.start(input("ses_k", "msg_k"), again.sink)
        yield* store.putTurn(input("ses_k", "msg_k"))
        yield* driver.resumeOnBoot(() => Effect.succeed(down.sink))
        return { afterLost, left: yield* store.listTurns() }
      }), { seat: "broken:seat" })
    expect(lost.outcomes).toEqual([{ _tag: "failed", message: "The turn was lost when the server stopped" }])
    expect(result.afterLost).toEqual([])
    expect(failed.outcomes[0]?._tag).toBe("failed")
    expect(failed.outcomes[0]?._tag === "failed" ? failed.outcomes[0].message : "").toContain("broken:seat")
    expect(again.outcomes[0]?._tag).toBe("failed")
    expect(again.outcomes[0]?._tag === "failed" ? again.outcomes[0].message : "").toContain("broken:seat")
    expect(down.outcomes).toEqual([{ _tag: "failed", message: "The turn failed while the server was down" }])
    expect(result.left).toEqual([])
    expect(script.calls).toBe(0)
  })

  it("settles a turn that completed while the server was down without re-opening it", async () => {
    const directory = scratch()
    const log = recorder()
    const later = recorder()
    script.replies = [doneCell]
    await process_(directory, (driver, store) =>
      Effect.gen(function*() {
        yield* driver.start(input("ses_l", "msg_l"), log.sink)
        yield* store.putTurn(input("ses_l", "msg_l"))
      }))
    const again = recorder()
    await process_(directory, (driver) =>
      Effect.gen(function*() {
        yield* driver.resumeOnBoot(() => Effect.succeed(later.sink))
        // The same id once more: the engine answers from its row, the body never runs.
        yield* driver.start(input("ses_l", "msg_l"), again.sink)
      }), { maxFrames: undefined })
    expect(log.outcomes).toEqual([{ _tag: "completed" }])
    expect(later.outcomes).toEqual([{ _tag: "completed" }])
    expect(again.outcomes).toEqual([{ _tag: "completed" }])
    expect(script.calls).toBe(1)
  })

  it("resumes through the turns composition without duplicating the cards the app already has", async () => {
    const directory = scratch()
    const marker = `sleep 1.${Date.now() % 100_000}`
    const session: Protocol.Session = {
      id: "ses_m",
      slug: "quiet-harbor",
      projectID: "p",
      directory,
      path: "",
      title: "New session - now",
      version: "test",
      agent: "smithers",
      model: { id: "test", providerID: "scripted" },
      cost: 0,
      tokens: Protocol.noTokens,
      time: { created: 1, updated: 1 }
    }
    const stack = (extra: Partial<EngineDriver.Options>) =>
      Layer.mergeAll(
        Turns.layer({ directory, agent: "smithers", model: { providerID: "scripted", modelID: "test" } }),
        Events.layer({ directory, project: "p" })
      ).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Events.layer({ directory, project: "p" }),
            EngineDriver.layer(options(directory, extra)),
            judging
          )
        )
      )
    const bashCards = (messages: ReadonlyArray<Store.MessageWithParts>) =>
      messages.flatMap((message) => message.parts.filter((part) => part.type === "tool" && part.tool === "bash"))

    script.replies = [bashCell(marker)]
    await Effect.runPromise(
      Effect.gen(function*() {
        const turns = yield* Turns.Turns
        const store = yield* Store.Store
        yield* store.putSession(session)
        yield* turns.prompt({ sessionID: "ses_m", parts: [{ type: "text", text: `run ${marker}` }] })
        yield* Effect.promise(() =>
          until(() =>
            Effect.runPromise(Effect.map(store.listMessages("ses_m"), (list) => bashCards(list).length === 1))
          )
        )
      }).pipe(Effect.provide(stack({ asks: [] })), Effect.scoped)
    )

    const messages = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* Store.Store
        const turns = yield* Turns.Turns
        const busy = yield* turns.status()
        yield* Effect.promise(() =>
          until(() =>
            Effect.runPromise(
              Effect.map(
                store.listMessages("ses_m"),
                (list) => list.some((message) => message.info.role === "assistant" && message.info.finish === "stop")
              )
            ), 30_000)
        )
        return { busy, list: yield* store.listMessages("ses_m") }
      }).pipe(Effect.provide(stack({ asks: [] })), Effect.scoped)
    )
    expect(messages.busy).toEqual({ ses_m: { type: "busy" } })
    expect(messages.list.map((message) => message.info.role)).toEqual(["user", "assistant"])
    expect(bashCards(messages.list).length).toBe(1)
    // The card settled: a store write the engine's own transaction refused was retried, not dropped.
    expect((bashCards(messages.list)[0] as Protocol.ToolPart).state.status).toBe("completed")
    expect(script.calls).toBe(1)
  })
  it("binds classify to the host's evaluator: refused without one, answered with a scripted one", async () => {
    const classifyCell =
      `const r = await ctx.call("classify", { state: { a: 1 }, questions: { yes: { type: "boolean", instructions: "Is a one?" } } })
const c = await ctx.call("classify/triage/relevance", { task: "t", file: "f", excerpt: "x" })
console.log(JSON.stringify(r))
ctx.done(r.ok === false ? "refused " + r.error.message : "answered " + r.answers.yes.value + " " + c.answers.role.value)`
    // No key: every classify call settles as a failure the cell reads, and
    // then the turn itself fails, because the completion brake asks the same
    // transport and never falls back.
    const refusedDirectory = scratch()
    const refused = recorder()
    script.replies = [classifyCell]
    // No evaluator named: the driver reads the environment, which has no key here.
    await process_(
      refusedDirectory,
      (driver) =>
        Effect.gen(function*() {
          yield* driver.start(input("ses_c", "msg_c"), refused.sink)
          yield* wait(() => refused.outcomes.length === 1)
        }),
      { evaluator: undefined, environment: {} }
    )
    expect(refused.outcomes).toEqual([{
      _tag: "failed",
      message: expect.stringContaining("A completion no evaluator could judge")
    }])
    const refusedCalls = settledCalls(refused.events, "classify")
    expect(refusedCalls.length).toBe(1)
    expect(refusedCalls[0]!.result.outcome).toBe("failure")
    expect(refusedCalls[0]!.result.message).toContain("unreachable")

    // Nothing named at all: the driver reads the process environment, held
    // to no key here so the unit suite never reaches the gateway and the
    // refusal is what the cell reads.
    const ambientDirectory = scratch()
    const ambient = recorder()
    script.replies = [classifyCell]
    const ambientKey = process.env["AI_GATEWAY_API_KEY"]
    delete process.env["AI_GATEWAY_API_KEY"]
    try {
      await process_(
        ambientDirectory,
        (driver) =>
          Effect.gen(function*() {
            yield* driver.start(input("ses_e", "msg_e"), ambient.sink)
            yield* wait(() => ambient.outcomes.length === 1)
          }),
        { evaluator: undefined }
      )
    } finally {
      if (ambientKey !== undefined) process.env["AI_GATEWAY_API_KEY"] = ambientKey
    }
    expect(ambient.outcomes).toEqual([{
      _tag: "failed",
      message: expect.stringContaining("A completion no evaluator could judge")
    }])
    const ambientCalls = settledCalls(ambient.events, "classify")
    expect(ambientCalls.length).toBe(1)
    expect(ambientCalls[0]!.result.outcome).toBe("failure")
    expect(ambientCalls[0]!.result.message).toContain("unreachable")

    // A scripted evaluator: the ad-hoc door and a curated door both answer.
    const answeredDirectory = scratch()
    const answered = recorder()
    script.replies = [classifyCell]
    await process_(
      answeredDirectory,
      (driver) =>
        Effect.gen(function*() {
          yield* driver.start(input("ses_d", "msg_d"), answered.sink)
          yield* wait(() => answered.outcomes.length === 1)
        }),
      {
        evaluator: Evaluator.layerScripted((request) =>
          "yes" in request.questions
            ? { yes: { probability: 0.9 } }
            : "complete" in request.questions
            ? { complete: { probability: 0.99 }, overclaims: { probability: 0.01 } }
            : {
              relevant: { probability: 0.8 },
              role: { choice: "fixture", probabilities: { implementation: 0.1, fixture: 0.8, unrelated: 0.1 } },
              risk: { score: 1 }
            }
        )
      }
    )
    expect(answered.outcomes).toEqual([{ _tag: "completed" }])
    expect(settledCalls(answered.events, "classify")[0]!.result.outcome).toBe("success")
    expect(settledCalls(answered.events, "classify/triage/relevance")[0]!.result.outcome).toBe("success")
    expect(answer(answered.events)).toBe("answered true fixture")
    expect(script.calls).toBe(3)
  })
})
