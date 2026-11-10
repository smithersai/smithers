// A module the source-reading tests read beside its VibeLang twin, ../vibe/Twin.vibe: each reader must find the same
// facts in both. Never imported or run.
import * as Effect from "effect/Effect"
import { ElectricCollection } from "@smthrs/effect-electric"
import { Collection } from "@smthrs/effect-tanstack-db"
import { Hyperdrive, sql, type Draft, type Note } from "./Twin.deps.ts"

export const route = "/api/twins/:id"

export const sweep = () => Effect.gen(function* () {
  yield* sql`UPDATE sessions SET expires_at = now()`
  return yield* Effect.withSpan(Effect.void, "twin.sweep")
})

export const connect = (config: string) => Effect.gen(function* () {
  const connection = yield* Hyperdrive.Connect(config)
  return connection
})

export const notes = (repo: string) => ElectricCollection.make<Note>({ id: `twin-notes:${repo}` })
export const drafts = Collection.local<Draft>({ id: "twin-drafts" })
