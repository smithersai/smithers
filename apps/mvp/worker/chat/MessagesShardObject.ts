import * as Cloudflare from "@alchemy.run/cloudflare"
import { ShardProtocol } from "@smthrs/sync"
import { Effect, Schema } from "effect"
import * as MessagesShardRoutes from "./MessagesShardRoutes.ts"

// The Alchemy Durable Object declaration: one object per conversation shard, named by its shard id. It runs only
// under Alchemy's bundle; MessagesShard.test.ts proves its handler through `makeShardHandler`, and
// MessagesShard.workerd.test.ts runs the same handler in a Durable Object of local workerd.

export class MessagesShardObject
  extends Cloudflare.DurableObject<MessagesShardObject, {}>()("MessagesShardObject") {}

/** The bound object's handler over its own SQLite (MessagesShardRoutes.ts `handlerOf`). */
export const makeShardHandler = MessagesShardRoutes.handlerOf

export const live = MessagesShardObject.make(Effect.gen(function*() {
  const state = yield* Cloudflare.DurableObjectState
  return Effect.gen(function*() {
    const shard = yield* Schema.decodeUnknownEffect(ShardProtocol.ShardId)(state.raw.id.name).pipe(Effect.orDie)
    return { fetch: yield* makeShardHandler(state.raw.storage, shard) }
  })
}))
