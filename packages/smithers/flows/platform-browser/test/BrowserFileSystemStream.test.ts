import { describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import * as BrowserFileSystem from "../src/BrowserFileSystem/index.ts"

describe("BrowserFileSystem", () => {
  // Stream completion is the condition; a wall-clock limit only measures
  // machine load, which the package-wide `testTimeout` budgets for.
  it.effect.each(
    [
      { offset: 17, bytesToRead: 100_000, chunkSize: 4_096 },
      { offset: "17 B", bytesToRead: "100 kB", chunkSize: 4_096 }
    ] as const
  )("streams bounded chunks without loading the complete file (%j)", (options) =>
    Effect.gen(function*() {
      const source = Uint8Array.from({ length: 200_000 }, (_, index) => index % 251)
      let closed = false
      let largestRead = 0
      const backend: BrowserFileSystem.ZenFsPromisesLike = {
        open: async () => ({
          read: async (buffer, offset, length, position) => {
            largestRead = Math.max(largestRead, buffer.length)
            const bytesRead = Math.min(length, source.length - position)
            if (bytesRead > 0) {
              buffer.set(source.subarray(position, position + bytesRead), offset)
            }
            return { bytesRead }
          },
          close: async () => {
            closed = true
          }
        }),
        readFile: async () => {
          throw new Error("stream must not call readFile")
        },
        writeFile: async () => {},
        mkdir: async () => {},
        readdir: async () => [],
        stat: async () => ({
          size: source.length,
          mode: 0,
          mtimeMs: 0,
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false
        }),
        rm: async () => {}
      }
      const fileSystem = BrowserFileSystem.make(backend)

      const chunks = yield* (
        fileSystem.stream("/large", options).pipe(Stream.runCollect)
      )
      const bytes = Uint8Array.from(Array.from(chunks).flatMap((chunk) => [...chunk]))

      expect(bytes).toEqual(source.subarray(17, 100_017))
      expect(largestRead).toBeLessThanOrEqual(4_096)
      expect(closed).toBe(true)
    }))

  it.effect("fails with the mapped stream error when handle.read rejects after a successful chunk", () =>
    Effect.gen(function*() {
      const readError = Object.assign(new Error("EIO: read failed"), { code: "EIO" })
      const delivered: Array<Array<number>> = []
      let reads = 0
      let closed = false
      const backend: BrowserFileSystem.ZenFsPromisesLike = {
        open: async () => ({
          read: async (buffer, offset) => {
            reads += 1
            if (reads === 1) {
              buffer.set([1, 2, 3], offset)
              return { bytesRead: 3 }
            }
            throw readError
          },
          close: async () => {
            closed = true
          }
        }),
        readFile: async () => {
          throw new Error("stream must not call readFile")
        },
        writeFile: async () => {},
        mkdir: async () => {},
        readdir: async () => [],
        stat: async () => ({
          size: 6,
          mode: 0,
          mtimeMs: 0,
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false
        }),
        rm: async () => {}
      }
      const fileSystem = BrowserFileSystem.make(backend)

      const error = yield* (
        Effect.flip(
          fileSystem.stream("/partial", { chunkSize: 3 }).pipe(
            Stream.tap((chunk) => Effect.sync(() => delivered.push(Array.from(chunk)))),
            Stream.runCollect
          )
        )
      )

      expect(delivered).toEqual([[1, 2, 3]])
      expect(reads).toBe(2)
      expect(error.reason).toMatchObject({
        _tag: "Unknown",
        method: "stream.read",
        pathOrDescriptor: "/partial",
        description: "EIO: read failed",
        cause: readError
      })
      expect(closed).toBe(true)
    }))
})
