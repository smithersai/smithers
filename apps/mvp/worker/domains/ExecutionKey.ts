import { Effect } from "effect"

export const randomExecutionKey = Effect.sync(() => crypto.randomUUID())
