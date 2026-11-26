import * as Cloudflare from "@alchemy.run/cloudflare"
import type { ObjectDatabase } from "@smthrs/platform-cloudflare"
import { ShardProtocol } from "@smthrs/sync"
import { Effect, Schema } from "effect"
import * as Reactivity from "effect/reactivity/Reactivity"
import * as MessagesShard from "./MessagesShard.ts"
import * as MessagesShardRoutes from "./MessagesShardRoutes.ts"

// The Alchemy Durable Object declaration: one object per conversation shard, named by its shard id. It runs only
// under Alchemy's bundle; MessagesShard.test.ts proves its handler through `makeShardHandler`.

export class MessagesShardObject
  extends Cloudflare.DurableObject<MessagesShardObject, {}>()("MessagesShardObject") {}

/** The bound object's handler over its own SQLite: `{ storage }`, never `{ db: storage.sql }` (decision 0170). */
export const makeShardHandler = (storage: ObjectDatabase.Storage, shard: ShardProtocol.ShardId) =>
  Effect.map(
    MessagesShard.make(storage, shard).pipe(Effect.provide(Reactivity.layer)),
    (messages) => MessagesShardRoutes.handle(messages),
  )

export const live = MessagesShardObject.make(Effect.gen(function*() {
  const state = yield* Cloudflare.DurableObjectState
  return Effect.gen(function*() {
    const shard = yield* Schema.decodeUnknownEffect(ShardProtocol.ShardId)(state.raw.id.name).pipe(Effect.orDie)
    return { fetch: yield* makeShardHandler(state.raw.storage, shard) }
  })
}))
