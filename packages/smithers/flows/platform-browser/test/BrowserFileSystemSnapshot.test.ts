import { expect, it } from "@effect/vitest"
import { Effect, Exit, Option } from "effect"
import * as Fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileInfo } from "../src/BrowserFileSystem/fileInfo.ts"
import * as BrowserFileSystem from "../src/BrowserFileSystem/index.ts"

const stats = {
  size: 0,
  mode: 0o100600,
  mtimeMs: 0,
  isFile: () => true,
  isDirectory: () => false,
  isSymbolicLink: () => false
}

it.effect("rejects finite timestamps outside the Date range", () =>
  Effect.gen(function*() {
    for (const mtimeMs of [8.64e15 + 1, -8.64e15 - 1, Number.MAX_VALUE]) {
      expect(Option.isNone((yield* fileInfo({ ...stats, mtimeMs }, "/file")).mtime)).toBe(true)
    }
    for (const mtimeMs of [8.64e15, -8.64e15, 0]) {
      expect(Option.getOrThrow((yield* fileInfo({ ...stats, mtimeMs }, "/file")).mtime).getTime()).toBe(mtimeMs)
    }
  }))

it.effect("refuses invalid filesystem modes", () =>
  Effect.gen(function*() {
    for (const mode of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const result = yield* Effect.exit(fileInfo({ ...stats, mode }, "/file"))
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        const error = yield* Effect.flip(fileInfo({ ...stats, mode }, "/file"))
        expect(error.reason).toMatchObject({ _tag: "BadResource", method: "stat" })
      }
    }
  }))

it.effect("snapshots removal options before execution", () =>
  Effect.gen(function*() {
    const root = yield* Effect.promise(() => Fs.mkdtemp(join(tmpdir(), "remove-snapshot-")))
    yield* Effect.ensuring(
      Effect.gen(function*() {
        const fs = BrowserFileSystem.make(Fs)
        yield* fs.writeFileString(join(root, "leaf"), "keep")
        const options = { recursive: false, force: false }
        const remove = fs.remove(root, options)
        options.recursive = true
        options.force = true
        expect(Exit.isFailure(yield* Effect.exit(remove))).toBe(true)
        expect(yield* fs.readFileString(join(root, "leaf"))).toBe("keep")
      }),
      Effect.promise(() => Fs.rm(root, { recursive: true, force: true }))
    )
  }))

it.effect("snapshots directory recursive and mode options", () =>
  Effect.gen(function*() {
    const root = yield* Effect.promise(() => Fs.mkdtemp(join(tmpdir(), "mkdir-snapshot-")))
    yield* Effect.ensuring(
      Effect.gen(function*() {
        const fs = BrowserFileSystem.make(Fs)
        const options = { recursive: false, mode: 0o700 }
        const absent = fs.makeDirectory(join(root, "missing", "child"), options)
        const create = fs.makeDirectory(join(root, "private"), options)
        options.recursive = true
        options.mode = 0o777
        expect(Exit.isFailure(yield* Effect.exit(absent))).toBe(true)
        yield* create
        yield* Effect.promise(() => Fs.mkdir(join(root, "control"), { mode: 0o700 }))
        expect((yield* fs.stat(join(root, "private"))).mode).toBe((yield* fs.stat(join(root, "control"))).mode)
      }),
      Effect.promise(() => Fs.rm(root, { recursive: true, force: true }))
    )
  }))

it.effect("retains optional backend methods and their receiver", () =>
  Effect.gen(function*() {
    const root = yield* Effect.promise(() => Fs.mkdtemp(join(tmpdir(), "method-snapshot-")))
    yield* Effect.ensuring(
      Effect.gen(function*() {
        const backend: {
          -readonly [K in keyof BrowserFileSystem.ZenFsPromisesLike]: BrowserFileSystem.ZenFsPromisesLike[K]
        } = { ...Fs }
        const fs = BrowserFileSystem.make(backend)
        const from = join(root, "from")
        const to = join(root, "to")
        yield* fs.writeFileString(from, "saved")
        const rename = fs.rename(from, to)
        const utimes = fs.utimes(to, 10, 20)
        delete backend.rename
        delete backend.utimes
        yield* rename
        yield* utimes
        expect(yield* fs.readFileString(to)).toBe("saved")
        expect(Option.getOrThrow((yield* fs.stat(to)).mtime).getTime()).toBe(20000)
      }),
      Effect.promise(() => Fs.rm(root, { recursive: true, force: true }))
    )
  }))
