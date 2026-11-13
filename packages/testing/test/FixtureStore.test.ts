import { describe, expect, it } from "@effect/vitest"
import { NodeHost } from "@smthrs/platform-node"
import { Cause, Effect, Exit, FileSystem, Layer, Option, Path, PlatformError } from "effect"
import { spawn } from "node:child_process"
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { RecordedCall } from "../src/Fixture.ts"
import * as FixtureStore from "../src/FixtureStore.ts"

const host = Layer.mergeAll(NodeHost.NodeFileSystem.layer, NodeHost.NodePath.layer)
const fault = (description: string) =>
  PlatformError.systemError({ _tag: "Unknown", module: "FileSystem", method: "test", description })
const unsupported = PlatformError.badArgument({
  module: "FileSystem",
  method: "open",
  description: "noFollow unsupported"
})
const atRoot = (root: string, path: string) =>
  Effect.gen(function*() {
    const paths = yield* Path.Path
    return yield* FixtureStore.makeFile(path).pipe(Effect.provideService(Path.Path, {
      ...paths,
      resolve: (...parts) => resolve(root, ...parts)
    }))
  })

const call: RecordedCall = {
  model: "test:model",
  request: { modelId: "test:model", system: [], messages: [], tools: [], params: {} },
  events: [{ type: "settle", stopReason: "stop" }]
}

const withFile = <A, E>(use: (path: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "testing-file-store-"))),
    (directory) => use(join(directory, "fixture.json")),
    (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true }))
  ).pipe(Effect.provide(host))

describe("FixtureStore file persistence", () => {
  it.effect("refuses to append through a symlinked journal", () =>
    withFile((path) =>
      Effect.gen(function*() {
        const victim = `${path}.victim`
        // Empty, so reading it back through the link is a valid empty journal
        // and only the append itself can touch it.
        writeFileSync(victim, "")
        const store = yield* FixtureStore.makeFile(path)
        symlinkSync(victim, `${path}.journal`)
        const exit = yield* Effect.exit(store.append(call))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain(`${path}.journal`)
        expect(readFileSync(victim, "utf8")).toBe("")
      })
    ))

  it.effect("refuses to read or truncate through a symlinked journal", () =>
    withFile((path) =>
      Effect.gen(function*() {
        const victim = `${path}.victim`
        writeFileSync(victim, "partial record")
        symlinkSync(victim, `${path}.journal`)
        const exit = yield* Effect.exit(FixtureStore.makeFile(path))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain(`${path}.journal`)
        expect(readFileSync(victim, "utf8")).toBe("partial record")
      })
    ))

  it.effect("refuses a journal replaced between inspection and open, before reading its bytes", () =>
    withFile((path) =>
      Effect.gen(function*() {
        const journal = `${path}.journal`
        writeFileSync(journal, "")
        const fs = yield* FileSystem.FileSystem
        let replaced = false
        const faulty = {
          ...fs,
          open: (...args: Parameters<typeof fs.open>) =>
            Effect.gen(function*() {
              if (!replaced) {
                replaced = true
                renameSync(journal, `${journal}.old`)
                writeFileSync(journal, "partial record")
              }
              return yield* fs.open(...args)
            })
        }
        const exit = yield* Effect.exit(
          FixtureStore.makeFile(path).pipe(Effect.provideService(FileSystem.FileSystem, faulty))
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain("journal changed while opening")
        expect(readFileSync(journal, "utf8")).toBe("partial record")
      })
    ))

  for (const mismatch of ["kind", "device", "inode"] as const) {
    it.effect(`closes a journal handle with a mismatched ${mismatch} before IO`, () =>
      withFile((path) =>
        Effect.gen(function*() {
          const journal = `${path}.journal`
          writeFileSync(journal, "partial record")
          const fs = yield* FileSystem.FileSystem
          let closed = false
          const faulty = {
            ...fs,
            open: (...args: Parameters<typeof fs.open>) =>
              Effect.gen(function*() {
                const handle = yield* fs.open(...args)
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    closed = true
                  })
                )
                return Object.create(handle, {
                  stat: {
                    value: handle.stat.pipe(Effect.map((stat) => ({
                      ...stat,
                      ...(mismatch === "kind" ? { type: "Directory" as const } : {}),
                      ...(mismatch === "device" ? { dev: stat.dev + 1n } : {}),
                      ...(mismatch === "inode" ? { ino: Option.some(Option.getOrThrow(stat.ino) + 1n) } : {})
                    })))
                  }
                }) as FileSystem.File
              })
          }
          const exit = yield* Effect.exit(
            FixtureStore.makeFile(path).pipe(Effect.provideService(FileSystem.FileSystem, faulty))
          )
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain("journal changed while opening")
          expect(closed).toBe(true)
          expect(readFileSync(journal, "utf8")).toBe("partial record")
        })
      ))
  }

  it.effect("creates a journal exclusively when another writer installs a link during open", () =>
    withFile((path) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const journal = `${path}.journal`
        const victim = `${path}.victim`
        writeFileSync(victim, "untouched")
        let installed = false
        const faulty = {
          ...fs,
          open: (...args: Parameters<typeof fs.open>) =>
            Effect.gen(function*() {
              if (!installed) {
                installed = true
                symlinkSync(victim, journal)
              }
              return yield* fs.open(...args)
            })
        }
        const store = yield* FixtureStore.makeFile(path).pipe(Effect.provideService(FileSystem.FileSystem, faulty))
        const exit = yield* Effect.exit(store.append(call))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toMatchObject({ cause: { reason: { _tag: "AlreadyExists" } } })
        }
        expect(readFileSync(victim, "utf8")).toBe("untouched")
        expect(existsSync(`${path}.lock`)).toBe(false)
      })
    ))

  for (const mode of ["read", "append", "truncate"] as const) {
    it.effect(`uses the real no-follow open for a symlink installed during ${mode}`, () =>
      withFile((path) =>
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const journal = `${path}.journal`
          const victim = `${path}.victim`
          const original = mode === "truncate" ? "partial record" : ""
          writeFileSync(journal, original)
          writeFileSync(victim, "untouched")
          let swapped = false
          let rejected = false
          const faulty = {
            ...fs,
            open: (...args: Parameters<typeof fs.open>) =>
              Effect.gen(function*() {
                const flag = args[1]?.flag
                const target = mode === "read" ? flag === "r" : mode === "append" ? flag === "a" : flag === "r+"
                if (target && !swapped) {
                  swapped = true
                  renameSync(journal, `${journal}.old`)
                  symlinkSync(victim, journal)
                }
                return yield* fs.open(...args).pipe(Effect.tapError(() =>
                  Effect.sync(() => {
                    rejected = true
                  })
                ))
              })
          }
          const result = yield* Effect.exit(
            Effect.gen(function*() {
              const store = yield* FixtureStore.makeFile(path)
              if (mode === "append") yield* store.append(call)
            }).pipe(Effect.provideService(FileSystem.FileSystem, faulty))
          )
          expect(Exit.isFailure(result)).toBe(true)
          expect(swapped).toBe(true)
          // Windows reports BadArgument and uses the handle identity fallback.
          // POSIX must reject at open, before the fallback can inspect a handle.
          if (process.platform !== "win32") expect(rejected).toBe(true)
          expect(readFileSync(victim, "utf8")).toBe("untouched")
          expect(existsSync(`${path}.lock`)).toBe(false)
        })
      ))
  }

  it.effect("falls back only when the filesystem rejects noFollow as unsupported", () =>
    withFile((path) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const attempts: Array<boolean | undefined> = []
        const unsupportedFs: FileSystem.FileSystem = {
          ...fs,
          open: (file, options) =>
            Effect.suspend(() => {
              attempts.push(options?.noFollow)
              return options?.noFollow ? Effect.fail(unsupported) : fs.open(file, options)
            })
        }
        const store = yield* FixtureStore.makeFile(path).pipe(
          Effect.provideService(FileSystem.FileSystem, unsupportedFs)
        )
        yield* store.append(call)
        yield* store.flush()
        expect(JSON.parse(readFileSync(path, "utf8")).calls).toEqual([call])
        expect(attempts).toEqual([true, undefined, true, undefined])
      })
    ))

  it.effect("checks handle identity when noFollow is unsupported", () =>
    withFile((path) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const journal = `${path}.journal`
        const victim = `${path}.victim`
        writeFileSync(journal, "")
        writeFileSync(victim, "untouched")
        const faulty: FileSystem.FileSystem = {
          ...fs,
          open: (file, options) =>
            Effect.gen(function*() {
              if (options?.noFollow) return yield* Effect.fail(unsupported)
              renameSync(journal, `${journal}.old`)
              symlinkSync(victim, journal)
              return yield* fs.open(file, options)
            })
        }
        const result = yield* Effect.exit(
          FixtureStore.makeFile(path).pipe(Effect.provideService(FileSystem.FileSystem, faulty))
        )
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) {
          expect(String(Cause.squash(result.cause))).toContain("journal changed while opening")
        }
        expect(readFileSync(victim, "utf8")).toBe("untouched")
      })
    ))

  it.effect("propagates a supported noFollow open failure without retrying", () =>
    withFile((path) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        writeFileSync(`${path}.journal`, "")
        let attempts = 0
        const faulty: FileSystem.FileSystem = {
          ...fs,
          open: () =>
            Effect.suspend(() => {
              attempts++
              return Effect.fail(fault("open denied"))
            })
        }
        const result = yield* Effect.exit(
          FixtureStore.makeFile(path).pipe(Effect.provideService(FileSystem.FileSystem, faulty))
        )
        expect(Exit.isFailure(result)).toBe(true)
        expect(attempts).toBe(1)
        expect(existsSync(`${path}.lock`)).toBe(false)
      })
    ))

  it.effect("refuses to record through a symlinked directory on the fixture path", () =>
    withFile((path) =>
      Effect.gen(function*() {
        const root = join(path, "..", "repo")
        const victim = join(path, "..", "victim")
        mkdirSync(root)
        mkdirSync(victim)
        symlinkSync(victim, join(root, "fixtures"))
        const linked = join(root, "fixtures", "nested", "fixture.json")
        const exit = yield* Effect.exit(Effect.gen(function*() {
          const store = yield* atRoot(root, linked)
          yield* store.append(call)
          yield* store.flush()
        }))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain(join(root, "fixtures"))
        expect(readdirSync(victim)).toEqual([])
      })
    ))

  it.effect("records under real directories below the working directory", () =>
    withFile((path) =>
      Effect.gen(function*() {
        const root = join(path, "..", "repo")
        mkdirSync(root)
        const nested = join(root, "fixtures", "nested", "fixture.json")
        const store = yield* atRoot(root, nested)
        yield* store.append(call)
        yield* store.flush()
        expect(JSON.parse(readFileSync(nested, "utf8")).calls).toHaveLength(1)
      })
    ))

  it.effect("records a fixture directly in the working directory", () =>
    withFile((path) =>
      Effect.gen(function*() {
        const store = yield* atRoot(join(path, ".."), path)
        yield* store.append(call)
        yield* store.flush()
        expect(JSON.parse(readFileSync(path, "utf8")).calls).toHaveLength(1)
      })
    ))

  it.effect("reports a directory it cannot inspect as a defect naming the fixture", () =>
    withFile((path) =>
      Effect.gen(function*() {
        const root = join(path, "..", "repo")
        mkdirSync(join(root, "fixtures"), { recursive: true })
        const fs = yield* FileSystem.FileSystem
        const faulty = { ...fs, lstat: () => Effect.fail(fault("EACCES: permission denied")) }
        const fixture = join(root, "fixtures", "fixture.json")
        const exit = yield* Effect.exit(
          atRoot(root, fixture).pipe(Effect.provideService(FileSystem.FileSystem, faulty))
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain("EACCES")
        expect(existsSync(`${fixture}.lock`)).toBe(false)
      })
    ))

  it.effect("preserves the previous complete fixture while recording", () =>
    withFile((path) =>
      Effect.gen(function*() {
        const previous = JSON.stringify({ calls: [call] })
        writeFileSync(path, previous)
        const store = yield* FixtureStore.makeFile(path)
        yield* store.append(call)
        expect(readFileSync(path, "utf8")).toBe(previous)
        expect(Option.getOrThrow(yield* store.load()).calls).toHaveLength(2)
      })
    ))

  it.effect("rejects a competing store instead of silently clobbering calls", () =>
    withFile((path) =>
      Effect.gen(function*() {
        const first = yield* FixtureStore.makeFile(path)
        const second = yield* FixtureStore.makeFile(path)
        yield* first.append(call)
        const exit = yield* Effect.exit(second.append(call))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain(path)
      })
    ))

  it.effect("persists only one new call per append", () =>
    withFile((path) =>
      Effect.gen(function*() {
        const store = yield* FixtureStore.makeFile(path)
        yield* store.append(call)
        const first = readFileSync(`${path}.journal`, "utf8")
        for (let index = 0; index < 8; index++) yield* store.append(call)
        const journal = readFileSync(`${path}.journal`, "utf8")
        expect(journal.startsWith(first)).toBe(true)
        expect(journal.split("\n").filter(Boolean)).toHaveLength(9)
        expect(Buffer.byteLength(journal)).toBe(9 * Buffer.byteLength(first))
        expect(existsSync(path)).toBe(false)
      })
    ))

  for (const [name, contents] of [["JSON", "{\"calls\": ["], ["schema", "{\"calls\":[{\"model\":7}]}"]]) {
    it.effect(`names the file and retains the cause of invalid ${name}`, () =>
      withFile((path) =>
        Effect.gen(function*() {
          writeFileSync(path, contents!)
          const exit = yield* Effect.exit(FixtureStore.makeFile(path))
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            const defect = Cause.squash(exit.cause)
            expect(String(defect)).toContain(path)
            expect(defect).toHaveProperty("cause")
          }
        })
      ))
  }
})

describe("FixtureStore flush and recovery", () => {
  it.effect("leaves a replay-only fixture untouched at scope close", () =>
    withFile((path) =>
      Effect.gen(function*() {
        const previous = JSON.stringify({ calls: [call] })
        writeFileSync(path, previous)
        yield* Effect.gen(function*() {
          const store = yield* FixtureStore.FixtureStore
          expect(Option.getOrThrow(yield* store.load()).calls).toHaveLength(1)
        }).pipe(Effect.provide(FixtureStore.layerFile(path)))
        expect(readFileSync(path, "utf8")).toBe(previous)
        expect(readdirSync(join(path, ".."))).toEqual(["fixture.json"])
      })
    ))

  it.effect("atomically publishes JSON, removes its journal and permits another writer", () =>
    withFile((path) =>
      Effect.gen(function*() {
        const previous = JSON.stringify({ calls: [call] })
        writeFileSync(path, previous)
        const second = yield* FixtureStore.makeFile(path)
        const fs = yield* FileSystem.FileSystem
        const recording = yield* FixtureStore.makeFile(path).pipe(Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          rename: (staging, destination) =>
            Effect.gen(function*() {
              expect(existsSync(path)).toBe(true)
              expect(JSON.parse(readFileSync(staging, "utf8")).calls.length).toBeGreaterThan(1)
              yield* fs.rename(staging, destination)
            })
        }))
        // Windows refuses replacement while this reader is open. POSIX also
        // proves the old descriptor keeps observing the original inode.
        const handle = process.platform === "win32" ? undefined : openSync(path, "r")
        try {
          yield* recording.append(call)
          yield* recording.flush()
          if (handle !== undefined) expect(readFileSync(handle, "utf8")).toBe(previous)
        } finally {
          if (handle !== undefined) closeSync(handle)
        }
        expect(JSON.parse(readFileSync(path, "utf8")).calls).toHaveLength(2)
        expect(existsSync(`${path}.journal`)).toBe(false)
        expect(existsSync(`${path}.lock`)).toBe(false)
        yield* second.append(call)
        yield* second.flush()
        expect(JSON.parse(readFileSync(path, "utf8")).calls).toHaveLength(3)
        yield* recording.append(call)
        yield* recording.flush()
        expect(JSON.parse(readFileSync(path, "utf8")).calls).toHaveLength(4)
      })
    ))

  it.effect("flushes its layer even when the consumer fails", () =>
    withFile((path) =>
      Effect.gen(function*() {
        const exit = yield* Effect.exit(
          Effect.gen(function*() {
            const store = yield* FixtureStore.FixtureStore
            yield* store.append(call)
            return yield* Effect.fail("test failed")
          }).pipe(Effect.provide(FixtureStore.layerFile(path)))
        )
        expect(Exit.isFailure(exit)).toBe(true)
        expect(JSON.parse(readFileSync(path, "utf8")).calls).toHaveLength(1)
        expect(existsSync(`${path}.lock`)).toBe(false)
      })
    ))

  it.effect("does not create an empty fixture when flushing an unused store", () =>
    withFile((path) =>
      Effect.gen(function*() {
        const store = yield* FixtureStore.makeFile(path)
        yield* store.flush()
        expect(existsSync(path)).toBe(false)
        expect(existsSync(`${path}.lock`)).toBe(false)
      })
    ))

  it.effect("recovers completed calls and discards a partial UTF-8 final record", () =>
    withFile((path) =>
      Effect.gen(function*() {
        const line = `${JSON.stringify({ index: 0, call })}\n`
        writeFileSync(
          `${path}.journal`,
          Buffer.concat([Buffer.from(line + "{\"index\":1,\"text\":\""), Buffer.from([0xe2, 0x82])])
        )
        const store = yield* FixtureStore.makeFile(path)
        expect(readFileSync(`${path}.journal`, "utf8")).toBe(line)
        expect(Option.getOrThrow(yield* store.load()).calls).toHaveLength(1)
        yield* store.append(call)
        yield* store.flush()
        expect(JSON.parse(readFileSync(path, "utf8")).calls).toHaveLength(2)
      })
    ))

  it.effect("does not duplicate records when publication preceded journal cleanup", () =>
    withFile((path) =>
      Effect.gen(function*() {
        writeFileSync(path, JSON.stringify({ calls: [call] }))
        writeFileSync(`${path}.journal`, [0, 1].map((index) => JSON.stringify({ index, call })).join("\n") + "\n")
        const store = yield* FixtureStore.makeFile(path)
        expect(Option.getOrThrow(yield* store.load()).calls).toHaveLength(2)
        yield* store.flush()
        expect(JSON.parse(readFileSync(path, "utf8")).calls).toHaveLength(2)
      })
    ))

  it.effect("releases the lock after a failed append and repairs its partial record before retry", () =>
    withFile((path) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        let failed = false
        const store = yield* FixtureStore.makeFile(path).pipe(Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          open: (...args) =>
            fs.open(...args).pipe(Effect.map((handle) =>
              Object.assign(Object.create(handle) as FileSystem.File, {
                writeAll: (bytes: Uint8Array) =>
                  Effect.suspend(() => {
                    if (failed) return handle.writeAll(bytes)
                    failed = true
                    writeFileSync(`${path}.journal`, "{\"index\":")
                    return Effect.fail(fault("disk full"))
                  })
              })
            ))
        }))
        const exit = yield* Effect.exit(store.append(call))
        expect(Exit.isFailure(exit)).toBe(true)
        expect(existsSync(`${path}.lock`)).toBe(false)
        expect(Option.isNone(yield* store.load())).toBe(true)
        yield* store.append(call)
        yield* store.flush()
        expect(JSON.parse(readFileSync(path, "utf8")).calls).toHaveLength(1)
      })
    ))

  it.effect("refuses a call whose JSON would not reload, keeping the fixture readable", () =>
    withFile((path) =>
      Effect.gen(function*() {
        const store = yield* FixtureStore.makeFile(path)
        // JSON writes NaN as null, which the fixture schema rejects on reload.
        const unencodable: RecordedCall = {
          ...call,
          events: [{ type: "usage", costUsd: Number.NaN }, { type: "settle", stopReason: "stop" }]
        }
        const exit = yield* Effect.exit(store.append(unencodable))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain("costUsd")
        expect(existsSync(`${path}.lock`)).toBe(false)
        yield* store.append(call)
        yield* store.flush()
        const reopened = yield* FixtureStore.makeFile(path)
        expect(Option.getOrThrow(yield* reopened.load()).calls).toEqual([call])
      })
    ))

  it.effect("preserves JSON and the recoverable journal when publication fails", () =>
    withFile((path) =>
      Effect.gen(function*() {
        const previous = JSON.stringify({ calls: [call] })
        writeFileSync(path, previous)
        const fs = yield* FileSystem.FileSystem
        const store = yield* FixtureStore.makeFile(path).pipe(Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          rename: () => Effect.fail(fault("rename denied"))
        }))
        yield* store.append(call)
        const exit = yield* Effect.exit(store.flush())
        expect(Exit.isFailure(exit)).toBe(true)
        expect(readFileSync(path, "utf8")).toBe(previous)
        expect(existsSync(`${path}.lock`)).toBe(false)
        const recovered = yield* FixtureStore.makeFile(path)
        expect(Option.getOrThrow(yield* recovered.load()).calls).toHaveLength(2)
        yield* recovered.flush()
        expect(JSON.parse(readFileSync(path, "utf8")).calls).toHaveLength(2)
      })
    ))

  for (
    const contents of [
      "null",
      "{\"index\":-1}",
      "{\"index\":0.5}",
      "{\"index\":1}",
      "{\"index\":0,\"call\":{}}",
      `${JSON.stringify({ index: 0, call })}\n${JSON.stringify({ index: 0, call })}`,
      "{broken"
    ]
  ) {
    it.effect(`rejects a corrupt complete journal record: ${contents}`, () =>
      withFile((path) =>
        Effect.gen(function*() {
          writeFileSync(`${path}.journal`, contents + "\n")
          const exit = yield* Effect.exit(FixtureStore.makeFile(path))
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain(`${path}.journal`)
          expect(existsSync(`${path}.lock`)).toBe(false)
        })
      ))
  }

  it.effect("names filesystem read failures and releases its lock", () =>
    withFile((path) =>
      Effect.gen(function*() {
        mkdirSync(path)
        const exit = yield* Effect.exit(FixtureStore.makeFile(path))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain(path)
        expect(existsSync(`${path}.lock`)).toBe(false)
      })
    ))

  it.effect("keeps the old JSON after SIGKILL during a staged write and recovers the call", () =>
    withFile((path) =>
      Effect.gen(function*() {
        const previous = JSON.stringify({ calls: [call] })
        writeFileSync(path, previous)
        // Kill a real writer after its injected service persists half a staged
        // document. No global filesystem functions are replaced.
        const script = `
        const { NodeHost } = await import(${JSON.stringify(import.meta.resolve("@smthrs/platform-node"))});
        const { Effect, FileSystem, Layer } = await import(${JSON.stringify(import.meta.resolve("effect"))});
        const { makeFile } = await import(${JSON.stringify(new URL("../src/FixtureStore.ts", import.meta.url).href)});
        await Effect.runPromise(Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem;
          const store = yield* makeFile(${JSON.stringify(path)}).pipe(Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            writeFileString: (path, data, options) => Effect.gen(function*() {
              yield* fs.writeFileString(path, data.slice(0, data.length / 2), options);
              process.send("staged");
              yield* Effect.never;
            })
          }));
          yield* store.append(${JSON.stringify(call)});
          yield* store.flush();
        }).pipe(Effect.provide(Layer.mergeAll(NodeHost.NodeFileSystem.layer, NodeHost.NodePath.layer))));
      `
        const result = yield* Effect.promise(() =>
          new Promise<{ code: number | null; signal: string | null; stderr: string; staged: boolean }>(
            (resolve, reject) => {
              const child = spawn(
                process.execPath,
                ["--import", import.meta.resolve("vibelang/register"), "--input-type=module", "-e", script],
                {
                  stdio: ["ignore", "ignore", "pipe", "ipc"],
                  timeout: 20_000
                }
              )
              let stderr = ""
              let staged = false
              child.on("message", (message) => {
                if (message !== "staged") return
                staged = true
                // The parent observes its own kill on Windows too; a child
                // killing itself only reports a generic exit code there.
                child.kill("SIGKILL")
              })
              child.stderr!.on("data", (data) => {
                stderr += data
              })
              child.on("error", reject)
              child.on("close", (code, signal) => resolve({ code, signal, stderr, staged }))
            }
          )
        )
        expect(result, result.stderr).toMatchObject({ code: null, signal: "SIGKILL", staged: true })
        expect(readFileSync(path, "utf8")).toBe(previous)
        expect(existsSync(`${path}.lock`)).toBe(true)
        rmSync(`${path}.lock`, { recursive: true })
        const store = yield* FixtureStore.makeFile(path)
        expect(Option.getOrThrow(yield* store.load()).calls).toHaveLength(2)
        yield* store.flush()
        expect(JSON.parse(readFileSync(path, "utf8")).calls).toHaveLength(2)
      })
    ))
})
