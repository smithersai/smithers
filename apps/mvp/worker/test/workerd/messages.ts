// The Worker worker/chat/MessagesShard.workerd.test.ts runs in local workerd (Miniflare): a plain Durable Object, one
// per conversation shard, that hands its own SQLite storage and its name to the handler the Alchemy-declared object
// serves (worker/chat/MessagesShardRoutes.ts `handlerOf`, worker/chat/MessagesShardObject.ts). The Worker in front of
// it does what ChatApi's binding does: `getByName(shard).fetch(request)`, the shard named by a header the test sets.
//
// This file is the program boundary: it runs Effects with `Effect.runPromise`.
import type { ObjectDatabase } from "@smthrs/platform-cloudflare"
import { ShardProtocol } from "@smthrs/sync"
import { Effect, Schema, Scope } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import * as MessagesShardRoutes from "../../chat/MessagesShardRoutes.ts"
import { SHARD_HEADER } from "./messagesHeader.ts"

interface State {
  readonly id: { readonly name?: string }
  readonly storage: ObjectDatabase.Storage
}

interface Env {
  readonly MESSAGES: {
    idFromName(name: string): unknown
    get(id: unknown): { fetch(request: Request): Promise<Response> }
  }
}

export class Messages {
  private readonly state: State
  private handler: Promise<Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest>> | undefined

  constructor(state: State) {
    this.state = state
  }

  /** The handler over this object's SQLite, made on the first request of each incarnation and kept for its life. */
  private serve() {
    const { id, storage } = this.state
    return this.handler ??= Effect.runPromise(Effect.gen(function*() {
      const shard = yield* Schema.decodeUnknownEffect(ShardProtocol.ShardId)(id.name)
      return yield* MessagesShardRoutes.handlerOf(storage, shard).pipe(Scope.provide(yield* Scope.make()))
    }))
  }

  async fetch(request: Request): Promise<Response> {
    const handler = await this.serve()
    return Effect.runPromise(handler.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request)),
      Effect.map(HttpServerResponse.toWeb),
    ))
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const shard = request.headers.get(SHARD_HEADER)
    if (shard === null) return Promise.resolve(new Response(null, { status: 400 }))
    return env.MESSAGES.get(env.MESSAGES.idFromName(shard)).fetch(request)
  },
}
