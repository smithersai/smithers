// The Worker worker/ExecutionHost.workerd.test.ts runs in local workerd (Miniflare): a plain Durable Object that hands
// its storage and id to worker/ExecutionHost.ts, exactly as the Alchemy-declared object in worker/Executions.ts does,
// over the compose Postgres through Miniflare's local Hyperdrive. Its flow is the deployed `probe/Pause`; only the step
// differs: it records which incarnation ran it, and the first `:after` step resets the object with `ctx.abort()`, so
// the alarm Cloudflare retries runs in a new incarnation that must take the run over and finish it.
//
// This file is the program boundary: it runs Effects with `Effect.runPromise`.
import { Effect } from "effect"
import * as ExecutionHost from "../../ExecutionHost.ts"
import * as Pause from "../../flows/Pause.vibe"

/** The slice of Durable Object storage this Worker uses. */
interface RawStorage {
  get(key: string): Promise<unknown>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
  getAlarm(): Promise<number | null>
  setAlarm(scheduledTime: number): Promise<void>
  deleteAlarm(): Promise<void>
  sync(): Promise<void>
}

interface State {
  readonly id: { toString(): string }
  readonly storage: RawStorage
  abort(reason?: string): void
}

interface Env {
  readonly HYPERDRIVE: { readonly connectionString: string }
  readonly SCHEMA: string
  readonly EXECUTION: {
    idFromName(name: string): unknown
    get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> }
  }
}

/** `ExecutionHost`'s storage over the raw Promise API, as Alchemy's `DurableObjectState` provides it. */
const storageOf = (raw: RawStorage): ExecutionHost.Storage => ({
  get: <A>(key: string) => Effect.promise(() => raw.get(key) as Promise<A | undefined>),
  put: (key, value) => Effect.promise(() => raw.put(key, value)),
  delete: (key) => Effect.promise(() => raw.delete(key)),
  setAlarm: (at) => Effect.promise(() => raw.setAlarm(at)),
  deleteAlarm: () => Effect.promise(() => raw.deleteAlarm()),
})

const list = async (raw: RawStorage, key: string): Promise<Array<unknown>> =>
  ((await raw.get(key)) as Array<unknown> | undefined) ?? []

export class Execution {
  readonly state: State
  readonly env: Env
  /** This incarnation: a reset object comes back as a new instance. */
  readonly incarnation = crypto.randomUUID()

  constructor(state: State, env: Env) {
    this.state = state
    this.env = env
  }

  host() {
    const storage = this.state.storage
    const mark = (label: string) =>
      Effect.promise(async () => {
        const marks = await list(storage, "marks")
        await storage.put("marks", [...marks, { incarnation: this.incarnation, label, at: Date.now() }])
        if (label.endsWith(":after") && !marks.some((m) => (m as { label: string }).label === label)) {
          await storage.sync()
          this.state.abort("reset inside a step")
        }
        return label
      })
    const object = (executionId: string) => this.env.EXECUTION.get(this.env.EXECUTION.idFromName(executionId))
    return ExecutionHost.make(storageOf(storage), {
      hostId: this.state.id.toString(),
      database: ExecutionHost.database(this.env.HYPERDRIVE.connectionString, this.env.SCHEMA),
      flows: { flows: [Pause.Pause], registration: Pause.registration(mark) },
      // As worker/Executions.ts routes through its namespace; `probe/Pause` never calls it.
      router: {
        start: (intent) =>
          Effect.promise(() => object(intent.executionId).fetch("https://object/start", {
            method: "POST",
            body: JSON.stringify(intent),
          })).pipe(Effect.asVoid),
        wake: (executionId) =>
          Effect.promise(() => object(executionId).fetch("https://object/wake", { method: "POST" })).pipe(
            Effect.asVoid,
          ),
      },
    })
  }

  async fetch(request: Request): Promise<Response> {
    const storage = this.state.storage
    const path = new URL(request.url).pathname
    if (path === "/start") {
      await Effect.runPromise(this.host().start(await request.json()))
      return new Response("started")
    }
    if (path === "/wake") return new Response(String(await Effect.runPromise(this.host().wake())))
    return Response.json({
      marks: await list(storage, "marks"),
      outcomes: await list(storage, "outcomes"),
      alarm: await storage.getAlarm(),
    })
  }

  async alarm(): Promise<void> {
    const outcome = await Effect.runPromise(this.host().alarm())
    await this.state.storage.put("outcomes", [...(await list(this.state.storage, "outcomes")), outcome])
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const [, name, ...rest] = new URL(request.url).pathname.split("/")
    const stub = env.EXECUTION.get(env.EXECUTION.idFromName(name ?? ""))
    return stub.fetch(`https://object/${rest.join("/")}`, {
      method: request.method,
      ...(request.method === "POST" ? { body: await request.text() } : {}),
    })
  },
}
