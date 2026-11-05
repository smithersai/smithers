import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { Migrations } from "@smthrs/database"
import * as Database from "@smthrs/database/node/NodeDatabase"
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, Layer, PlatformError, Ref } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, it } from "vitest"
import { publishFreshDatabaseLayer, syncStagedDatabase } from "../src/internal/DatabasePublication.ts"

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | import("effect/Scope").Scope>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)))

it("flushes an initialized SQLite file when read-only handles cannot synchronize, without truncating it", () =>
  run(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "database-publication-" })
    const filename = join(directory, "staged.db")
    const database = new DatabaseSync(filename)
    database.exec("CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('initialized')")
    database.close()
    let released = false
    const writableFlushRequired: FileSystem.FileSystem = {
      ...fs,
      open: (target, options) =>
        Effect.gen(function*() {
          const file = yield* fs.open(target, options)
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              released = true
            })
          )
          return {
            ...file,
            sync: (options?.flag ?? "r") === "r"
              ? Effect.fail(PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "sync",
                pathOrDescriptor: target
              }))
              : file.sync
          }
        })
    }
    yield* syncStagedDatabase(filename).pipe(Effect.provideService(FileSystem.FileSystem, writableFlushRequired))
    expect(released).toBe(true)
    const readBack = new DatabaseSync(filename, { readOnly: true })
    try {
      expect(readBack.prepare("SELECT value FROM sentinel").get()).toEqual({ value: "initialized" })
    } finally {
      readBack.close()
    }
  })))

it("propagates a flush refusal and releases the file instead of acknowledging durable publication", () =>
  run(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "database-publication-refused-" })
    const filename = join(directory, "staged.db")
    yield* fs.writeFileString(filename, "staged contents")
    const failure = PlatformError.systemError({ _tag: "Unknown", module: "FileSystem", method: "sync" })
    let released = false
    const unavailable: FileSystem.FileSystem = {
      ...fs,
      open: (target, options) =>
        Effect.gen(function*() {
          const file = yield* fs.open(target, options)
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              released = true
            })
          )
          return { ...file, sync: Effect.fail(failure) }
        })
    }
    const exit = yield* syncStagedDatabase(filename).pipe(
      Effect.provideService(FileSystem.FileSystem, unavailable),
      Effect.exit
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(failure)
    expect(released).toBe(true)
    expect(yield* fs.readFileString(filename)).toBe("staged contents")
  })))

it("preserves an open refusal without attempting a flush", () =>
  run(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const failure = PlatformError.systemError({ _tag: "NotFound", module: "FileSystem", method: "open" })
    const unavailable: FileSystem.FileSystem = { ...fs, open: () => Effect.fail(failure) }
    const exit = yield* syncStagedDatabase("missing").pipe(
      Effect.provideService(FileSystem.FileSystem, unavailable),
      Effect.exit
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(failure)
  })))

const initialized = (value: string) =>
  Layer.effectDiscard(Effect.gen(function*() {
    const sql = yield* SqlClient
    yield* Migrations.run([])
    yield* sql`CREATE TABLE IF NOT EXISTS publication (id INTEGER PRIMARY KEY, value TEXT)`
    yield* sql`INSERT OR IGNORE INTO publication (id, value) VALUES (1, ${value})`
  }))
const rows = Effect.gen(function*() {
  const sql = yield* SqlClient
  return yield* sql<{ value: string }>`SELECT value FROM publication`
})
const database = (filename: string) => Database.layer({ filename })
const publish = <A, E>(
  filename: string,
  initializer: Layer.Layer<A, E, SqlClient>,
  fs: FileSystem.FileSystem,
  platform: NodeJS.Platform = process.platform,
  producer = database
) =>
  rows.pipe(
    Effect.provide(
      publishFreshDatabaseLayer(filename, producer, initializer, platform).pipe(
        Layer.provide(Layer.succeed(FileSystem.FileSystem, fs))
      )
    ),
    Effect.scoped
  )

it("reopens an existing initialized store without replacing the winning contents", () =>
  run(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "publication-existing-" })
    const filename = join(directory, "state.sqlite")
    expect(yield* publish(filename, initialized("winner"), fs)).toEqual([{ value: "winner" }])
    expect(yield* publish(filename, initialized("replacement"), fs)).toEqual([{ value: "winner" }])
    expect((yield* fs.readDirectory(directory)).some((name) => name.includes("initializing-"))).toBe(false)
  })))

it("two completed initializers converge on the same exclusive publication without losing its data", () =>
  run(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "publication-race-" })
    const filename = join(directory, "state.sqlite")
    const arrived = yield* Ref.make(0)
    const ready = yield* Deferred.make<void>()
    const initializer = (value: string) =>
      Layer.effectDiscard(Effect.gen(function*() {
        yield* Effect.scoped(Layer.build(initialized(value)))
        if ((yield* Ref.updateAndGet(arrived, (n) => n + 1)) === 2) yield* Deferred.succeed(ready, undefined)
        yield* Deferred.await(ready)
      }))
    const results = yield* Effect.all([
      publish(filename, initializer("first"), fs),
      publish(filename, initializer("second"), fs)
    ], { concurrency: 2 })
    expect(results[0]).toEqual(results[1])
    expect(["first", "second"]).toContain(results[0][0]?.value)
    expect(yield* Ref.get(arrived)).toBe(4)
    expect((yield* fs.readDirectory(directory)).some((name) => name.includes("initializing-"))).toBe(false)
  })))

it("refuses an unverifiable collision instead of opening or overwriting the winner", () =>
  run(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "publication-unverified-" })
    const filename = join(directory, "state.sqlite")
    const opened: Array<string> = []
    const ready = yield* Deferred.make<void>()
    const proceed = yield* Deferred.make<void>()
    const initializer = Layer.effectDiscard(Effect.gen(function*() {
      yield* Effect.scoped(Layer.build(initialized("loser")))
      yield* Deferred.succeed(ready, undefined)
      yield* Deferred.await(proceed)
    }))
    const unverifiable: FileSystem.FileSystem = {
      ...fs,
      exists: (target) => target === filename ? Effect.succeed(false) : fs.exists(target)
    }
    const pending = yield* Effect.forkChild(
      Effect.exit(publish(filename, initializer, unverifiable, process.platform, (file) => {
        opened.push(file)
        return database(file)
      })),
      { startImmediately: true }
    )
    yield* Deferred.await(ready)
    expect(yield* publish(filename, initialized("winner"), fs)).toEqual([{ value: "winner" }])
    yield* Deferred.succeed(proceed, undefined)
    const outcome = yield* Fiber.join(pending)
    expect(Exit.isFailure(outcome)).toBe(true)
    if (Exit.isFailure(outcome)) {
      expect(Cause.squash(outcome.cause)).toMatchObject({ reason: { _tag: "AlreadyExists" } })
    }
    expect(opened).toHaveLength(1)
    expect(opened).not.toContain(filename)
    const winner = new DatabaseSync(filename, { readOnly: true })
    try {
      expect(winner.prepare("SELECT value FROM publication").get()).toEqual({ value: "winner" })
    } finally {
      winner.close()
    }
  })))

it("propagates a refused hard link and removes the private staging store", () =>
  run(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "publication-link-refused-" })
    const filename = join(directory, "state.sqlite")
    const failure = PlatformError.systemError({ _tag: "PermissionDenied", module: "FileSystem", method: "link" })
    const unavailable: FileSystem.FileSystem = { ...fs, link: () => Effect.fail(failure) }
    const outcome = yield* Effect.exit(publish(filename, initialized("unpublished"), unavailable))
    expect(Exit.isFailure(outcome)).toBe(true)
    if (Exit.isFailure(outcome)) expect(Cause.squash(outcome.cause)).toBe(failure)
    expect(yield* fs.exists(filename)).toBe(false)
    expect(yield* fs.readDirectory(directory)).toEqual([])
  })))

it("never publishes a file whose mandatory flush was refused", () =>
  run(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "publication-flush-refused-" })
    const filename = join(directory, "state.sqlite")
    const failure = PlatformError.systemError({ _tag: "Unknown", module: "FileSystem", method: "sync" })
    const unavailable: FileSystem.FileSystem = {
      ...fs,
      open: (target, options) =>
        fs.open(target, options).pipe(Effect.map((file) => ({ ...file, sync: Effect.fail(failure) })))
    }
    const outcome = yield* Effect.exit(publish(filename, initialized("unpublished"), unavailable))
    expect(Exit.isFailure(outcome)).toBe(true)
    if (Exit.isFailure(outcome)) expect(Cause.squash(outcome.cause)).toBe(failure)
    expect(yield* fs.exists(filename)).toBe(false)
    expect(yield* fs.readDirectory(directory)).toEqual([])
  })))

it("requires directory durability when the host policy declares it", () =>
  run(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "publication-directory-refused-" })
    const filename = join(directory, "state.sqlite")
    const failure = PlatformError.systemError({ _tag: "Unknown", module: "FileSystem", method: "sync" })
    const unavailable: FileSystem.FileSystem = {
      ...fs,
      // A faulty service supplies a live handle with a refused sync. Acquire a
      // file handle so this failure injection also runs where directories cannot open.
      open: (target, options) =>
        fs.open(target === directory ? filename : target, options).pipe(
          Effect.map((file) => target === directory ? { ...file, sync: Effect.fail(failure) } : file)
        )
    }
    const outcome = yield* Effect.exit(publish(filename, initialized("complete"), unavailable, "linux"))
    expect(Exit.isFailure(outcome)).toBe(true)
    if (Exit.isFailure(outcome)) expect(Cause.squash(outcome.cause)).toBe(failure)
    const stored = new DatabaseSync(filename, { readOnly: true })
    try {
      expect(stored.prepare("SELECT value FROM publication").get()).toEqual({ value: "complete" })
    } finally {
      stored.close()
    }
  })))

it("propagates a refused directory open after publishing complete file contents", () =>
  run(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "publication-directory-open-" })
    const filename = join(directory, "state.sqlite")
    const failure = PlatformError.systemError({ _tag: "PermissionDenied", module: "FileSystem", method: "open" })
    const unavailable: FileSystem.FileSystem = {
      ...fs,
      open: (target, options) => target === directory ? Effect.fail(failure) : fs.open(target, options)
    }
    const outcome = yield* Effect.exit(publish(filename, initialized("complete"), unavailable, "linux"))
    expect(Exit.isFailure(outcome)).toBe(true)
    if (Exit.isFailure(outcome)) expect(Cause.squash(outcome.cause)).toBe(failure)
    const stored = new DatabaseSync(filename, { readOnly: true })
    try {
      expect(stored.prepare("SELECT value FROM publication").get()).toEqual({ value: "complete" })
    } finally {
      stored.close()
    }
  })))

it("Windows policy still flushes the file when directory handles cannot synchronize", () =>
  run(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "publication-windows-" })
    const filename = join(directory, "state.sqlite")
    let flushed = false
    const windows: FileSystem.FileSystem = {
      ...fs,
      open: (target, options) =>
        Effect.gen(function*() {
          const info = yield* fs.stat(target)
          if (info.type === "Directory" || (options?.flag ?? "r") === "r") {
            return yield* Effect.fail(
              PlatformError.systemError({ _tag: "PermissionDenied", module: "FileSystem", method: "sync" })
            )
          }
          const file = yield* fs.open(target, options)
          return {
            ...file,
            sync: file.sync.pipe(Effect.tap(() =>
              Effect.sync(() => {
                flushed = true
              })
            ))
          }
        })
    }
    expect(yield* publish(filename, initialized("durable file"), windows, "win32")).toEqual([{ value: "durable file" }])
    expect(flushed).toBe(true)
  })))

it.each(["postgresql://database.invalid/store", "", ":memory:", "file:store?mode=memory"])(
  "delegates %j to its native adapter without filesystem publication",
  (filename) =>
    run(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const failure = new Error("adapter refused")
      const requested: Array<string> = []
      const noFilesystem: FileSystem.FileSystem = {
        ...fs,
        exists: () => Effect.die(new Error("unexpected filesystem publication"))
      }
      const outcome = yield* Effect.exit(
        publish(filename, initialized("unavailable"), noFilesystem, process.platform, (file) => {
          requested.push(file)
          return Layer.effect(SqlClient, Effect.die(failure))
        })
      )
      expect(Exit.isFailure(outcome)).toBe(true)
      if (Exit.isFailure(outcome)) expect(Cause.squash(outcome.cause)).toBe(failure)
      expect(requested).toEqual([filename])
    }))
)
