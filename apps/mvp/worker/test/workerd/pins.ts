// Minimal Miniflare workerd Durable Object harness for `worker/pins/PinsShard.workerd.test.ts` (ADR 0170 Slice 6a).
// Exercises `PinsShard.make` over a real workerd SQLite `DurableObjectStorage` where `sql` and `transactionSync`
// live on the prototype rather than own properties.
//
// This file is the program boundary: it runs Effects with `Effect.runPromise`.
import type { ObjectDatabase } from "@smthrs/platform-cloudflare"
import { ShardProtocol } from "@smthrs/sync"
import { Effect, Schema, Scope } from "effect"
import * as Reactivity from "effect/reactivity/Reactivity"
import * as PinsShard from "../../pins/PinsShard.vibe"

interface State {
  readonly id: { readonly name?: string }
  readonly storage: ObjectDatabase.Storage
}

interface Env {
  readonly PINS: {
    idFromName(name: string): unknown
    get(id: unknown): { fetch(request: Request): Promise<Response> }
  }
}

export class PinsObject {
  private readonly state: State
  private hubPromise: Promise<Effect.Success<ReturnType<typeof PinsShard.make>>> | undefined

  constructor(state: State) {
    this.state = state
  }

  private open() {
    const { id, storage } = this.state
    return this.hubPromise ??= Effect.runPromise(Effect.gen(function*() {
      const shard = yield* Schema.decodeUnknownEffect(ShardProtocol.ShardId)(id.name)
      const personId = shard.slice("person:".length)
      return yield* PinsShard.make(storage, shard, personId).pipe(
        Effect.provide(Reactivity.layer),
        Scope.provide(yield* Scope.make()),
      )
    }))
  }

  async fetch(request: Request): Promise<Response> {
    const hub = await this.open()
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === "/state") {
      const state = await Effect.runPromise(hub.state)
      const head = await Effect.runPromise(hub.head)
      return Response.json({ head, ...state })
    }
    if (request.method === "POST" && url.pathname === "/submit") {
      const body = await request.json() as ShardProtocol.SubmitRequest
      const answer = await Effect.runPromise(hub.submit(body))
      return Response.json(answer)
    }
    if (request.method === "POST" && url.pathname === "/compact") {
      await Effect.runPromise(hub.compact)
      // Drop cached instance to simulate DO hibernation/eviction and force cold reload from workerd SQLite.
      this.hubPromise = undefined
      return Response.json({ ok: true })
    }
    return new Response("not found", { status: 404 })
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const shard = request.headers.get("x-pins-shard")
    if (shard === null) return Promise.resolve(new Response(null, { status: 400 }))
    return env.PINS.get(env.PINS.idFromName(shard)).fetch(request)
  },
}
