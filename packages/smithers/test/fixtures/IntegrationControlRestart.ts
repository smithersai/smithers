import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as ControlMigrations from "@smthrs/control/Migrations"
import * as Crypto from "@smthrs/crypto/Crypto"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as Core from "@smthrs/integrations/core"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import * as MemoryMigrations from "@smthrs/memory/Migrations"
import * as TimeTravelMigrations from "@smthrs/time-travel/Migrations"
import { Effect, Layer } from "effect"
import * as SqlClient from "effect/sql/SqlClient"

const [operation, filename] = process.argv.slice(2)
if (filename === undefined) throw new Error("A database filename is required")
const controlSets = [...TimeTravelMigrations.sets, ControlMigrations.set, MemoryMigrations.set]
const sets = operation === "control-first" ? controlSets : [...controlSets, Core.Migrations.set]
const database = DatabaseMigrations.layer(sets).pipe(
  Layer.provideMerge(DurableWriter.layer().pipe(Layer.provideMerge(NodeDatabase.layer({ filename }))))
)
const namespace = { kind: "global", id: "release" } as const
const result = await Effect.runPromise(
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const memory = yield* MemoryStore.make
    if (operation === "fresh" || operation === "control-first") {
      yield* sql`INSERT INTO control_sequences (name, value) VALUES ('shared-database-regression', 42)`
      yield* memory.putFact({ namespace, key: "runbook", value: "preserve control and memory", provenance: {} })
    }
    let cursor: string | null = null
    if (operation !== "control-first") {
      const store = yield* Core.CursorStore.makeSql
      if (operation === "fresh" || operation === "append") yield* store.set("telegram", "99")
      cursor = yield* store.get("telegram")
    }
    return {
      cursor,
      fact: yield* memory.getFact({ namespace, key: "runbook" }),
      control: yield* sql`SELECT value FROM control_sequences WHERE name = 'shared-database-regression'`,
      ledger: yield* sql`SELECT migration_id, name FROM flows_migrations ORDER BY migration_id`
    }
  }).pipe(
    Effect.provide(database),
    Effect.provide(NodeServices.layer),
    Effect.provide(Crypto.layerFromDigest(NodeCrypto.layerDigest))
  )
)
process.stdout.write(JSON.stringify(result))
