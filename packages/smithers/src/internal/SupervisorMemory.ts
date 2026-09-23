/**
 * The supervisor's memory as the native host composes it: which database it
 * lives in, how that database waits for a concurrent writer, how recall reads
 * it, which bank a run of this workspace reads and writes, and whether the
 * run may write at all.
 *
 * Kept apart from `NativeControl` so the executor registration and the tests
 * that hold it to its promises build one and the same layer.
 *
 * @since 1.0.0
 * @private
 */
import type * as DurableWriter from "@smthrs/database/DurableWriter"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import type * as Recall from "@smthrs/memory/Recall"
import * as RecallKeyword from "@smthrs/memory/RecallKeyword"
import { Context, Effect, Layer } from "effect"
import type * as Crypto from "effect/Crypto"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { createHash } from "node:crypto"
import { resolve } from "node:path"
import * as Environment from "../Environment.ts"

/**
 * How long a connection to a memory database waits for another writer's lock
 * before SQLite answers `SQLITE_BUSY`, in milliseconds. `SMITHERS_MEMORY_DB`
 * exists to be shared: every run of one repository opens it, from as many
 * processes as a wave runs at once, and SQLite's own default is not to wait.
 *
 * @since 1.0.0
 * @private
 */
export const busyTimeoutMs = 10_000

/**
 * What the supervisor may do with memory on this host, in `Agent.Options`
 * form.
 *
 * `namespace` names the bank: the memory database when `SMITHERS_MEMORY_DB`
 * names one, because an operator who points every workspace of a repository
 * at one file has said which runs share a memory; the workspace root
 * otherwise. Never one bank for every repository on the host.
 *
 * `remember` is on only when the operator opted into a memory database of
 * its own; a workspace's engine database is not a place a run's sentences
 * should accumulate unasked. `steer` is `SMITHERS_SUPERVISOR_STEER=1`.
 *
 * @since 1.0.0
 * @private
 */
export const options = (
  environment: Environment.Source,
  workspaceRoot: string
): { readonly steer: boolean; readonly remember: boolean; readonly namespace: string } => {
  const database = Environment.read(environment, "SMITHERS_MEMORY_DB")
  const identity = resolve(database ?? workspaceRoot)
  return {
    steer: Environment.read(environment, "SMITHERS_SUPERVISOR_STEER") === "1",
    remember: database !== undefined,
    namespace: `project-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`
  }
}

/**
 * The memory store and the recall that reads it, as one layer.
 *
 * `SMITHERS_MEMORY_DB` moves the store to its own SQLite file, opened with a
 * busy timeout so concurrent writers wait for each other instead of failing;
 * without it the store shares the workspace's `stores`. Recall is keyword
 * recall over the same store, so a note written by one run is what the next
 * one reads.
 *
 * @since 1.0.0
 * @private
 */
export const layer = (input: {
  readonly environment: Environment.Source
  readonly database: (filename: string) => Layer.Layer<DurableWriter.DurableWriter | SqlClient>
  readonly crypto: Layer.Layer<Crypto.Crypto>
  /** The workspace's own stores, used when `SMITHERS_MEMORY_DB` names no file. */
  readonly stores?: Layer.Layer<DurableWriter.DurableWriter | SqlClient> | undefined
}): Layer.Layer<MemoryStore.MemoryStore | Recall.Recall> => {
  const file = Environment.read(input.environment, "SMITHERS_MEMORY_DB")
  if (file === undefined && input.stores === undefined) {
    throw new Error("SupervisorMemory.layer needs SMITHERS_MEMORY_DB or the workspace stores")
  }
  const database = file === undefined ? input.stores! : input.database(file).pipe(
    Layer.tap((context) =>
      Context.get(context, SqlClient).unsafe(`PRAGMA busy_timeout = ${busyTimeoutMs}`).pipe(Effect.orDie)
    )
  )
  const store = MemoryStore.layer.pipe(Layer.provide(database), Layer.provide(input.crypto), Layer.orDie)
  return Layer.provideMerge(RecallKeyword.layer, store)
}
