import { Effect } from "effect"

export const randomId = Effect.sync(() => crypto.randomUUID())
