// Real Postgres upgrades preserve legacy instructions even when TypeScript and JSON escaping expand them.
import { digestSync } from "@smthrs/crypto"
import { TestSchemas } from "@smthrs/database"
import { RealmFlow } from "@smthrs/harness"
import { Effect, ManagedRuntime, Redacted } from "effect"
import { Migrator, SqlClient } from "effect/sql"
import { afterAll, beforeAll, expect, test } from "vitest"
import { checkSource, passes } from "../src/features/flows-ui/checks.ts"
import { MAX_SOURCE_BYTES } from "../src/features/flows-ui/contract.ts"
import { renderSource } from "../src/features/flows-ui/source.ts"
import * as Database from "./Database.ts"
import * as TestDatabase from "./TestDatabase.ts"

const runtime = ManagedRuntime.make(TestDatabase.layer("flow_source_upgrade"))
beforeAll(() => runtime.runPromise(Effect.void))
afterAll(() => runtime.dispose())

const through = (last: string) => Migrator.make({})({
  loader: Migrator.fromRecord(Object.fromEntries(
    Object.entries(Database.migrations).filter(([name]) => name.slice(0, 4) <= last),
  )),
})

const legacy = (instructions: string) =>
  `---\nname: notes\ndescription: "D."\ncapabilities: []\n---\n\n${instructions}\n`

test.each([
  ["quotes", '"'.repeat(34_000)],
  ["backslashes", "\\".repeat(34_000)],
  ["control characters", "\u0001".repeat(50_000)],
  ["short lines", "x\n".repeat(16_000) + "x"],
  ["near-limit short lines", "x\n".repeat(32_000) + "x"],
])("0025 preserves expanded %s in revisions and drafts", async (_kind, instructions) => {
  const schema = TestSchemas.schemaName("expanded")
  const server = await runtime.runPromise(TestDatabase.serverUrl)
  const scoped = new URL(server)
  scoped.searchParams.set("options", `-c search_path=${schema}`)
  const database = Database.layer(Effect.succeed(Redacted.make(scoped.toString())))
  const on = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    runtime.runPromise(Effect.provide(effect, database))
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql.unsafe(`CREATE SCHEMA ${schema}`)))
  try {
    await on(through("0024"))
    const source = legacy(instructions)
    const draftInstructions = instructions.slice(0, _kind === "control characters" ? 11_000 : 34_000).trim()
    const files = [{ path: "SKILL.md", text: legacy(draftInstructions) }]
    const id = crypto.randomUUID()
    await on(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO flows (id, owner_id, name, revision, description) VALUES (${id}, 'p', 'notes', 1, 'D.')`
      yield* sql`INSERT INTO flow_revisions (flow_id, revision, digest, source, created_by)
        VALUES (${id}, 1, ${digestSync(source)}, ${source}, 'p')`
      for (const status of ["ready", "saved", "proposed"]) {
        yield* sql`INSERT INTO flow_drafts (id, actor_id, scope, request, status, files)
          VALUES (${crypto.randomUUID()}, 'p', 'person', 'Notes', ${status}, ${JSON.stringify(files)}::jsonb)`
      }
    }))
    // The legacy constraints themselves admit the fixtures before any conversion.
    const converted = renderSource({ name: "notes", description: "D.", flows: [], instructions })
    expect(new TextEncoder().encode(converted).length).toBeGreaterThan(65_536)
    const applied = await on(Database.migrate)
    expect(applied.map(([id, name]) => `${id}_${name}`)).toContain("25_flow_source")
    expect(applied.map(([id, name]) => `${id}_${name}`)).toContain("125_flow_source_limits")
    const revisions = await on(Effect.flatMap(SqlClient.SqlClient, sql =>
      sql`SELECT source, digest FROM flow_revisions`))
    expect(revisions).toEqual([{ source: converted, digest: digestSync(converted) }])
    expect(passes(checkSource(converted, "notes", []))).toBe(true)
    const request = await runtime.runPromise(RealmFlow.step({
      source: converted, expectedTag: "notes", payload: { input: "" }, allowedActions: [RealmFlow.agentAction],
    }).pipe(Effect.provide(RealmFlow.layerDefaultVariant)))
    expect(request).toMatchObject({ _tag: "Action", name: RealmFlow.agentAction, payload: { prompt: instructions } })
    if (request._tag !== "Action") throw new Error("Expected an agent step")
    expect(await runtime.runPromise(RealmFlow.step({
      source: converted, expectedTag: "notes", payload: { input: "" }, allowedActions: [RealmFlow.agentAction],
      receipts: [{ ...request, outcome: { _tag: "Success", value: "Done." } }],
    }).pipe(Effect.provide(RealmFlow.layerDefaultVariant)))).toEqual({ _tag: "Complete", value: "Done." })
    const drafts = await on(Effect.flatMap(SqlClient.SqlClient, sql =>
      sql`SELECT status, failure, files FROM flow_drafts ORDER BY status`))
    expect(drafts).toEqual(["proposed", "ready", "saved"].map(status => ({
      status, failure: null, files: [{ path: "flow.ts", text: renderSource({
        name: "notes", description: "D.", flows: [], instructions: draftInstructions,
      }) }],
    })))
    expect(await on(Database.migrate)).toEqual([])
  } finally {
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql.unsafe(`DROP SCHEMA ${schema} CASCADE`)))
  }
})

test("0125 upgrades existing limits without changing rows and keeps oversized writes bounded", async () => {
  const schema = TestSchemas.schemaName("existing_limits")
  const server = await runtime.runPromise(TestDatabase.serverUrl)
  const scoped = new URL(server)
  scoped.searchParams.set("options", `-c search_path=${schema}`)
  const database = Database.layer(Effect.succeed(Redacted.make(scoped.toString())))
  const on = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    runtime.runPromise(Effect.provide(effect, database))
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql.unsafe(`CREATE SCHEMA ${schema}`)))
  try {
    await on(through("0124"))
    const id = crypto.randomUUID()
    await on(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      // An already-upgraded installation retains the constraints that 0025 originally left untouched.
      yield* sql`ALTER TABLE flow_revisions DROP CONSTRAINT flow_revisions_source_check,
        ADD CONSTRAINT flow_revisions_source_check CHECK (octet_length(source) <= 65536)`
      yield* sql`ALTER TABLE flow_drafts DROP CONSTRAINT flow_drafts_files_check,
        ADD CONSTRAINT flow_drafts_files_check CHECK (jsonb_typeof(files) = 'array' AND octet_length(files::text) <= 70000)`
      yield* sql`INSERT INTO flows (id, owner_id, name, revision, description)
        VALUES (${id}, 'p', 'notes', 1, 'D.')`
      yield* sql`INSERT INTO flow_revisions (flow_id, revision, name, digest, source, created_by)
        VALUES (${id}, 1, 'notes', ${digestSync("source")}, 'source', 'p')`
      yield* sql`INSERT INTO flow_drafts (id, actor_id, scope, request, status)
        VALUES (${id}, 'p', 'person', 'Notes', 'ready')`
    }))
    const read = Effect.flatMap(SqlClient.SqlClient, sql => sql`SELECT source, digest FROM flow_revisions`)
    const before = await on(read)
    expect((await on(through("0125"))).map(([id, name]) => `${id}_${name}`)).toEqual(["125_flow_source_limits"])
    expect(await on(read)).toEqual(before)
    const write = (source: string) => Effect.flatMap(SqlClient.SqlClient, sql =>
      sql`UPDATE flow_revisions SET source = ${source}`)
    await on(write("x".repeat(MAX_SOURCE_BYTES)))
    await expect(on(write("x".repeat(MAX_SOURCE_BYTES + 1)))).rejects.toBeDefined()
    // Six-byte JSON escapes at the decoded file limit still fit the serialized draft bound.
    const files = JSON.stringify([{ path: "flow.ts", text: "\u0001".repeat(MAX_SOURCE_BYTES) }])
    await on(Effect.flatMap(SqlClient.SqlClient, sql =>
      sql`UPDATE flow_drafts SET files = ${files}::jsonb`))
    for (const files of ["{}", JSON.stringify([{ path: "flow.ts", text: "x".repeat(4 * 1024 * 1024) }])]) {
      await expect(on(Effect.flatMap(SqlClient.SqlClient, sql =>
        sql`UPDATE flow_drafts SET files = ${files}::jsonb`))).rejects.toBeDefined()
    }
    expect(await on(through("0125"))).toEqual([])
  } finally {
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql.unsafe(`DROP SCHEMA ${schema} CASCADE`)))
  }
})
