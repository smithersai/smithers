/**
 * A durable Node engine over one SQLite file, for tests and examples.
 *
 * `EngineStore.layer` needs the journal and its three state stores, the
 * durable deferred/clock state, a kernel `Jj`, a `StepBoundary`, and (to make
 * sealed results shareable) a `WorkspaceSandbox`. This module wires them over
 * one SQLite file so a restart in a later engine reads the same rows a
 * previous one wrote. The examples in `@smthrs/flows`, `@smthrs/agent`, and
 * `@smthrs/mcp` share it.
 *
 * It is test support, not a host: the `Jj` it provides records nothing, and
 * it grants no capabilities. A program uses `NodeRuntime.layerHost`.
 *
 * @since 1.0.0
 */

import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodePath from "@effect/platform-node/NodePath"
import { StepBoundary, WorkspaceSandbox } from "@smthrs/engine-store"
import { Jj } from "@smthrs/kernel"
import { Ownership } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { dirname } from "node:path"
import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { deserialize, serialize } from "node:v8"
import * as AtomicFileSystem from "./AtomicFileSystem.ts"
import * as NodeRuntime from "./NodeRuntime.ts"

/**
 * A Jujutsu service that records nothing. The engine calls it for compensable
 * snapshots; a sealed action never asks for one, so the stub keeps the wiring
 * honest without requiring a jj binary.
 *
 * @category layers
 * @since 1.0.0
 */
export const stubJj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ changeId: "test-snapshot" as never, commitId: "test-snapshot" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

/**
 * Everything `EngineStore` requires, minus the engine itself.
 *
 * The boundary and the sandbox are the PRODUCTION layers: `StepBoundary.layer`
 * and `WorkspaceSandbox.layerFileSystem`, not `StepBoundary.layerTest`. That
 * pairing is what makes a sealed action's result eligible for the shared
 * step cache: the sandbox runs the body in an isolated workspace and observes
 * the whole tree, so the boundary evidence can honestly claim
 * `wholeTreeWritesVerified`. With `layerTest` the claim was a test fixture and
 * nothing composed this way ever reached the cache.
 *
 * `isAlive` is the liveness probe the store consults before stealing a run
 * from a stale owner. `Ownership.sameHostPidProbe` asks this machine's process
 * table, so a second process over the same file cannot take a run out of a
 * live one; a run recorded on another host is left to the lease. A stub that
 * returns `false` without asking is the one thing a real deployment must not
 * do: it says "that owner is gone" about an owner it never looked at.
 *
 * `OwnerIdentity.layer` is the default owner minter: the process id plus a
 * fresh nonce. It is listed here rather than assumed because it is the seam a
 * host with a better answer replaces.
 *
 * @category layers
 * @since 1.0.0
 */
export const requirements = (filename: string) =>
  Layer.mergeAll(
    StepBoundary.layer,
    WorkspaceSandbox.layerFileSystem(),
    stubJj
  ).pipe(
    Layer.provideMerge(NodeRuntime.storage(filename)),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(Layer.merge(AtomicFileSystem.layer, NodePath.layer))
  )

/**
 * A durable `FlowEngine` over the SQLite file at `filename`.
 *
 * The stores are merged into the output rather than hidden, so a caller can
 * read the journal or a run row back after executing a flow.
 *
 * @category layers
 * @since 1.0.0
 */
export const durableEngine = (filename: string, hostId: string) =>
  NodeRuntime.layer(
    {
      filename,
      workspaceRoot: dirname(filename),
      owner: { hostId },
      isAlive: Ownership.sameHostPidProbe
    },
    StepBoundary.layer,
    WorkspaceSandbox.layerFileSystem(),
    // Each caller provides this layer beneath its action implementations and
    // Interpreter registrations. The public composition accepts the
    // registration phase here; `Layer.empty` keeps this helper compatible with
    // those focused callers while preserving their same outer startup order.
    Layer.empty
  ).pipe(
    Layer.provideMerge(stubJj),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(AtomicFileSystem.layer)
  )

/**
 * SQLite-backed object storage for exercising host-independent object code on Node.
 * Keys and alarm deadlines persist in SQLite; values use V8's structured serializer.
 * Prefix listings are lexically sorted and honor an inclusive optional `start` cursor.
 * The caller owns `close`. Alarms are persisted deadlines, driven explicitly by the
 * test's durable host, rather than timers owned by this storage primitive.
 *
 * @category testing
 * @since 1.0.0
 */
export const sqliteObjectStorage = (filename = ":memory:") => {
  const db = new DatabaseSync(filename)
  db.exec("CREATE TABLE IF NOT EXISTS _object_values (key TEXT PRIMARY KEY, value BLOB NOT NULL)")
  let depth = 0
  const sql = {
    exec(query: string, ...params: ReadonlyArray<unknown>) {
      if (/^\s*(BEGIN|SAVEPOINT|COMMIT|ROLLBACK|RELEASE)\b/i.test(query)) {
        throw new Error("Use storage.transaction() for transactions")
      }
      const statement = db.prepare(query)
      const columnNames = statement.columns().map((column) => column.name)
      const rows = columnNames.length === 0
        ? (statement.run(...params as Array<SQLInputValue>), [])
        : statement.all(...params as Array<SQLInputValue>)
      return {
        columnNames,
        toArray: () => rows,
        raw: function*() {
          for (const row of rows) yield columnNames.map((name) => (row as Record<string, unknown>)[name])
        }
      }
    }
  }
  const get = async (key: string): Promise<unknown> => {
    const row = db.prepare("SELECT value FROM _object_values WHERE key = ?").get(key)
    return row === undefined ? undefined : deserialize(row.value as Uint8Array)
  }
  const put = async (input: string | Record<string, unknown>, value?: unknown): Promise<void> => {
    const entries = typeof input === "string" ? [[input, value] as const] : Object.entries(input)
    for (const [key, item] of entries) {
      db.prepare(
        "INSERT INTO _object_values(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).run(key, serialize(item))
    }
  }
  const remove = async (key: string): Promise<boolean> =>
    Number(db.prepare("DELETE FROM _object_values WHERE key = ?").run(key).changes) !== 0
  const list = async (
    { prefix, start }: { readonly prefix: string; readonly start?: string }
  ): Promise<Map<string, unknown>> =>
    new Map(
      db.prepare("SELECT key, value FROM _object_values ORDER BY key").all()
        .filter((row) => String(row.key).startsWith(prefix) && (start === undefined || String(row.key) >= start))
        .map((row) => [String(row.key), deserialize(row.value as Uint8Array)])
    )
  const transaction = async <A>(body: (txn: { rollback(): void }) => Promise<A>): Promise<A> => {
    const level = depth++
    const name = `object_${level}`
    db.exec(level === 0 ? "BEGIN" : `SAVEPOINT ${name}`)
    let rollback = false
    const finish = (commit: boolean) => {
      depth--
      db.exec(
        level === 0 ?
          (commit ? "COMMIT" : "ROLLBACK")
          : (commit ? `RELEASE ${name}` : `ROLLBACK TO ${name}; RELEASE ${name}`)
      )
    }
    try {
      const result = await body({
        rollback: () => {
          rollback = true
        }
      })
      finish(!rollback)
      return result
    } catch (error) {
      finish(false)
      throw error
    }
  }
  return {
    sql,
    get,
    put,
    delete: remove,
    list,
    transaction,
    setAlarm: (time: number) => put("_object_alarm", time),
    deleteAlarm: async () => {
      await remove("_object_alarm")
    },
    alarm: () => get("_object_alarm"),
    close: () => db.close()
  }
}
