import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Cause, Effect, Exit, Layer, Logger, Schema } from "effect"
import * as Migrator from "effect/sql/Migrator"
import * as SqlClient from "effect/sql/SqlClient"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Database from "../src/index.ts"
import * as NodeDatabase from "../src/node/NodeDatabase.ts"
import * as TestDatabase from "../src/test/TestDatabase.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "100"))
const ioExecutions = Math.max(15, Math.min(Math.ceil(baseExecutions / 3), 50))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")
const silentLogger = Logger.layer([])

const runFuzz = async <A>(
  arbitrary: Arbitrary.Arbitrary<A>,
  property: (value: A) => Effect.Effect<boolean>,
  options: { readonly seed: number; readonly executions: number }
) => {
  const report = await Effect.runPromise(
    Fuzz.run(arbitrary, (value) => property(value).pipe(Effect.provide(silentLogger)), options)
  )
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

/** A violated invariant. Thrown inside a property so the finding names the broken rule. */
const must: (condition: boolean, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(`invariant violated: ${message}`)
}

type Failure =
  | { readonly kind: "ok" }
  | { readonly kind: "fail"; readonly error: unknown }
  | { readonly kind: "die"; readonly defect: unknown }

const failureOf = (exit: Exit.Exit<unknown, unknown>): Failure => {
  if (Exit.isSuccess(exit)) return { kind: "ok" }
  for (const reason of exit.cause.reasons) {
    if (Cause.isFailReason(reason)) return { kind: "fail", error: reason.error }
  }
  for (const reason of exit.cause.reasons) {
    if (Cause.isDieReason(reason)) return { kind: "die", defect: reason.defect }
  }
  return { kind: "die", defect: exit.cause }
}

// ---------------------------------------------------------------------------
// Migration ladder
// ---------------------------------------------------------------------------

const namespaces = ["alpha", "beta", "gamma"] as const

interface Declared {
  readonly local: number
  readonly variant: "a" | "b"
  /** Declares the other variant as a previous name of this migration. */
  readonly alias: boolean
}

type Codebase = ReadonlyArray<ReadonlyArray<Declared>>

interface Planned {
  readonly id: number
  readonly name: string
  readonly previous: ReadonlyArray<string>
}

const nameOf = (block: number, local: number, variant: "a" | "b") => `${namespaces[block]}_m${local}${variant}`
const other = (variant: "a" | "b"): "a" | "b" => (variant === "a" ? "b" : "a")
const idOf = (block: number, local: number) => block * Database.Migrations.idBlock + local

const plannedOf = (codebase: Codebase, omitApplied: ReadonlySet<number>, ledger: ReadonlyMap<number, string>) =>
  codebase.flatMap((entries, block): ReadonlyArray<Planned> =>
    entries
      .filter((entry) => !(omitApplied.has(block) && ledger.has(idOf(block, entry.local))))
      .map((entry) => ({
        id: idOf(block, entry.local),
        name: nameOf(block, entry.local, entry.variant),
        previous: entry.alias ? [nameOf(block, entry.local, other(entry.variant))] : []
      }))
  )

/**
 * The migration ladder's contract, stated over a ledger and a declaration:
 * a recorded id keeps its name (or a declared previous name); a new id in an
 * installed block must sit above that block's recorded maximum and beside a
 * declared recorded migration; a new id in any other block must sit above the
 * global high-water mark. A fresh ledger accepts everything.
 */
const judge = (
  ledger: ReadonlyMap<number, string>,
  planned: ReadonlyArray<Planned>
): { readonly refused: true } | { readonly refused: false; readonly fresh: ReadonlyArray<Planned> } => {
  for (const entry of planned) {
    const recorded = ledger.get(entry.id)
    if (recorded !== undefined && recorded !== entry.name && !entry.previous.includes(recorded)) {
      return { refused: true }
    }
  }
  const fresh = planned.filter((entry) => !ledger.has(entry.id)).sort((left, right) => left.id - right.id)
  if (ledger.size === 0) return { refused: false, fresh }
  const blockOf = (id: number) => Math.floor(id / Database.Migrations.idBlock)
  const highWater = Math.max(...ledger.keys())
  const installed = new Map<number, number>()
  for (const id of ledger.keys()) installed.set(blockOf(id), Math.max(installed.get(blockOf(id)) ?? -1, id))
  const known = new Set(planned.filter((entry) => ledger.has(entry.id)).map((entry) => blockOf(entry.id)))
  for (const entry of fresh) {
    const blockMax = installed.get(blockOf(entry.id))
    if (blockMax === undefined ? entry.id <= highWater : !known.has(blockOf(entry.id)) || entry.id <= blockMax) {
      return { refused: true }
    }
  }
  return { refused: false, fresh }
}

const Edit = Schema.Struct({
  block: Schema.Literals([0, 1, 2]),
  kind: Schema.Literals(["append", "appendTwo", "appendGap", "fillHole", "rename", "renameAliased", "orphan", "none"]),
  startAtZero: Schema.Boolean,
  pick: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 7 })),
  sabotage: Schema.Literals(["none", "none", "fail", "die", "sql"]),
  reverseSets: Schema.Boolean,
  reruns: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 }))
})

const applyEdit = (codebase: Codebase, edit: typeof Edit.Type): Codebase => {
  const entries = codebase[edit.block] ?? []
  const locals = entries.map((entry) => entry.local)
  const max = locals.length === 0 ? undefined : Math.max(...locals)
  const first = edit.startAtZero ? 0 : 1
  const add = (...added: ReadonlyArray<number>): Codebase =>
    codebase.map((existing, block) =>
      block === edit.block
        ? [...existing, ...added.map((local) => ({ local, variant: "a" as const, alias: false }))]
        : existing
    )
  switch (edit.kind) {
    case "none":
      return codebase
    case "append":
    case "orphan":
      return add(max === undefined ? first : max + 1)
    case "appendTwo":
      return max === undefined ? add(first, first + 1) : add(max + 1, max + 2)
    case "appendGap":
      return max === undefined ? add(first, first + 2) : add(max + 2)
    case "fillHole": {
      for (let local = 0; local < (max ?? 0); local++) {
        if (!locals.includes(local)) return add(local)
      }
      return add(max === undefined ? first : max + 1)
    }
    case "rename":
    case "renameAliased": {
      if (entries.length === 0) return add(first)
      const target = edit.pick % entries.length
      return codebase.map((existing, block) =>
        block === edit.block
          ? existing.map((entry, index) =>
            index === target
              ? { local: entry.local, variant: other(entry.variant), alias: edit.kind === "renameAliased" }
              : entry
          )
          : existing
      )
    }
  }
}

class Sabotage extends Schema.TaggedError<Sabotage>()("Sabotage", { id: Schema.Number }) {}

describe("@smthrs/database migration ladder, parameter binding and transaction model fuzz", () => {
  it("migration passes are idempotent, monotonic, atomic under failure and fail closed on ledger drift", async () => {
    const arbitrary = Arbitrary.schema(
      Schema.Struct({
        edits: Schema.Array(Edit).check(Schema.isMinLength(1), Schema.isMaxLength(6)),
        tamper: Schema.Literals(["none", "negativeId", "renameRow", "deleteRow"]),
        tamperPick: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 15 }))
      })
    )

    await runFuzz(
      arbitrary,
      ({ edits, tamper, tamperPick }) =>
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          const ledger = new Map<number, string>()
          let codebase: Codebase = [[], [], []]
          let bodyRuns = 0

          const setsOf = (
            planned: ReadonlyArray<Planned>,
            sabotage: { readonly id: number; readonly mode: "fail" | "die" | "sql" } | undefined,
            reverse: boolean
          ): ReadonlyArray<Database.Migrations.MigrationSet> => {
            const sets = namespaces.flatMap((namespace, block): ReadonlyArray<Database.Migrations.MigrationSet> => {
              const mine = planned.filter((entry) => Math.floor(entry.id / Database.Migrations.idBlock) === block)
              if (mine.length === 0) return []
              const migrations: Record<string, Effect.Effect<void, unknown, SqlClient.SqlClient>> = {}
              const previousNames: Record<string, ReadonlyArray<string>> = {}
              for (const entry of mine) {
                const local = entry.id - block * Database.Migrations.idBlock
                const key = `${String(local).padStart(4, "0")}_${entry.name.slice(namespace.length + 1)}`
                if (entry.previous.length > 0) {
                  previousNames[key] = entry.previous.map((name) => name.slice(namespace.length + 1))
                }
                migrations[key] = Effect.gen(function*() {
                  const client = yield* SqlClient.SqlClient
                  bodyRuns += 1
                  yield* client`CREATE TABLE ${client(`t_${entry.id}`)} (v INTEGER NOT NULL)`
                  yield* client`INSERT INTO ${client(`t_${entry.id}`)} (v) VALUES (${entry.id})`
                  if (sabotage?.id !== entry.id) return
                  if (sabotage.mode === "fail") return yield* Effect.fail(new Sabotage({ id: entry.id }))
                  if (sabotage.mode === "die") return yield* Effect.die(new Error(`sabotage:${entry.id}`))
                  yield* client`INSERT INTO no_such_table (v) VALUES (${entry.id})`
                })
              }
              return [{
                namespace,
                idOffset: block * Database.Migrations.idBlock,
                migrations,
                ...(Object.keys(previousNames).length > 0 ? { previousNames } : {})
              }]
            })
            return reverse ? [...sets].reverse() : sets
          }

          /** The ledger and every migration-owned table, read back from SQLite. */
          const observe = Effect.gen(function*() {
            const tables = (yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`).map((
              row
            ) => row.name)
            const rows = tables.includes(Database.Migrations.table)
              ? yield* sql<{ migration_id: number; name: string }>`SELECT migration_id, name FROM ${
                sql(Database.Migrations.table)
              } ORDER BY migration_id`
              : []
            const owned = tables.filter((name) => name.startsWith("t_")).sort()
            const contents: Array<string> = []
            for (const name of owned) {
              const values = yield* sql<{ v: number }>`SELECT v FROM ${sql(name)}`
              contents.push(`${name}=${values.map((row) => row.v).join(",")}`)
            }
            return {
              ledger: rows.map((row) => `${Number(row.migration_id)}:${row.name}`),
              tables: contents
            }
          })

          const expectState = (label: string) =>
            Effect.map(observe, (seen) => {
              const ids = [...ledger.keys()].sort((left, right) => left - right)
              expect(seen.ledger, `${label}: ledger`).toEqual(ids.map((id) => `${id}:${ledger.get(id)}`))
              // Exactly one table per recorded migration, holding exactly the one row its body wrote.
              expect([...seen.tables].sort(), `${label}: tables`).toEqual(ids.map((id) => `t_${id}=${id}`).sort())
            })

          for (const [step, edit] of edits.entries()) {
            const label = `step ${step} (${edit.kind} on block ${edit.block})`
            const candidate = applyEdit(codebase, edit)
            const omit = new Set(edit.kind === "orphan" ? [edit.block] : [])
            const planned = plannedOf(candidate, omit, ledger)
            const verdict = judge(ledger, planned)

            if (verdict.refused) {
              // A refusal is typed, changes nothing, and is stable when asked again.
              for (let attempt = 0; attempt < 2; attempt++) {
                const before = bodyRuns
                const refusal = failureOf(
                  yield* Effect.exit(Database.Migrations.run(setsOf(planned, undefined, edit.reverseSets)))
                )
                must(refusal.kind === "fail", `${label}: a refused plan must fail in the typed channel`)
                must(
                  refusal.error instanceof Migrator.MigrationError && refusal.error.kind === "BadState",
                  `${label}: a refused plan must be a BadState MigrationError`
                )
                must(bodyRuns === before, `${label}: a refused plan must run no migration body`)
                yield* expectState(`${label} refused`)
              }
              continue
            }

            const fresh = verdict.fresh
            const target = fresh[edit.pick % Math.max(1, fresh.length)]
            if (edit.sabotage !== "none" && target !== undefined) {
              // One failing migration rolls back the whole pass, earlier bodies included.
              const sabotaged = failureOf(
                yield* Effect.exit(
                  Database.Migrations.run(setsOf(planned, { id: target.id, mode: edit.sabotage }, edit.reverseSets))
                )
              )
              if (edit.sabotage === "die") {
                must(sabotaged.kind === "die", `${label}: a dying migration must stay a defect`)
              } else {
                must(sabotaged.kind === "fail", `${label}: a failing migration must fail the pass`)
                must(
                  sabotaged.error instanceof Migrator.MigrationError && sabotaged.error.kind === "Failed",
                  `${label}: a failing migration must surface as a Failed MigrationError`
                )
              }
              yield* expectState(`${label} sabotaged`)
            }

            const applied = yield* Database.Migrations.run(setsOf(planned, undefined, edit.reverseSets))
            // Every new migration is reported once, in id order, whatever order the sets were declared in.
            expect(applied.map(([id, name]) => `${id}:${name}`), `${label}: applied`).toEqual(
              fresh.map((entry) => `${entry.id}:${entry.name}`)
            )
            for (const entry of fresh) ledger.set(entry.id, entry.name)
            codebase = candidate
            yield* expectState(`${label} applied`)

            const settled = bodyRuns
            for (let rerun = 0; rerun < edit.reruns; rerun++) {
              const again = yield* Database.Migrations.run(
                setsOf(plannedOf(codebase, new Set(), ledger), undefined, rerun % 2 === 0)
              )
              must(again.length === 0, `${label}: rerun ${rerun} must apply nothing`)
              must(bodyRuns === settled, `${label}: rerun ${rerun} must run no migration body`)
              yield* expectState(`${label} rerun ${rerun}`)
            }
          }

          // Ledger drift: a tampered ledger refuses a pass that would otherwise append, and stays as tampered.
          const declaredApplied = plannedOf(codebase, new Set(), ledger).filter((entry) => ledger.has(entry.id))
          const victim = declaredApplied[tamperPick % Math.max(1, declaredApplied.length)]
          if (tamper !== "none" && victim !== undefined) {
            const ledgerTable = sql(Database.Migrations.table)
            if (tamper === "negativeId") {
              yield* sql`INSERT INTO ${ledgerTable} (migration_id, name) VALUES (${-1}, ${"evil"})`
            } else if (tamper === "renameRow") {
              yield* sql`UPDATE ${ledgerTable} SET name = ${"tampered"} WHERE migration_id = ${victim.id}`
            } else {
              yield* sql`DELETE FROM ${ledgerTable} WHERE migration_id = ${victim.id}`
            }
            const tampered = yield* observe
            const block = Math.floor(victim.id / Database.Migrations.idBlock)
            const grown = applyEdit(codebase, {
              block: block === 0 ? 0 : block === 1 ? 1 : 2,
              kind: "append",
              startAtZero: false,
              pick: 0,
              sabotage: "none",
              reverseSets: false,
              reruns: 1
            })
            const exit = yield* Effect.exit(
              Database.Migrations.run(setsOf(plannedOf(grown, new Set(), ledger), undefined, false))
            )
            must(Exit.isFailure(exit), `tamper ${tamper}: a drifted ledger must refuse the pass`)
            if (tamper !== "deleteRow") {
              const refusal = failureOf(exit)
              must(
                refusal.kind === "fail" && refusal.error instanceof Migrator.MigrationError &&
                  refusal.error.kind === "BadState",
                `tamper ${tamper}: drift must be reported as BadState`
              )
            }
            expect(yield* observe, `tamper ${tamper}: nothing may change`).toEqual(tampered)
          }
          return true
        }).pipe(Effect.provide(TestDatabase.sqliteLayer), Effect.orDie),
      { seed: seed + 11, executions: Math.max(ioExecutions, 40) }
    )
  })

  // -------------------------------------------------------------------------
  // Parameter binding
  // -------------------------------------------------------------------------

  it("bound parameters and quoted identifiers carry adversarial payloads verbatim without touching schema or leaking rows", async () => {
    const corpus = [
      "'; DROP TABLE canary; --",
      "\"; DROP TABLE canary; --",
      "' OR '1'='1",
      "\" OR \"\"=\"",
      "1; DELETE FROM secrets",
      "') UNION SELECT token FROM secrets --",
      "\u0000",
      "a\u0000b",
      "'",
      "''",
      "\"",
      "\"\"",
      "`",
      "\\",
      "%",
      "_",
      "?",
      "?1",
      "$1",
      ":k",
      "@k",
      "--",
      "/*",
      "*/",
      ";",
      "\n",
      "\r\n",
      "\t",
      "‮",
      "é",
      "\u{1F600}",
      "￿",
      "﻿",
      "x'00'",
      "NULL",
      "\uD83D",
      "\uDE00",
      "tok-\u{1F512}-1"
    ] as const
    const Payload = Schema.Array(Schema.Union([Schema.Literals(corpus), Schema.String.check(Schema.isMaxLength(12))]))
      .check(Schema.isMinLength(1), Schema.isMaxLength(4))
    const Bytes = Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))).check(
      Schema.isMaxLength(24)
    )
    const arbitrary = Arbitrary.schema(
      Schema.Struct({
        rows: Schema.Array(
          Schema.Struct({
            key: Payload,
            value: Payload,
            blob: Bytes,
            via: Schema.Literals(["template", "insertHelper", "unsafeParams", "writer"])
          })
        ).check(Schema.isMinLength(1), Schema.isMaxLength(6)),
        probes: Schema.Array(Payload).check(Schema.isMaxLength(3)),
        replacement: Payload,
        table: Payload,
        column: Payload
      })
    )

    // SQLite stores text as UTF-8, which has no encoding for a lone surrogate: the driver stores U+FFFD.
    const stored = (text: string) =>
      text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�")
    const hex = (text: string) => Buffer.from(stored(text), "utf8").toString("hex").toUpperCase()
    const secrets = ["tok-\u{1F512}-1", "tok-\u{1F512}-2", "tok-\u{1F512}-3"]

    await runFuzz(
      arbitrary,
      (input) =>
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          const writer = yield* Database.DurableWriter.DurableWriter
          yield* sql`CREATE TABLE vault (id INTEGER PRIMARY KEY, k TEXT NOT NULL, v TEXT NOT NULL, b BLOB NOT NULL)`
          yield* sql`CREATE TABLE secrets (id INTEGER PRIMARY KEY, token TEXT NOT NULL)`
          yield* sql`CREATE TABLE canary (id INTEGER PRIMARY KEY)`
          yield* sql`INSERT INTO canary (id) VALUES (${1})`
          for (const token of secrets) yield* sql`INSERT INTO secrets (token) VALUES (${token})`

          const schemaOf = sql<{ type: string; name: string; sql: string | null }>`
            SELECT type, name, sql FROM sqlite_master ORDER BY type, name
          `
          const baseline = yield* schemaOf

          const model: Array<{ id: number; k: string; v: string; b: ReadonlyArray<number> }> = []
          for (const [index, row] of input.rows.entries()) {
            const k = row.key.join("")
            const v = row.value.join("")
            const b = Uint8Array.from(row.blob)
            if (row.via === "template") {
              yield* sql`INSERT INTO vault (k, v, b) VALUES (${k}, ${v}, ${b})`
            } else if (row.via === "insertHelper") {
              yield* sql`INSERT INTO vault ${sql.insert({ k, v, b })}`
            } else if (row.via === "unsafeParams") {
              yield* sql.unsafe("INSERT INTO vault (k, v, b) VALUES (?, ?, ?)", [k, v, b])
            } else {
              yield* writer.write(sql`INSERT INTO vault (k, v, b) VALUES (${k}, ${v}, ${b})`)
            }
            model.push({ id: index + 1, k: stored(k), v: stored(v), b: row.blob })
          }

          const expectVault = (label: string) =>
            Effect.gen(function*() {
              const rows = yield* sql<{
                id: number
                k: string
                v: string
                b: Uint8Array
                kHex: string
                vHex: string
                kType: string
                bType: string
                bLength: number
              }>`
                SELECT id, k, v, b, hex(CAST(k AS BLOB)) AS "kHex", hex(CAST(v AS BLOB)) AS "vHex",
                  typeof(k) AS "kType", typeof(b) AS "bType", length(b) AS "bLength"
                FROM vault ORDER BY id
              `
              expect(rows.map((row) => row.id), `${label}: ids`).toEqual(model.map((row) => row.id))
              for (const [index, row] of rows.entries()) {
                const expected = model[index]
                must(expected !== undefined, `${label}: unexpected row ${row.id}`)
                // The value read back, and the bytes SQLite holds, are exactly what was bound.
                must(row.k === expected.k && row.v === expected.v, `${label}: row ${row.id} text changed in transit`)
                must(row.kHex === hex(expected.k) && row.vHex === hex(expected.v), `${label}: row ${row.id} bytes`)
                must(row.kType === "text" && row.bType === "blob", `${label}: row ${row.id} storage class`)
                must(row.bLength === expected.b.length, `${label}: row ${row.id} blob length`)
                expect([...row.b], `${label}: row ${row.id} blob`).toEqual([...expected.b])
              }
            })
          yield* expectVault("after inserts")

          // A payload selects exactly the rows stored under it: no tautology, no comment, no stacked statement.
          const probes = [...input.rows.map((row) => row.key.join("")), ...input.probes.map((probe) => probe.join(""))]
          for (const probe of probes) {
            const expected = model.filter((row) => row.k === stored(probe)).map((row) => row.id)
            const viaTemplate = yield* sql<{ id: number }>`SELECT id FROM vault WHERE k = ${probe} ORDER BY id`
            const viaUnsafe = yield* sql.unsafe<{ id: number }>("SELECT id FROM vault WHERE k = ? ORDER BY id", [probe])
            const viaDialect = yield* Database.Dialect.query<{ id: number }>(
              sql,
              "SELECT id FROM vault WHERE k = ? ORDER BY id",
              [probe]
            )
            expect(viaTemplate.map((row) => row.id), "template probe").toEqual(expected)
            expect(viaUnsafe.map((row) => row.id), "unsafe probe").toEqual(expected)
            expect(viaDialect.map((row) => row.id), "dialect probe").toEqual(expected)
            const leaked = yield* sql<{ token: string }>`SELECT token FROM secrets WHERE token = ${probe}`
            expect(leaked.map((row) => row.token), "secrets probe").toEqual(
              secrets.filter((token) => token === stored(probe))
            )
          }
          const wanted = new Set(probes.map(stored))
          const viaIn = yield* sql<{ id: number }>`SELECT id FROM vault WHERE ${sql.in("k", probes)} ORDER BY id`
          expect(viaIn.map((row) => row.id), "IN probe").toEqual(
            model.filter((row) => wanted.has(row.k)).map((row) => row.id)
          )

          // Writes addressed by a payload change exactly the rows stored under it.
          const first = probes[0]
          must(first !== undefined, "at least one probe exists")
          const replacement = input.replacement.join("")
          const updated = yield* Database.DurableWriter.affectedRows(
            yield* sql`UPDATE vault SET v = ${replacement} WHERE k = ${first}`.raw
          )
          expect(updated, "update count").toBe(model.filter((row) => row.k === stored(first)).length)
          for (const row of model) {
            if (row.k === stored(first)) row.v = stored(replacement)
          }
          yield* expectVault("after update")
          const last = probes[probes.length - 1] ?? first
          const deleted = yield* Database.DurableWriter.affectedRows(
            yield* writer.write(sql`DELETE FROM vault WHERE k = ${last}`.raw)
          )
          const survivors = model.filter((row) => row.k !== stored(last))
          expect(deleted, "delete count").toBe(model.length - survivors.length)
          model.splice(0, model.length, ...survivors)
          yield* expectVault("after delete")

          // No payload altered the schema or reached another table.
          expect(yield* schemaOf, "schema after payloads").toEqual(baseline)
          expect((yield* sql<{ id: number }>`SELECT id FROM canary`).map((row) => row.id)).toEqual([1])
          expect((yield* sql<{ token: string }>`SELECT token FROM secrets ORDER BY id`).map((row) => row.token))
            .toEqual(secrets)

          // A quoted identifier is one name, whatever else it contains. SQL text ends at NUL and Effect SQL
          // reads a dot as a path separator, so a single name carries neither.
          const named = (prefix: string, payload: ReadonlyArray<string>) =>
            `${prefix}${stored(payload.join("")).replaceAll("\u0000", "").replaceAll(".", "")}`
          const table = named("x", input.table)
          const column = named("y", input.column)
          yield* sql`CREATE TABLE ${sql(table)} (${sql(column)} TEXT NOT NULL)`
          yield* sql`INSERT INTO ${sql(table)} (${sql(column)}) VALUES (${replacement})`
          const echoed = yield* sql<{ value: string }>`SELECT ${sql(column)} AS value FROM ${sql(table)}`
          expect(echoed.map((row) => row.value), "identifier round trip").toEqual([stored(replacement)])
          const withTable = yield* schemaOf
          expect(withTable.map((row) => row.name).sort(), "one new table, named exactly").toEqual(
            [...baseline.map((row) => row.name), table].sort()
          )
          const columns = yield* sql<{ name: string }>`SELECT name FROM pragma_table_info(${table})`
          expect(columns.map((row) => row.name), "one column, named exactly").toEqual([column])
          yield* sql`DROP TABLE ${sql(table)}`
          expect(yield* schemaOf, "schema after identifier round trip").toEqual(baseline)
          return true
        }).pipe(Effect.provide(TestDatabase.sqliteLayer), Effect.orDie),
      { seed: seed + 12, executions: ioExecutions }
    )
  })

  // -------------------------------------------------------------------------
  // Transactions
  // -------------------------------------------------------------------------

  const Via = Schema.Literals(["writer", "writer", "raw"])
  const End = Schema.Literals(["commit", "commit", "fail", "die", "constraint"])
  const Key = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 }))
  const Small = Schema.Int.check(Schema.isBetween({ minimum: -9, maximum: 9 }))
  const Put = Schema.Struct({ _tag: Schema.Literal("put"), key: Key, value: Small })
  const Del = Schema.Struct({ _tag: Schema.Literal("del"), key: Key })
  const Add = Schema.Struct({ _tag: Schema.Literal("add"), key: Key, delta: Small })
  const Hook = Schema.Struct({ _tag: Schema.Literal("hook") })
  const Leaf = Schema.Struct({
    ops: Schema.Array(Schema.Union([Put, Del, Add, Hook])).check(Schema.isMaxLength(3)),
    end: End
  })
  const Middle = Schema.Struct({
    ops: Schema.Array(
      Schema.Union([
        Put,
        Del,
        Add,
        Hook,
        Schema.Struct({ _tag: Schema.Literal("nested"), via: Via, caught: Schema.Boolean, body: Leaf })
      ])
    ).check(Schema.isMaxLength(4)),
    end: End
  })
  const Top = Schema.Struct({
    via: Via,
    ops: Schema.Array(
      Schema.Union([
        Put,
        Del,
        Add,
        Hook,
        Schema.Struct({ _tag: Schema.Literal("nested"), via: Via, caught: Schema.Boolean, body: Middle })
      ])
    ).check(Schema.isMaxLength(5)),
    end: End
  })

  type ViaKind = typeof Via.Type
  type EndKind = typeof End.Type
  interface Tx {
    readonly ops: ReadonlyArray<Op>
    readonly end: EndKind
  }
  type Op =
    | typeof Put.Type
    | typeof Del.Type
    | typeof Add.Type
    | typeof Hook.Type
    | { readonly _tag: "nested"; readonly via: ViaKind; readonly caught: boolean; readonly body: Tx }

  type Outcome = { readonly kind: "ok" } | { readonly kind: Exclude<EndKind, "commit">; readonly label: string }

  class Boom extends Schema.TaggedError<Boom>()("Boom", { label: Schema.String }) {}

  it("mixed commit, abort and defect transaction trees match a reference map model and survive reopening the file", async () => {
    const arbitrary = Arbitrary.schema(
      Schema.Struct({
        segments: Schema.Array(Schema.Array(Top).check(Schema.isMinLength(1), Schema.isMaxLength(4))).check(
          Schema.isMinLength(1),
          Schema.isMaxLength(3)
        )
      })
    )

    await runFuzz(
      arbitrary,
      ({ segments }) =>
        Effect.gen(function*() {
          const directory = mkdtempSync(join(tmpdir(), "db-tx-fuzz-"))
          const layer = Layer.provideMerge(
            Database.DurableWriter.layer(),
            NodeDatabase.layer({ filename: join(directory, "store.sqlite") })
          )

          // Reference model: the committed map, the committed write log, and the hooks that must have fired.
          const kv = new Map<number, number>()
          const log: Array<string> = []
          const expectedCommits: Array<string> = []
          const expectedUndos: Array<string> = []
          const commits: Array<string> = []
          const undos: Array<string> = []
          const violations: Array<string> = []

          /** Applies a transaction to the model. A failed scope restores its snapshot and runs its undos newest first. */
          const evaluate = (
            tx: Tx,
            label: string,
            managed: boolean
          ): { readonly outcome: Outcome; readonly commits: Array<string>; readonly undos: Array<string> } => {
            const snapshot = new Map(kv)
            const logLength = log.length
            const scope = { commits: [] as Array<string>, undos: [] as Array<string> }
            const abort = (outcome: Outcome) => {
              kv.clear()
              for (const [key, value] of snapshot) kv.set(key, value)
              log.length = logLength
              if (managed) expectedUndos.push(...[...scope.undos].reverse())
              return { outcome, commits: [], undos: [] }
            }
            for (const [index, op] of tx.ops.entries()) {
              const tag = `${label}#${index}`
              if (op._tag === "hook") {
                if (managed) {
                  scope.commits.push(tag)
                  scope.undos.push(tag)
                }
              } else if (op._tag === "nested") {
                const child = evaluate(op.body, `${label}.${index}`, managed && op.via === "writer")
                if (child.outcome.kind === "ok") {
                  scope.commits.push(...child.commits)
                  scope.undos.push(...child.undos)
                } else if (!op.caught) {
                  return abort(child.outcome)
                }
              } else {
                if (op._tag === "put") kv.set(op.key, op.value)
                else if (op._tag === "del") kv.delete(op.key)
                else kv.set(op.key, (kv.get(op.key) ?? 0) + op.delta)
                log.push(tag)
              }
            }
            return tx.end === "commit"
              ? { outcome: { kind: "ok" }, commits: scope.commits, undos: scope.undos }
              : abort({ kind: tx.end, label })
          }

          const execute = (
            sql: SqlClient.SqlClient,
            writer: Database.DurableWriter.Service,
            tx: Tx,
            label: string,
            via: ViaKind,
            managed: boolean,
            prelude?: Effect.Effect<unknown>
          ): Effect.Effect<void, unknown> => {
            const body = Effect.gen(function*() {
              if (prelude !== undefined) yield* prelude
              for (const [index, op] of tx.ops.entries()) {
                const tag = `${label}#${index}`
                if (op._tag === "hook") {
                  const onCommit = yield* Database.DurableWriter.afterCommit(Effect.sync(() => commits.push(tag)), sql)
                  const onRollback = yield* Database.DurableWriter.afterRollback(
                    Effect.sync(() => undos.push(tag)),
                    sql
                  )
                  // Only a transaction the writer owns end to end may carry process-local publication.
                  if (onCommit !== managed || onRollback !== managed) {
                    violations.push(`${tag}: hook registration ${onCommit}/${onRollback}, managed ${managed}`)
                  }
                  continue
                }
                if (op._tag === "nested") {
                  const child = execute(
                    sql,
                    writer,
                    op.body,
                    `${label}.${index}`,
                    op.via,
                    managed && op.via === "writer"
                  )
                  if (op.caught) yield* Effect.exit(child)
                  else yield* child
                  continue
                }
                if (op._tag === "put") {
                  yield* sql`INSERT INTO kv (k, v) VALUES (${op.key}, ${op.value})
                    ON CONFLICT (k) DO UPDATE SET v = excluded.v`
                } else if (op._tag === "del") {
                  yield* sql`DELETE FROM kv WHERE k = ${op.key}`
                } else {
                  const rows = yield* sql<{ v: number }>`SELECT v FROM kv WHERE k = ${op.key}`
                  const next = (rows[0]?.v ?? 0) + op.delta
                  yield* sql`INSERT INTO kv (k, v) VALUES (${op.key}, ${next})
                    ON CONFLICT (k) DO UPDATE SET v = excluded.v`
                }
                yield* sql`INSERT INTO log (tag) VALUES (${tag})`
              }
              if (tx.end === "fail") return yield* Effect.fail(new Boom({ label }))
              if (tx.end === "die") return yield* Effect.die(new Error(`die:${label}`))
              if (tx.end === "constraint") yield* sql`INSERT INTO kv (k, v) VALUES (${1000}, ${null})`
            })
            return via === "writer" ? writer.write(body) : sql.withTransaction(body)
          }

          const expectDatabase = (sql: SqlClient.SqlClient, label: string) =>
            Effect.gen(function*() {
              const rows = yield* sql<{ k: number; v: number }>`SELECT k, v FROM kv ORDER BY k`
              expect(rows.map((row) => [row.k, row.v]), `${label}: committed map`).toEqual(
                [...kv.entries()].sort(([left], [right]) => left - right)
              )
              const entries = yield* sql<{ seq: number; tag: string }>`SELECT seq, tag FROM log ORDER BY seq`
              // Committed writes are all there, in the order they were made; rolled-back ones left nothing.
              expect(entries.map((row) => row.tag), `${label}: committed log`).toEqual(log)
              must(
                entries.every((row, index) => index === 0 || row.seq > (entries[index - 1]?.seq ?? 0)),
                `${label}: log sequence must strictly increase`
              )
            })

          try {
            for (const [segmentIndex, segment] of segments.entries()) {
              yield* Effect.gen(function*() {
                const sql = yield* SqlClient.SqlClient
                const writer = yield* Database.DurableWriter.DurableWriter
                // The schema arrives through the ladder, which is also what lets the file be reopened.
                const migrated = yield* Database.Migrations.run([{
                  namespace: "txfuzz",
                  idOffset: 0,
                  migrations: {
                    "0001_schema": Effect.gen(function*() {
                      yield* sql`CREATE TABLE kv (k INTEGER PRIMARY KEY, v INTEGER NOT NULL)`
                      yield* sql`CREATE TABLE log (seq INTEGER PRIMARY KEY AUTOINCREMENT, tag TEXT NOT NULL)`
                    })
                  }
                }])
                must(migrated.length === (segmentIndex === 0 ? 1 : 0), "the schema migration runs once per file")
                // Reopening the file shows exactly the committed state of every earlier segment.
                yield* expectDatabase(sql, `segment ${segmentIndex} reopened`)

                for (const [txIndex, tx] of segment.entries()) {
                  const label = `s${segmentIndex}t${txIndex}`
                  const managed = tx.via === "writer"
                  const predicted = evaluate(tx, label, managed)
                  if (predicted.outcome.kind === "ok" && managed) expectedCommits.push(...predicted.commits)

                  let published = -1
                  // Publication registered first reads the log once the write has committed.
                  const publish = Database.DurableWriter.afterCommit(
                    sql<{ c: number }>`SELECT count(*) AS c FROM log`.pipe(
                      Effect.map((rows) => {
                        published = Number(rows[0]?.c ?? -1)
                      }),
                      Effect.orDie
                    ),
                    sql
                  )
                  const exit = yield* Effect.exit(execute(sql, writer, tx, label, tx.via, managed, publish))
                  const seen = failureOf(exit)
                  const want = predicted.outcome
                  if (want.kind === "ok") {
                    must(seen.kind === "ok", `${label}: a committing transaction must succeed`)
                    // Publication runs after COMMIT and reads the committed data.
                    if (managed) {
                      must(published === log.length, `${label}: afterCommit ran before the commit was visible`)
                    }
                  } else if (want.kind === "fail") {
                    must(
                      seen.kind === "fail" && seen.error instanceof Boom && seen.error.label === want.label,
                      `${label}: an aborted transaction must fail with its own typed error`
                    )
                  } else if (want.kind === "die") {
                    must(
                      seen.kind === "die" && seen.defect instanceof Error &&
                        seen.defect.message === `die:${want.label}`,
                      `${label}: a defect must stay a defect`
                    )
                  } else {
                    must(
                      seen.kind === "fail" && Database.DurableWriter.codeOf(seen.error) === "constraint",
                      `${label}: a constraint violation must be a typed constraint failure`
                    )
                    if (managed) {
                      must(
                        seen.kind === "fail" && seen.error instanceof Database.DurableWriter.DatabaseError,
                        `${label}: the writer must normalize the SQL error`
                      )
                    }
                  }
                  if (want.kind !== "ok" && managed) must(published === -1, `${label}: a rolled-back write published`)

                  yield* expectDatabase(sql, label)
                  expect(commits, `${label}: afterCommit publications`).toEqual(expectedCommits)
                  expect(undos, `${label}: afterRollback undos`).toEqual(expectedUndos)
                  expect(violations, `${label}: hook ownership`).toEqual([])
                }
              }).pipe(Effect.provide(layer))
            }
          } finally {
            rmSync(directory, { recursive: true, force: true })
          }
          return true
        }).pipe(Effect.orDie),
      { seed: seed + 13, executions: Math.min(ioExecutions, 24) }
    )
  })
})
