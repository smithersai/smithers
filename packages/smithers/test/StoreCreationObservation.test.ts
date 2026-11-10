/** Fresh native stores are published only after every schema initializer closes. */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, it } from "vitest"

const root = fileURLToPath(new URL("../../../", import.meta.url))
const directories: Array<string> = []
const children: Array<ChildProcessWithoutNullStreams> = []
afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
      child.kill("SIGKILL")
      await closed
    })
  )
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const source = `
import { Cause, Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import * as Database from "@smthrs/database/node/NodeDatabase"
import { NodeCrypto, NodeFileSystem, NodePath } from "@effect/platform-node"
import * as Control from "./packages/smithers/src/internal/NativeControlDatabase.vibe"
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as EngineMigrations from "@smthrs/engine-store/Migrations"
import * as ControlMigrations from "./packages/smithers/src/internal/ControlDatabaseMigrations.vibe"
import * as Runtime from "@smthrs/flows/Runtime"
import * as NodeRuntime from "./packages/smithers/flows/platform-node/src/NodeRuntime.ts"
import { existsSync } from "node:fs"
import { createInterface } from "node:readline"
const [mode, file, creator = "creator"] = process.argv.slice(1)
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]()
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n")
const pause = (stage) => Effect.promise(async () => { send({ stage }); await lines.next() })
const observe = async () => {
  if (!existsSync(file)) return { state: "absent" }
  return Effect.runPromise(Effect.gen(function*() {
    const sql = yield* SqlClient
    const tables = (yield* sql\`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\`).map(r => r.name)
    const ledger = tables.includes("flows_migrations") ? yield* sql\`SELECT migration_id FROM flows_migrations ORDER BY migration_id\` : []
    const runs = tables.includes("flows_runs") ? yield* sql\`SELECT run_id FROM flows_runs ORDER BY run_id\` : []
    return { state: ledger.length === 0 ? "initializing" : "ready", tables, ledger, runs }
  }).pipe(Effect.provide(Database.layer({ filename: file, readOnly: true }))))
}
if (mode === "legacy-ledger") {
  await Effect.runPromise(DatabaseMigrations.run([]).pipe(Effect.provide(Database.layer({ filename: file }))))
  send({ stage: "done" })
  process.exit(0)
} else if (mode === "reader") {
  for await (const _ of { [Symbol.asyncIterator]: () => lines }) send(await observe())
} else if (mode === "observe") {
  const exit = await Effect.runPromise(Effect.exit(Effect.scoped(Layer.build(Control.observe(
    filename => Database.layer({ filename, readOnly: true })
  )(file)))))
  send(exit._tag === "Success" ? { state: "ready" } : { state: "failed", code: Cause.squash(exit.cause).code, errors: Cause.pretty(exit.cause) })
  process.exit(0)
} else {
  const database = (filename) => Database.layer({ filename }).pipe(Layer.tap(() => pause(filename === file ? "public-open" : "private-open")))
  const engine = mode.includes("engine")
  const staged = mode.startsWith("staged") || mode === "fault"
  class PublicationCheck extends Context.Service()("test/PublicationCheck") {}
  const initialize = Layer.effectDiscard(Effect.gen(function*() {
    const sql = yield* SqlClient
    const tables = yield* sql\`SELECT name FROM sqlite_master WHERE type='table' AND name='flows_runs'\`
    if (tables.length > 0) return
    yield* DatabaseMigrations.run([])
    yield* pause("ledger")
    yield* Layer.build(engine ? EngineMigrations.layer : ControlMigrations.layer)
    yield* pause("migrated")
    if (engine) yield* Layer.build(Runtime.storage)
    yield* pause("stores")
    yield* (yield* PublicationCheck).check
  })).pipe(Layer.provide(Layer.succeed(PublicationCheck, {
    check: mode === "fault" ? Effect.fail(new Error("injected initialization failure")) : Effect.void
  })))
  const store = staged ? NodeRuntime.publishFreshDatabase(file, database, initialize)
    : mode === "recover-engine" ? NodeRuntime.storage(file)
    : mode === "recover-control" ? Control.make(filename => Database.layer({ filename }))(file)
    : Control.make(database)(file)
  const exit = await Effect.runPromise(Effect.exit(Effect.scoped(Effect.gen(function*() {
    const context = yield* Layer.build(store)
    if (staged) {
      const sql = Context.get(context, SqlClient)
      yield* sql\`INSERT INTO flows_runs(run_id,status,created_at_ms,state_json) VALUES(\${creator},'suspended',0,'{}')\`
    }
  })).pipe(Effect.provide(Layer.mergeAll(NodeCrypto.layer, NodeFileSystem.layer, NodePath.layer)))))
  send(exit._tag === "Success" ? { stage: "done" } : { stage: "failed", errors: Cause.pretty(exit.cause) })
  process.exit(0)
}
`

interface Message {
  readonly code?: string
  readonly state?: string
  readonly stage?: string
  readonly tables?: ReadonlyArray<string>
  readonly ledger?: ReadonlyArray<{ readonly migration_id: number }>
  readonly runs?: ReadonlyArray<{ readonly run_id: string }>
  readonly errors?: string
}

const peer = (mode: string, file: string, creator?: string) => {
  const child = spawn(process.execPath, [
    "--no-warnings",
    "--input-type=module",
    "-e",
    source,
    mode,
    file,
    ...(creator ? [creator] : [])
  ], {
    cwd: root,
    env: { ...process.env, SMITHERS_BACKEND: "sqlite" },
    stdio: ["pipe", "pipe", "pipe"]
  })
  children.push(child)
  let stderr = ""
  let buffer = ""
  const queue: Array<Message> = []
  let receive: { resolve: (value: Message) => void; reject: (error: Error) => void } | undefined
  let failure: Error | undefined
  child.stderr.on("data", (chunk) => {
    stderr += chunk
  })
  child.stdout.on("data", (chunk) => {
    buffer += chunk
    for (;;) {
      const end = buffer.indexOf("\n")
      if (end < 0) break
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      if (!line.startsWith("{")) continue
      const value = JSON.parse(line)
      if (receive) {
        const pending = receive
        receive = undefined
        pending.resolve(value)
      } else queue.push(value)
    }
  })
  child.once("error", (error) => {
    failure = error
    receive?.reject(error)
  })
  child.once("close", (code, signal) => {
    failure = new Error(`child closed (${code}, ${signal}): ${stderr}`)
    receive?.reject(failure)
  })
  const next = () =>
    queue.length > 0 ? Promise.resolve(queue.shift()!) : failure ?
      Promise.reject(failure) :
      new Promise<Message>((resolve, reject) => {
        receive = { resolve, reject }
      })
  return {
    child,
    next,
    advance: () => {
      child.stdin.write("next\n")
    },
    read: () => {
      child.stdin.write("read\n")
      return next()
    }
  }
}

it("a second process sees no control store while its adapter is being initialized (#4391)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smithers-creation-"))
  directories.push(directory)
  const file = join(directory, "control.db")
  const reader = peer("reader", file)
  expect(await reader.read()).toEqual({ state: "absent" })
  const writer = peer("control", file)
  const opening = await writer.next()
  expect(await reader.read()).toEqual({ state: "absent" })
  expect(opening).toEqual({ stage: "private-open" })
  writer.advance()
  expect(await writer.next()).toEqual({ stage: "public-open" })
  const published = await reader.read()
  expect(published.state).toBe("ready")
  expect(published.tables).toContain("control_plans")
  expect(published.tables).toContain("flows_journal_generations")
  writer.advance()
  expect(await writer.next()).toEqual({ stage: "done" })
})

const project = async () => {
  const directory = await mkdtemp(join(tmpdir(), "smithers-creation-"))
  directories.push(directory)
  return directory
}

const stop = async (writer: ReturnType<typeof peer>) => {
  const closed = new Promise<void>((resolve) => writer.child.once("close", () => resolve()))
  writer.child.kill("SIGKILL")
  await closed
}

const advanceTo = async (writer: ReturnType<typeof peer>, stage: string) => {
  for (;;) {
    const result = await writer.next()
    if (result.stage === stage) return
    expect(["private-open", "ledger", "migrated", "stores"]).toContain(result.stage)
    writer.advance()
  }
}

for (const kind of ["control", "engine"] as const) {
  it(`publishes every ${kind} creation stage together, including store-owned DDL`, async () => {
    const file = join(await project(), `${kind}.db`)
    const reader = peer("reader", file)
    const writer = peer(`staged-${kind}`, file)
    for (const stage of ["private-open", "ledger", "migrated", "stores"]) {
      expect(await writer.next()).toEqual({ stage })
      expect(await reader.read()).toEqual({ state: "absent" })
      writer.advance()
    }
    expect(await writer.next()).toEqual({ stage: "public-open" })
    const published = await reader.read()
    expect(published.state).toBe("ready")
    expect(published.tables).toContain("flows_journal_generations")
    expect(published.tables).toContain(kind === "control" ? "control_plans" : "flows_deferred_completions")
    writer.advance()
    expect(await writer.next()).toEqual({ stage: "done" })
    const recovered = peer(`recover-${kind}`, file)
    expect(await recovered.next()).toEqual({ stage: "done" })
    const after = await reader.read()
    expect(after.tables).toEqual(published.tables)
    expect(after.ledger).toEqual(published.ledger)
    expect(after.runs).toEqual([{ run_id: "creator" }])
  })

  for (const stage of ["private-open", "ledger", "migrated", "stores", "public-open"]) {
    it(`recovers ${kind} after the creator dies at ${stage}`, async () => {
      const file = join(await project(), `${kind}.db`)
      const reader = peer("reader", file)
      const writer = peer(`staged-${kind}`, file)
      await advanceTo(writer, stage)
      await stop(writer)
      expect((await reader.read()).state).toBe(stage === "public-open" ? "ready" : "absent")
      const recovered = peer(`recover-${kind}`, file)
      expect(await recovered.next()).toEqual({ stage: "done" })
      const result = await reader.read()
      expect(result.state).toBe("ready")
      expect(result.tables).toContain("flows_journal_generations")
      expect(result.runs).toEqual([])
    })
  }

  it(`concurrent ${kind} creators reopen the winner without replacing its writes`, async () => {
    const file = join(await project(), `${kind}.db`)
    const reader = peer("reader", file)
    const first = peer(`staged-${kind}`, file, "first")
    const second = peer(`staged-${kind}`, file, "second")
    await Promise.all([advanceTo(first, "stores"), advanceTo(second, "stores")])
    expect(await reader.read()).toEqual({ state: "absent" })
    first.advance()
    expect(await first.next()).toEqual({ stage: "public-open" })
    first.advance()
    expect(await first.next()).toEqual({ stage: "done" })
    second.advance()
    expect(await second.next()).toEqual({ stage: "public-open" })
    second.advance()
    expect(await second.next()).toEqual({ stage: "done" })
    expect((await reader.read()).runs).toEqual([{ run_id: "first" }, { run_id: "second" }])
  })
}

it("a faulty initialization service publishes nothing and removes its private files", async () => {
  const directory = await project()
  const file = join(directory, "control.db")
  const reader = peer("reader", file)
  const writer = peer("fault", file)
  await advanceTo(writer, "stores")
  writer.advance()
  const failure = await writer.next()
  expect(failure.stage).toBe("failed")
  expect(failure.errors).toContain("injected initialization failure")
  expect(await reader.read()).toEqual({ state: "absent" })
  expect(await readdir(directory)).toEqual([])
  const recovered = peer("recover-control", file)
  expect(await recovered.next()).toEqual({ stage: "done" })
})

it.each(["empty file", "empty ledger"])(
  "an %s left by an older creator is initializing rather than an older schema",
  async (stage) => {
    const file = join(await project(), "control.db")
    await writeFile(file, "")
    if (stage === "empty ledger") expect(await peer("legacy-ledger", file).next()).toEqual({ stage: "done" })
    const observer = peer("observe", file)
    const result = await observer.next()
    expect(result.state).toBe("failed")
    expect(result.code).toBe("store_initializing")
    expect(result.errors).not.toContain("store_schema_older")
    const recovered = peer("recover-control", file)
    expect(await recovered.next()).toEqual({ stage: "done" })
    expect(await peer("observe", file).next()).toEqual({ state: "ready" })
  }
)

it("a dangling destination symlink never publishes or creates a partial target", async () => {
  const directory = await project()
  const file = join(directory, "control.db")
  await symlink("missing.db", file)
  const writer = peer("staged-control", file)
  await advanceTo(writer, "stores")
  writer.advance()
  const result = await writer.next()
  expect(result.stage).toBe("failed")
  expect(result.errors).toContain("AlreadyExists")
  expect(await readdir(directory)).toEqual(["control.db"])
})

it("the real CLI identifies an interrupted fresh store without an older-schema diagnosis", async () => {
  const directory = await project()
  await mkdir(join(directory, ".flows"))
  await writeFile(join(directory, ".flows", "control.db"), "")
  const child = spawn(process.execPath, [
    "--no-warnings",
    "--import",
    join(root, "packages/smithers/test/fixtures/scripted-native-host.ts"),
    join(root, "packages/smithers/src/bin.ts"),
    "runs",
    "list",
    "--root",
    directory,
    "--json"
  ], {
    cwd: root,
    env: { ...process.env, SMITHERS_REMOTE: "", SMITHERS_BACKEND: "sqlite" },
    stdio: ["pipe", "pipe", "pipe"]
  })
  children.push(child)
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => {
    stdout += chunk
  })
  child.stderr.on("data", (chunk) => {
    stderr += chunk
  })
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", resolve)
  })
  expect(code, stdout + stderr).toBe(1)
  expect(JSON.parse(stdout)).toMatchObject({ code: "store_initializing" })
  expect(stdout + stderr).not.toContain("store_schema_older")
  expect(await readdir(join(directory, ".flows"))).toEqual(["control.db"])
})
