/**
 * `makeMemoryFs` is the Map-backed ZenFS double the deterministic Host bundle
 * mounts. It is exercised *through* `@smthrs/platform-browser`'s
 * `BrowserFileSystem` — the very adapter the browser runs — so a divergence
 * between the double and the real seam shows up here rather than in a test that
 * only ever talks to the double.
 *
 * The adapter's own behaviour (error mapping, stream bounds, file types) is
 * covered in `@smthrs/platform-browser`, not here.
 */
import { describe, expect, it } from "@effect/vitest"
import * as BrowserFileSystem from "@smthrs/platform-browser/BrowserFileSystem"
import { Effect, Option, Stream } from "effect"
import { makeMemoryFs } from "../../src/TestHost.ts"

const decoder = new TextDecoder()
const encoder = new TextEncoder()

describe("TestHost memory filesystem operations", () => {
  const fileSystem = () => BrowserFileSystem.make(makeMemoryFs({ "/w/a.txt": "alpha", "/w/sub/b.txt": "beta" }))

  it.effect("round-trips a written file and reports it as existing", () =>
    Effect.gen(function*() {
      const fs = fileSystem()

      const contents = yield* (
        Effect.gen(function*() {
          yield* fs.writeFile("/w/c.txt", encoder.encode("gamma"))
          const bytes = yield* fs.readFile("/w/c.txt")
          const exists = yield* fs.exists("/w/c.txt")
          const missing = yield* fs.exists("/w/nope.txt")
          return { text: decoder.decode(bytes), exists, missing }
        })
      )

      expect(contents).toEqual({ text: "gamma", exists: true, missing: false })
    }))

  it.effect("creates exclusively and refuses existing normalized paths", () =>
    Effect.gen(function*() {
      const fs = fileSystem()
      yield* fs.writeFile("/w/exclusive.txt", encoder.encode("owned"), { flag: "wx" })
      const refused = yield* Effect.flip(
        fs.writeFile("/w/./exclusive.txt", encoder.encode("clobbered"), { flag: "wx" })
      )
      expect(refused).toMatchObject({ reason: { _tag: "AlreadyExists" } })
      expect(yield* fs.readFileString("/w/exclusive.txt")).toBe("owned")
    }))

  it.effect("appends with `a` and `a+` instead of truncating", () =>
    Effect.gen(function*() {
      const fs = fileSystem()
      yield* fs.writeFileString("/w/log.txt", "one\n")
      yield* fs.writeFileString("/w/log.txt", "two\n", { flag: "a" })
      yield* fs.writeFile("/w/./log.txt", encoder.encode("three\n"), { flag: "a+" })
      yield* fs.writeFileString("/w/fresh.txt", "first\n", { flag: "a" })
      expect(yield* fs.readFileString("/w/log.txt")).toBe("one\ntwo\nthree\n")
      expect(yield* fs.readFileString("/w/fresh.txt")).toBe("first\n")
    }))

  for (const flag of ["wx", "ax", "wx+", "ax+"] as const) {
    it.effect(`refuses to clobber an existing file with \`${flag}\` and creates a missing one`, () =>
      Effect.gen(function*() {
        const fs = fileSystem()
        const refused = yield* Effect.flip(fs.writeFileString("/w/./a.txt", "clobbered", { flag }))
        expect(refused).toMatchObject({ reason: { _tag: "AlreadyExists" } })
        expect(yield* fs.readFileString("/w/a.txt")).toBe("alpha")
        yield* fs.writeFileString(`/w/${flag}.txt`, "owned", { flag })
        expect(yield* fs.readFileString(`/w/${flag}.txt`)).toBe("owned")
      }))
  }

  for (const flag of ["w", "w+"] as const) {
    it.effect(`truncates an existing file with \`${flag}\``, () =>
      Effect.gen(function*() {
        const fs = fileSystem()
        yield* fs.writeFileString("/w/a.txt", "replaced", { flag })
        expect(yield* fs.readFileString("/w/a.txt")).toBe("replaced")
      }))
  }

  it("refuses a flag it does not implement instead of guessing a truncating write", async () => {
    const memory = makeMemoryFs({ "/w/a.txt": "alpha" })

    await expect(memory.writeFile("/w/a.txt", encoder.encode("x"), { flag: "r+" })).rejects.toMatchObject({
      code: "ERR_INVALID_ARG_VALUE"
    })
    expect(decoder.decode(await memory.readFile("/w/a.txt"))).toBe("alpha")
  })

  it.effect("refuses to write under a missing parent without creating it", () =>
    Effect.gen(function*() {
      const fs = fileSystem()
      const refused = yield* Effect.flip(fs.writeFileString("/w/no/such/dir/file.txt", "orphan"))
      expect(refused).toMatchObject({ reason: { _tag: "NotFound" } })
      expect(yield* fs.exists("/w/no")).toBe(false)
      expect(yield* fs.readDirectory("/w")).toEqual(["a.txt", "sub"])
    }))

  for (const flag of [undefined, "a"] as const) {
    it.effect(`refuses to write over a directory with flag ${JSON.stringify(flag)} and keeps its children`, () =>
      Effect.gen(function*() {
        const fs = fileSystem()
        const refused = yield* Effect.flip(
          fs.writeFileString("/w/sub/", "flattened", flag === undefined ? undefined : { flag })
        )
        expect(refused).toMatchObject({ reason: { _tag: "BadResource" } })
        expect((yield* fs.stat("/w/sub")).type).toBe("Directory")
        expect(yield* fs.readFileString("/w/sub/b.txt")).toBe("beta")
      }))
  }

  it.effect("refuses to write through a file as if it were a directory", () =>
    Effect.gen(function*() {
      const fs = fileSystem()
      const refused = yield* Effect.flip(fs.writeFileString("/w/a.txt/sub.txt", "through"))
      expect(refused).toMatchObject({ reason: { _tag: "BadResource" } })
      expect(yield* fs.readFileString("/w/a.txt")).toBe("alpha")
      expect(yield* fs.exists("/w/a.txt/sub.txt")).toBe(false)
    }))

  it("tags recursive mkdir through a file with ENOTDIR and over a file with EEXIST", async () => {
    const memory = makeMemoryFs({ "/w/a.txt": "alpha" })

    await expect(memory.mkdir("/w/a.txt/deep/er", { recursive: true })).rejects.toMatchObject({ code: "ENOTDIR" })
    await expect(memory.mkdir("/w/./a.txt/", { recursive: true })).rejects.toMatchObject({ code: "EEXIST" })
    await expect(memory.stat("/w/a.txt/deep")).rejects.toMatchObject({ code: "ENOENT" })
    expect((await memory.stat("/w/a.txt")).isFile()).toBe(true)
    await memory.mkdir("/w", { recursive: true })
    await expect(memory.readdir("/w")).resolves.toEqual(["a.txt"])
  })

  for (const path of ["/w/./a.txt", "/w/sub/", "/"]) {
    for (const options of [undefined, { recursive: false }]) {
      it.effect(`refuses non-recursive mkdir over ${path} with ${JSON.stringify(options)}`, () =>
        Effect.gen(function*() {
          const fs = fileSystem()
          expect(yield* Effect.flip(fs.makeDirectory(path, options))).toMatchObject({
            reason: { _tag: "AlreadyExists", method: "makeDirectory" }
          })
          expect(yield* fs.readFileString("/w/a.txt")).toBe("alpha")
          expect(yield* fs.readFileString("/w/sub/b.txt")).toBe("beta")
          expect(yield* fs.readDirectory("/w")).toEqual(["a.txt", "sub"])
        }))
    }
  }

  it.effect("copies write inputs and read outputs", () =>
    Effect.gen(function*() {
      const fs = fileSystem()
      const input = encoder.encode("stable")
      yield* fs.writeFile("/w/copy.txt", input)
      input.fill(0)

      const first = yield* fs.readFile("/w/copy.txt")
      first.fill(1)
      const second = yield* fs.readFile("/w/copy.txt")

      expect(decoder.decode(second)).toBe("stable")
    }))

  it.effect("stats files and directories with the corresponding type and mtime", () =>
    Effect.gen(function*() {
      const fs = fileSystem()

      const [file, directory] = yield* (
        Effect.all([fs.stat("/w/a.txt"), fs.stat("/w/sub")])
      )

      expect(file.type).toBe("File")
      expect(Number(file.size)).toBe(5)
      expect(Option.getOrThrow(file.mtime)).toEqual(new Date(0))
      expect(directory.type).toBe("Directory")
      expect(Number(directory.size)).toBe(0)
    }))

  it.effect("creates directories recursively and lists their sorted entries", () =>
    Effect.gen(function*() {
      const fs = fileSystem()

      const entries = yield* (
        Effect.gen(function*() {
          yield* fs.makeDirectory("/w/deep/nested", { recursive: true })
          yield* fs.writeFile("/w/deep/nested/z.txt", encoder.encode("z"))
          return yield* fs.readDirectory("/w")
        })
      )

      expect(entries).toEqual(["a.txt", "deep", "sub"])
    }))

  it("tags non-recursive mkdir under a missing parent with ENOENT", async () => {
    const memory = makeMemoryFs()

    await expect(memory.mkdir("/missing/./child/", { recursive: false })).rejects.toMatchObject({ code: "ENOENT" })
    await expect(memory.stat("/missing")).rejects.toMatchObject({ code: "ENOENT" })
    await expect(memory.stat("/missing/child")).rejects.toMatchObject({ code: "ENOENT" })
    await expect(memory.readdir("/")).resolves.toEqual(["tmp"])
  })

  for (const path of ["/w/a.txt/child", "/w/./a.txt/./child/"]) {
    for (const options of [undefined, { recursive: false }]) {
      it.effect(`refuses non-recursive mkdir under a file parent ${path} with ${JSON.stringify(options)}`, () =>
        Effect.gen(function*() {
          const fs = fileSystem()
          expect(yield* Effect.flip(fs.makeDirectory(path, options))).toMatchObject({
            reason: { _tag: "BadResource", method: "makeDirectory", cause: { code: "ENOTDIR" } }
          })
          expect(yield* fs.readFileString("/w/a.txt")).toBe("alpha")
          expect(yield* fs.exists("/w/a.txt/child")).toBe(false)
          expect(yield* fs.readDirectory("/w")).toEqual(["a.txt", "sub"])
        }))
    }
  }

  for (const path of ["/dir/./", "/"]) {
    for (const options of [undefined, { recursive: false }, { force: true }]) {
      it(`refuses non-recursive removal of non-empty ${path} with ${JSON.stringify(options)}`, async () => {
        const memory = makeMemoryFs({ "/dir/child.txt": "child", "/dir/nested/deep.txt": "deep" })

        await expect(memory.rm(path, options)).rejects.toMatchObject({ code: "ENOTEMPTY" })
        expect((await memory.stat(path)).isDirectory()).toBe(true)
        expect(decoder.decode(await memory.readFile("/dir/child.txt"))).toBe("child")
        expect(decoder.decode(await memory.readFile("/dir/nested/deep.txt"))).toBe("deep")
        await expect(memory.readdir("/")).resolves.toEqual(["dir", "tmp"])
        await expect(memory.readdir("/dir")).resolves.toEqual(["child.txt", "nested"])
      })
    }
  }

  it.effect("creates and removes an empty directory without recursive and removes a file", () =>
    Effect.gen(function*() {
      const fs = fileSystem()

      yield* fs.makeDirectory("/empty/")
      expect((yield* fs.stat("/empty")).type).toBe("Directory")
      yield* fs.remove("/empty")
      yield* fs.remove("/w/a.txt")

      expect(yield* fs.exists("/empty")).toBe(false)
      expect(yield* fs.exists("/w/a.txt")).toBe(false)
      expect(yield* fs.readDirectory("/w")).toEqual(["sub"])
    }))

  it.effect("resolves realPath and access only for paths that exist", () =>
    Effect.gen(function*() {
      const fs = fileSystem()

      expect(yield* (fs.realPath("/w/a.txt"))).toBe("/w/a.txt")
      expect(yield* (fs.access("/w/a.txt"))).toBeUndefined()
      expect(yield* (Effect.flip(fs.realPath("/w/gone")))).toMatchObject({
        reason: { _tag: "NotFound", method: "realPath" }
      })
      expect(yield* (Effect.flip(fs.access("/w/gone")))).toMatchObject({
        reason: { _tag: "NotFound", method: "access" }
      })
    }))

  it.effect("removes recursively, tolerates a forced removal of a missing path, and fails otherwise", () =>
    Effect.gen(function*() {
      const fs = fileSystem()

      const remaining = yield* (
        Effect.gen(function*() {
          yield* fs.remove("/w/sub", { recursive: true })
          yield* fs.remove("/w/never", { force: true })
          const failure = yield* Effect.flip(fs.remove("/w/never"))
          const listing = yield* fs.readDirectory("/w")
          return { failure, listing }
        })
      )

      expect(remaining.listing).toEqual(["a.txt"])
      expect(remaining.failure).toMatchObject({ reason: { _tag: "NotFound", method: "remove" } })
    }))

  it.effect("streams a whole file when no bounds are given", () =>
    Effect.gen(function*() {
      const fs = fileSystem()

      const chunks = yield* (Stream.runCollect(fs.stream("/w/a.txt")))

      expect(Array.from(chunks).map((chunk) => decoder.decode(chunk)).join("")).toBe("alpha")
    }))

  it.effect("emits nothing when `bytesToRead` is zero and refuses a negative offset", () =>
    Effect.gen(function*() {
      const fs = fileSystem()

      const empty = yield* (Stream.runCollect(fs.stream("/w/a.txt", { bytesToRead: 0 })))
      // A negative offset is a nonsense bound, not a request for the start, so
      // the adapter refuses it rather than answering a question the caller did
      // not ask. The double must report that refusal identically.
      const refused = yield* Effect.flip(
        Stream.runCollect(fs.stream("/w/a.txt", { offset: -10, chunkSize: 2 }))
      )

      expect(Array.from(empty)).toEqual([])
      expect(refused).toMatchObject({
        reason: {
          _tag: "BadArgument",
          method: "stream",
          description: "offset must be a whole, non-negative number of bytes"
        }
      })
    }))

  it.effect("truncates the final chunk when fewer bytes remain than the chunk size", () =>
    Effect.gen(function*() {
      const fs = fileSystem()

      const chunks = yield* (
        Stream.runCollect(fs.stream("/w/a.txt", { offset: 3, bytesToRead: 99, chunkSize: 4 }))
      )

      expect(Array.from(chunks).map((chunk) => chunk.length)).toEqual([2])
      expect(decoder.decode(Array.from(chunks)[0])).toBe("ha")
    }))
})
