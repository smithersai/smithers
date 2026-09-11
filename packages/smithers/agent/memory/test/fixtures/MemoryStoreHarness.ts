import { Effect } from "effect"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlError from "effect/unstable/sql/SqlError"
import * as MemoryStore from "../../src/MemoryStore.ts"
import * as TestMemory from "../../src/test/TestMemory.ts"

export const namespace = { kind: "flow", id: "project-1" } as const
export const other = { kind: "flow", id: "project-2" } as const

export const run = <A, E>(effect: Effect.Effect<A, E, MemoryStore.MemoryStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestMemory.layer), Effect.provide(TestClock.layer())))

export const runWithDatabase = <A, E>(
  effect: Effect.Effect<A, E, MemoryStore.MemoryStore | SqlClient.SqlClient>
) => Effect.runPromise(effect.pipe(Effect.provide(TestMemory.layerWithDatabase)))

// Every message down a failure's cause chain, through SqlError reasons too.
export const causeMessages = (cause: unknown): ReadonlyArray<string> => {
  const messages: Array<string> = []
  const seen = new Set<unknown>()
  let current = cause
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current)
    const record = current as { message?: unknown; cause?: unknown; reason?: unknown }
    if (typeof record.message === "string") messages.push(record.message)
    current = SqlError.isSqlError(current) ? current.reason.cause : (record.cause ?? record.reason)
  }
  return messages
}
