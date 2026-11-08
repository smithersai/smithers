import { describe, expect, it } from "@effect/vitest"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import { Effect, FileSystem, Option } from "effect"
import { stat } from "node:fs/promises"
import * as AtomicFileSystem from "../src/AtomicFileSystem.ts"
import * as Protocol from "../src/internal/AtomicFileSystemProtocol.ts"

describe("exact inode transport", () => {
  for (const ino of ["0", "9007199254740991", "9007199254740992", "28428972649155818", "18446744073709551615"]) {
    it.effect(`retains inode ${ino} as bigint`, () =>
      Effect.gen(function*() {
        const info = yield* Protocol.convert<{ ino: Option.Option<bigint> }>(
          { operation: "stat", path: "/inode" },
          {
            type: "File",
            mtime: 0,
            atime: 0,
            dev: 1,
            ino,
            mode: 0o100600,
            nlink: 1,
            uid: 0,
            gid: 0,
            rdev: 0,
            size: "0"
          },
          AtomicFileSystem.defaultLimits
        )
        expect(info.ino).toEqual(Option.some(BigInt(ino)))
      }))
  }

  for (const ino of ["-1", "01", "", "1.5", "18446744073709551616", 9007199254740992]) {
    it("refuses malformed or lossy inode " + JSON.stringify(ino), () => {
      expect(() =>
        Protocol.convert(
          { operation: "stat", path: "/inode" },
          {
            type: "File",
            mtime: 0,
            atime: 0,
            dev: 1,
            ino,
            mode: 0o100600,
            nlink: 1,
            uid: 0,
            gid: 0,
            rdev: 0,
            size: "0"
          },
          AtomicFileSystem.defaultLimits
        )
      ).toThrow()
    })
  }

  it.live("matches real Node bigint stat for the pinned directory", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.realPath(".")
      const native = yield* Effect.promise(() => stat(root, { bigint: true }))
      const atomic = (fs as KernelFileSystem.AtomicHostFileSystem)[KernelFileSystem.AtomicFileSystemTypeId]
      const identity = yield* atomic.identifyRoot!(root)
      const info = yield* atomic.execute({
        operation: "stat",
        boundaryRoot: root,
        logicalRoot: root,
        rootIdentity: identity,
        path: root
      })
      expect(info.ino).toEqual(Option.some(native.ino))
    }).pipe(Effect.provide(AtomicFileSystem.layer)))
})
