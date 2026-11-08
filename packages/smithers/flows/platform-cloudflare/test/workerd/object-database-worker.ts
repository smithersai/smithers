/**
 * The Object database smoke's Worker: a real SQLite-backed Durable Object
 * that runs `AnswerFlow` from its alarms over `ObjectDatabase`, its own
 * storage, with no database server.
 *
 * `answer` calls `ctx.abort()` the first time it runs, so the object is reset
 * inside a step and the alarm Cloudflare retries runs in a new incarnation,
 * which must find the run in the object's own SQLite and finish it. `/rows`
 * reads the engine's run row back through the same storage.
 *
 * Effects run here, at the program boundary, with `Effect.runPromise`.
 */
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/sql/SqlClient"
import { ExecutionObject, ObjectDatabase } from "../../src/index.ts"
import { Answer, runtime } from "../fixtures/AnswerFlow.ts"

/** The slice of a SQLite-backed Durable Object's storage this Worker uses. */
type RawStorage = ObjectDatabase.Storage & {
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

const storageOf = (raw: RawStorage): ExecutionObject.Storage => ({
  get: <A>(key: string) => Effect.promise(() => raw.get(key) as Promise<A | undefined>),
  put: (key, value) => Effect.promise(() => raw.put(key, value)),
  delete: (key) => Effect.promise(() => raw.delete(key)),
  setAlarm: (scheduledTime) => Effect.promise(() => raw.setAlarm(scheduledTime)),
  deleteAlarm: () => Effect.promise(() => raw.deleteAlarm())
})

const list = async (raw: RawStorage, key: string): Promise<ReadonlyArray<unknown>> =>
  ((await raw.get(key)) as ReadonlyArray<unknown> | undefined) ?? []

const unrouted: ExecutionObject.Router = {
  start: (intent) => Effect.die(new Error(`unexpected start of ${intent.executionId}`)),
  wake: (executionId) => Effect.die(new Error(`unexpected wake of ${executionId}`))
}

export class Local {
  readonly state: State
  /** This incarnation: a reset object comes back as a new instance with a new one. */
  readonly incarnation = crypto.randomUUID()

  constructor(state: State) {
    this.state = state
  }

  async fetch(request: Request): Promise<Response> {
    const storage = this.state.storage
    const path = new URL(request.url).pathname
    if (path === "/start") {
      const intent = (await request.json()) as ExecutionObject.Intent
      await Effect.runPromise(ExecutionObject.start(storageOf(storage), intent, Effect.void))
      return new Response("accepted")
    }
    if (path === "/rows") {
      const rows = await Effect.runPromise(
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) => sql<{ readonly run_id: string; readonly status: string }>`SELECT run_id, status FROM flows_runs`
        ).pipe(
          Effect.provide(ObjectDatabase.layer(storage))
        )
      )
      return Response.json(rows)
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
      runtime: runtime({ hostId: this.state.id.toString(), record, database: ObjectDatabase.layer(storage) }),
      router: unrouted
    }))
    await storage.put("outcomes", [...(await list(storage, "outcomes")), outcome])
  }
}

export default {
  async fetch(request: Request, env: { readonly LOCAL: Namespace }): Promise<Response> {
    const url = new URL(request.url)
    const [, executionId, ...rest] = url.pathname.split("/")
    const object = env.LOCAL.get(env.LOCAL.idFromName(executionId!))
    return object.fetch(`https://object/${rest.join("/")}`, request)
  }
}

interface Namespace {
  idFromName(name: string): unknown
  get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> }
}
