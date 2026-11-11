/**
 * `smthrs gc` on PostgreSQL: the snapshot roots a sweep marks come from the
 * selected schemas, not from local SQLite files that this backend never
 * creates. A parked run's executable closure and a completed ancestor of a
 * live child must both survive a sweep past their artifact grace period.
 */
import { NodeCrypto, NodeServices } from "@effect/platform-node"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { TestSchemas } from "@smthrs/database"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { NodeRuntime } from "@smthrs/platform-node"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Executable from "@smthrs/registry/Executable"
import * as ExecutionSnapshot from "@smthrs/registry/ExecutionSnapshot"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { existsSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import * as Gc from "../src/Gc.ts"
import * as ControlDatabaseMigrations from "../src/internal/ControlDatabaseMigrations.ts"
import * as Needs from "./Needs.ts"

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer)

/** Pins a one-module flow's closure into `root`'s objects directory and ages every blob of it. */
const pinAgedClosure = (root: string) => {
  const flowDirectory = join(root, ".smithers", "flows", "pinned")
  mkdirSync(flowDirectory, { recursive: true })
  symlinkSync(join(import.meta.dirname, "..", "node_modules"), join(root, "node_modules"), "dir")
  writeFileSync(join(flowDirectory, "value.ts"), "export const value = \"retained implementation\"\n")
  writeFileSync(
    join(flowDirectory, "flow.ts"),
    `
      import { Flow } from "@smthrs/flow"
      import { Node } from "@smthrs/plan"
      import { Schema } from "effect"
      import { value } from "./value.ts"
      export default Flow.make("pinned", {
        description: "Pinned closure fixture.", capabilities: [],
        effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
        payload: {}, success: Schema.String, body: () => Node.succeed(value)
      })
    `
  )
  return Effect.runPromise(
    Effect.gen(function*() {
      const discovery = yield* Discovery.Discovery
      const found = yield* discovery.scan({ source: "project", root: join(root, ".smithers", "flows"), naming: "path" })
      const executable = yield* Executable.fromDescriptor(found.entries[0]!, { delegates: [] })
      const snapshots = yield* ExecutionSnapshot.ExecutionSnapshot
      yield* snapshots.pin(executable)
      const digest = Descriptor.executionDigest(executable.descriptor)!
      const blobs = yield* snapshots.roots([digest])
      const aged = (Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000
      const paths = blobs.map((blob) => join(root, ".flows", "objects", blob.slice(0, 2), blob))
      for (const path of paths) utimesSync(path, aged, aged)
      return { digest, paths }
    }).pipe(
      Effect.provide(
        Layer.merge(Discovery.layer, ExecutionSnapshot.layerFileSystem({ root })).pipe(Layer.provide(platform))
      ),
      Effect.provide(platform)
    )
  )
}

it.for([
  { case: "a parked run", status: "suspended", liveChild: false },
  { case: "a completed ancestor of a live child", status: "completed", liveChild: true }
])(
  "keeps the aged executable closure of $case on PostgreSQL",
  async ({ status, liveChild }, context) => {
    const postgresUrl = Needs.postgres(context)
    const root = await mkdtemp(join(tmpdir(), "postgres-gc-"))
    const prefix = TestSchemas.schemaName("test_gc")
    vi.stubEnv("SMITHERS_POSTGRES_URL", postgresUrl)
    vi.stubEnv("SMITHERS_POSTGRES_SCHEMA", prefix)
    vi.stubEnv("SMITHERS_BACKEND", "postgres")
    const database = (kind: string) => NodeDatabase.layer({ filename: join(root, ".flows", `${kind}.db`) })
    const query = <A, E>(kind: string, body: Effect.Effect<A, E, SqlClient>) =>
      Effect.runPromise(body.pipe(Effect.provide(database(kind))))
    try {
      await Effect.runPromise(Effect.void.pipe(
        Effect.provide(NodeRuntime.storage(join(root, ".flows", "engine.db"), root)),
        Effect.provide(NodeServices.layer),
        Effect.provide(NodeCrypto.layer)
      ))
      await Effect.runPromise(
        Effect.void.pipe(Effect.provide(ControlDatabaseMigrations.layer), Effect.provide(database("control")))
      )
      const pinned = await pinAgedClosure(root)
      expect(pinned.paths).toHaveLength(3) // Entry, imported module, and manifest.
      await query(
        "control",
        Effect.gen(function*() {
          const sql = yield* SqlClient
          yield* sql`INSERT INTO flows_runs(run_id,status,created_at_ms,finished_at_ms,state_json)
            VALUES('pinned-run',${status},1,${status === "completed" ? 1 : null},${
            JSON.stringify({ executionDigest: pinned.digest })
          })`
        })
      )
      if (liveChild) {
        await query(
          "engine",
          Effect.gen(function*() {
            const sql = yield* SqlClient
            yield* sql`INSERT INTO flows_runs(run_id,status,created_at_ms,state_json)
              VALUES('live-child','suspended',1,'{}')`
            yield* sql`INSERT INTO flows_run_parents(child_id,parent_id,seq) VALUES('live-child','pinned-run',0)`
          })
        )
      }
      expect(existsSync(join(root, ".flows", "control.db"))).toBe(false)
      expect(existsSync(join(root, ".flows", "engine.db"))).toBe(false)

      const swept = await Effect.runPromise(Gc.sweep(root, { olderThan: "1s", dryRun: false, now: 60_000 }))

      expect(swept.failures).toEqual([])
      expect(swept.artifacts?.sweptDigests).toEqual([])
      for (const path of pinned.paths) expect(existsSync(path)).toBe(true)
      const kept = await query(
        "control",
        Effect.gen(function*() {
          const sql = yield* SqlClient
          return yield* sql<{ readonly runId: string }>`SELECT run_id AS "runId" FROM flows_runs`
        })
      )
      expect(kept).toEqual([{ runId: "pinned-run" }])
    } finally {
      for (const kind of ["engine", "control"]) {
        await query(
          kind,
          Effect.gen(function*() {
            const sql = yield* SqlClient
            yield* sql`DROP SCHEMA ${sql(TestSchemas.forStore(prefix, `${kind}_db`))} CASCADE`
          })
        )
      }
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  }
)
