/**
 * The workerd smoke's Worker: real Durable Objects that delegate to
 * `ExecutionObject`, as an app's Effect-native object does, over Hyperdrive.
 *
 * `Execution` runs `AnswerFlow`. Its `answer` step calls `ctx.abort()` the
 * first time it runs, so the object is reset inside a step and the alarm
 * Cloudflare retries runs in a new incarnation. Each step records which
 * incarnation ran it.
 *
 * `Nested` runs `NestedFlows`, one object per execution: a parent and its
 * child, a parent whose child fails, and a counter whose rounds hand off to
 * each other. Each object routes to the others through its own namespace
 * binding, as an app's object class does. A `bump:1` step calls
 * `ctx.abort()` the first time it runs, so one round is reset inside its step.
 *
 * `Retained` runs `AnswerFlow` with a retention window of `RETAIN_MS`, and
 * keeps its steps and outcomes in instance memory rather than in its
 * storage, so its report shows the storage `ExecutionObject` leaves behind:
 * nothing, once a settled execution's window has passed.
 *
 * `Probe` answers one question about the platform the design rests on: an
 * alarm set while an alarm handler runs does not start a second handler
 * beside it.
 *
 * Effects run here, at the program boundary, with `Effect.runPromise`.
 */
import * as Pg from "@effect/sql-pg"
import { PostgresDatabase } from "@smthrs/database"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { CloudflareRuntime, ExecutionObject } from "../../src/index.ts"
import { Answer, runtime } from "../fixtures/AnswerFlow.ts"
import * as NestedFlows from "../fixtures/NestedFlows.ts"

/** The slice of Durable Object storage this Worker uses. */
interface RawStorage {
  transaction<A>(body: (transaction: RawTransaction) => Promise<A>): Promise<A>
  get(key: string): Promise<unknown>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
  list(): Promise<Map<string, unknown>>
  getAlarm(): Promise<number | null>
  setAlarm(scheduledTime: number): Promise<void>
  deleteAlarm(): Promise<void>
  sync(): Promise<void>
}

type RawTransaction = Pick<RawStorage, "get" | "put" | "delete" | "setAlarm" | "deleteAlarm">

/** The slice of `DurableObjectState` this Worker uses. */
interface State {
  readonly id: { toString(): string }
  readonly storage: RawStorage
  abort(reason?: string): void
}

interface Env {
  readonly HYPERDRIVE: { readonly connectionString: string }
  readonly SCHEMA: string
  readonly RETAIN_MS: string
  readonly EXECUTION: Namespace
  readonly NESTED: Namespace
  readonly RETAINED: Namespace
  readonly PROBE: Namespace
}

interface Namespace {
  idFromName(name: string): unknown
  get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> }
}

/** `ExecutionObject.Storage` over the raw Promise API. */
const storageOps = (raw: RawTransaction): ExecutionObject.Storage => ({
  get: <A>(key: string) => Effect.promise(() => raw.get(key) as Promise<A | undefined>),
  put: (key, value) => Effect.promise(() => raw.put(key, value)),
  delete: (key) => Effect.promise(() => raw.delete(key)),
  setAlarm: (scheduledTime) => Effect.promise(() => raw.setAlarm(scheduledTime)),
  deleteAlarm: () => Effect.promise(() => raw.deleteAlarm())
})

const storageOf = (raw: RawStorage): ExecutionObject.Storage => ({
  ...storageOps(raw),
  transaction: (body) =>
    Effect.promise((signal) => raw.transaction((txn) => Effect.runPromise(body(storageOps(txn)), { signal })))
})

const list = async (raw: RawStorage, key: string): Promise<ReadonlyArray<unknown>> =>
  ((await raw.get(key)) as ReadonlyArray<unknown> | undefined) ?? []

/** `Execution` runs one execution, so routing anything is a defect. */
const unrouted: ExecutionObject.Router = {
  start: (intent) => Effect.die(new Error(`unexpected start of ${intent.executionId}`)),
  wake: (executionId) => Effect.die(new Error(`unexpected wake of ${executionId}`))
}

/** A request one object makes of another; a non-2xx answer fails it. */
class RouteFailed extends Error {}

/** `ExecutionObject.Router` over a namespace: each object is named by its execution id. */
const routerOf = (namespace: Namespace): ExecutionObject.Router<unknown> => {
  const call = (executionId: string, path: string, body?: string) =>
    Effect.tryPromise(async () => {
      const response = await namespace.get(namespace.idFromName(executionId)).fetch(`https://object/${path}`, {
        method: "POST",
        ...(body === undefined ? {} : { body })
      })
      if (!response.ok) throw new RouteFailed(`${path} answered ${response.status}`)
    })
  return {
    start: (intent) => call(intent.executionId, "start", JSON.stringify(intent)),
    wake: (executionId) => call(executionId, "wake")
  }
}

export class Execution {
  readonly state: State
  readonly env: Env
  /** This incarnation: a reset object comes back as a new instance with a new one. */
  readonly incarnation = crypto.randomUUID()

  constructor(state: State, env: Env) {
    this.state = state
    this.env = env
  }

  async fetch(request: Request): Promise<Response> {
    const storage = this.state.storage
    if (new URL(request.url).pathname === "/start") {
      const intent = (await request.json()) as ExecutionObject.Intent
      await Effect.runPromise(ExecutionObject.start(storageOf(storage), intent, Effect.void))
      return new Response("accepted")
    }
    return Response.json({
      steps: await list(storage, "steps"),
      outcomes: await list(storage, "outcomes"),
      alarm: await storage.getAlarm()
    })
  }

  async alarm(): Promise<void> {
    const storage = this.state.storage
    const record = (label: string) =>
      Effect.promise(async () => {
        const steps = await list(storage, "steps")
        await storage.put("steps", [...steps, { incarnation: this.incarnation, label, at: Date.now() }])
        if (label === "answer" && !steps.some((step) => (step as { label: string }).label === "answer")) {
          await storage.sync()
          this.state.abort("reset inside a step")
        }
        return label
      })
    const outcome = await Effect.runPromise(ExecutionObject.alarm(storageOf(storage), {
      flows: [Answer],
      runtime: runtime({
        hostId: this.state.id.toString(),
        record,
        database: PostgresDatabase.layer({
          url: this.env.HYPERDRIVE.connectionString,
          driver: Pg,
          schema: this.env.SCHEMA
        })
      }),
      router: unrouted
    }))
    await storage.put("outcomes", [...(await list(storage, "outcomes")), outcome])
  }
}

export class Nested {
  readonly state: State
  readonly env: Env
  /** This incarnation: a reset object comes back as a new instance with a new one. */
  readonly incarnation = crypto.randomUUID()

  constructor(state: State, env: Env) {
    this.state = state
    this.env = env
  }

  async fetch(request: Request): Promise<Response> {
    const storage = this.state.storage
    const path = new URL(request.url).pathname
    if (path === "/start") {
      const intent = (await request.json()) as ExecutionObject.Intent
      await Effect.runPromise(ExecutionObject.start(storageOf(storage), intent, Effect.void))
      return new Response("accepted")
    }
    if (path === "/wake") {
      return new Response((await Effect.runPromise(ExecutionObject.wake(storageOf(storage)))) ? "armed" : "idle")
    }
    return Response.json({
      steps: await list(storage, "steps"),
      outcomes: await list(storage, "outcomes"),
      alarm: await storage.getAlarm()
    })
  }

  async alarm(): Promise<void> {
    const storage = this.state.storage
    const record = (label: string) =>
      Effect.promise(async () => {
        const steps = await list(storage, "steps")
        await storage.put("steps", [...steps, { incarnation: this.incarnation, label, at: Date.now() }])
        if (label === "bump:1" && !steps.some((step) => (step as { label: string }).label === label)) {
          await storage.sync()
          this.state.abort("reset inside a round's step")
        }
        return label
      })
    const hostId = this.state.id.toString()
    const outcome = await Effect.runPromise(ExecutionObject.alarm(storageOf(storage), {
      flows: NestedFlows.flows,
      runtime: (intent) =>
        CloudflareRuntime.layer({ hostId, executionId: intent.executionId }, NestedFlows.registration(record)).pipe(
          Layer.provide(PostgresDatabase.layer({
            url: this.env.HYPERDRIVE.connectionString,
            driver: Pg,
            schema: this.env.SCHEMA
          }))
        ),
      router: routerOf(this.env.NESTED)
    }))
    await storage.put("outcomes", [...(await list(storage, "outcomes")), outcome])
  }
}

export class Retained {
  readonly state: State
  readonly env: Env
  readonly steps: Array<string> = []
  readonly outcomes: Array<ExecutionObject.Outcome> = []

  constructor(state: State, env: Env) {
    this.state = state
    this.env = env
  }

  async fetch(request: Request): Promise<Response> {
    const storage = this.state.storage
    const path = new URL(request.url).pathname
    if (path === "/start") {
      const intent = (await request.json()) as ExecutionObject.Intent
      await Effect.runPromise(ExecutionObject.start(storageOf(storage), intent, Effect.void))
      return new Response("accepted")
    }
    if (path === "/wake") {
      return new Response((await Effect.runPromise(ExecutionObject.wake(storageOf(storage)))) ? "armed" : "idle")
    }
    return Response.json({
      steps: this.steps,
      outcomes: this.outcomes,
      storage: Object.fromEntries(await storage.list()),
      alarm: await storage.getAlarm()
    })
  }

  async alarm(): Promise<void> {
    const outcome = await Effect.runPromise(ExecutionObject.alarm(storageOf(this.state.storage), {
      flows: [Answer],
      runtime: runtime({
        hostId: this.state.id.toString(),
        record: (label) => Effect.sync(() => this.steps.push(label)).pipe(Effect.as(label)),
        database: PostgresDatabase.layer({
          url: this.env.HYPERDRIVE.connectionString,
          driver: Pg,
          schema: this.env.SCHEMA
        })
      }),
      router: unrouted,
      settledRetentionMs: Number(this.env.RETAIN_MS)
    }))
    this.outcomes.push(outcome)
  }
}

export class Probe {
  readonly state: State
  running = 0
  most = 0
  handled = 0

  constructor(state: State) {
    this.state = state
  }

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/failed-start") {
      const storage = storageOf(this.state.storage)
      const intent = await request.json() as ExecutionObject.Intent
      // Lose the handler after both writes, inside the real SQLite transaction.
      const fault: ExecutionObject.Storage = {
        ...storage,
        transaction: (body) =>
          storage.transaction!((transaction) =>
            body({
              ...transaction,
              put: (key, value) => transaction.put(key, value).pipe(Effect.andThen(Effect.die("connection lost")))
            })
          )
      }
      const result = await Effect.runPromiseExit(ExecutionObject.start(fault, intent, Effect.void))
      return Response.json({
        outcome: result._tag,
        entries: [...await this.state.storage.list()],
        alarm: await this.state.storage.getAlarm()
      })
    }
    if (new URL(request.url).pathname === "/arm") {
      await this.state.storage.setAlarm(Date.now())
      return new Response("armed")
    }
    return Response.json({ handled: this.handled, most: this.most })
  }

  async alarm(): Promise<void> {
    this.running += 1
    this.most = Math.max(this.most, this.running)
    this.handled += 1
    // The first handler arms an alarm that is already due, then keeps running.
    if (this.handled === 1) await this.state.storage.setAlarm(Date.now())
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    this.running -= 1
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const [, kind, name, ...rest] = url.pathname.split("/")
    const namespace = kind === "probe"
      ? env.PROBE
      : kind === "nested"
      ? env.NESTED
      : kind === "retained"
      ? env.RETAINED
      : env.EXECUTION
    const stub = namespace.get(namespace.idFromName(name ?? ""))
    return stub.fetch(`https://object/${rest.join("/")}`, {
      method: request.method,
      ...(request.method === "POST" ? { body: await request.text() } : {})
    })
  }
}
