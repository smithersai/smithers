import { describe, expect, it } from "@effect/vitest"
import type * as FileSet from "@smthrs/plan/FileSet"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as PlatformError from "effect/PlatformError"
import * as FileEnumeration from "../src/internal/FileEnumeration.vibe"

const fixture = () => {
  const directories = new Map<string, ReadonlyArray<string>>([
    [".", ["packages", "root.json", "root.txt", "src"]],
    ["packages", ["a"]],
    ["packages/a", ["node_modules"]],
    ["packages/a/node_modules", ["pkg"]],
    ["packages/a/node_modules/pkg", ["config.json"]],
    ["src", ["link", "node_modules", "visible.json"]],
    ["src/node_modules", ["hidden.json"]]
  ])
  const files = new Set([
    "packages/a/node_modules/pkg/config.json",
    "root.json",
    "root.txt",
    "src/visible.json",
    "src/node_modules/hidden.json"
  ])
  const reads: Array<string> = []
  const stats: Array<string> = []
  const probes: Array<string> = []
  const descendants = (directory: string): ReadonlyArray<string> => {
    const prefix = directory === "." ? "" : `${directory}/`
    return [...directories.keys(), ...files]
      .filter((path) => path !== "." && path !== directory && path.startsWith(prefix))
      .map((path) => path.slice(prefix.length))
  }
  const fs = FileSystem.makeNoop({
    exists: ((path: string) =>
      Effect.sync(() => {
        probes.push(path)
        return path === "." || directories.has(path) || files.has(path)
      })) as never,
    // A real host refuses to list a path that is not there rather than
    // answering with an empty listing, which is what lets an enumeration skip
    // the `exists` probe it used to pay for ahead of every walk.
    readDirectory: ((path: string, options?: { readonly recursive?: boolean }) =>
      Effect.suspend(() => {
        reads.push(path)
        const listing = directories.get(path)
        if (listing === undefined) {
          return Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "FileSystem",
              method: "readDirectory",
              pathOrDescriptor: path,
              description: "no such directory"
            })
          )
        }
        return Effect.succeed(options?.recursive === true ? descendants(path) : [...listing])
      })) as never,
    stat: ((path: string) =>
      Effect.sync(() => {
        stats.push(path)
        return { type: path === "src/link" ? "SymbolicLink" : files.has(path) ? "File" : "Directory", size: 0n }
      })) as never
  })
  return { fs, probes, reads, stats }
}

describe("FileEnumeration", () => {
  it.effect("skips ignored directories for root globs unless an include names one", () =>
    Effect.gen(function*() {
      const host = fixture()
      const rootGlob: FileSet.Glob = { _tag: "Glob", include: ["**/*.json"] }
      const explicitGlob: FileSet.Glob = {
        _tag: "Glob",
        include: ["src/node_modules/**/*.json"]
      }

      expect(yield* FileEnumeration.expandGlob(host.fs, rootGlob)).toEqual([
        "root.json",
        "src/visible.json"
      ])
      expect(host.reads).not.toContain("src/node_modules")
      expect(host.stats).not.toContain("src/node_modules/hidden.json")

      expect(yield* FileEnumeration.expandGlob(host.fs, explicitGlob)).toEqual([
        "src/node_modules/hidden.json"
      ])
    }))

  it.effect("walks an ignored directory named after a wildcard segment", () =>
    Effect.gen(function*() {
      const host = fixture()
      const glob: FileSet.Glob = {
        _tag: "Glob",
        include: ["packages/*/node_modules/**/*.json"]
      }

      expect(yield* FileEnumeration.expandGlob(host.fs, glob)).toEqual([
        "packages/a/node_modules/pkg/config.json"
      ])
      expect(host.reads).toContain("packages/a/node_modules")
    }))

  it.effect("fails typed when a walk exceeds maxEntries", () =>
    Effect.gen(function*() {
      const host = fixture()
      const glob: FileSet.Glob = { _tag: "Glob", include: ["**"] }
      const exit = yield* Effect.exit(FileEnumeration.expandGlob(host.fs, glob, { maxEntries: 2 }))

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) return
      const error = Cause.squash(exit.cause)
      expect(error).toBeInstanceOf(FileEnumeration.FileEnumerationError)
      expect(error).toMatchObject({
        code: "entry_limit_exceeded",
        pattern: "**",
        limit: 2
      })
    }))

  it.effect("enumerates direct subtrees, tolerates absence, and deduplicates shared prefixes", () =>
    Effect.gen(function*() {
      const host = fixture()
      const resolve = (path: string): string => path === "" ? "." : path

      expect(yield* FileEnumeration.filesUnder(host.fs, "src", { resolve })).toEqual([
        "src/node_modules/hidden.json",
        "src/visible.json"
      ])
      expect(yield* FileEnumeration.filesUnder(host.fs, "")).toEqual([
        "packages/a/node_modules/pkg/config.json",
        "root.json",
        "root.txt",
        "src/node_modules/hidden.json",
        "src/visible.json"
      ])
      expect(yield* FileEnumeration.entriesUnder(host.fs, "src", { resolve })).toEqual({
        files: ["src/node_modules/hidden.json", "src/visible.json"],
        directories: ["src", "src/node_modules"]
      })
      expect(yield* FileEnumeration.entriesUnder(host.fs, "src")).toEqual({
        files: ["src/node_modules/hidden.json", "src/visible.json"],
        directories: ["src", "src/node_modules"]
      })
      expect(yield* FileEnumeration.filesUnder(host.fs, "missing")).toEqual([])
      // An absent walk root reports NO directories, not the root it was asked
      // about: a tree replay reads this list as the scaffolding it may prune.
      expect(yield* FileEnumeration.entriesUnder(host.fs, "missing")).toEqual({ files: [], directories: [] })

      const glob: FileSet.Glob = {
        _tag: "Glob",
        include: ["src/*.json", "src/**/*.json"]
      }
      expect(yield* FileEnumeration.expandGlob(host.fs, glob)).toEqual(["src/visible.json"])
    }))

  it.effect("reaches a directory in one host call, never a probe and then a listing", () =>
    Effect.gen(function*() {
      const host = fixture()
      const glob: FileSet.Glob = { _tag: "Glob", include: ["src/**/*.json"] }

      yield* FileEnumeration.expandGlob(host.fs, glob)
      yield* FileEnumeration.filesUnder(host.fs, "src")
      yield* FileEnumeration.entriesUnder(host.fs, "src")
      yield* FileEnumeration.filesUnder(host.fs, "missing")

      // Every walk asks the listing itself whether the directory is there.
      // The `exists` probe this used to pay first answered nothing the
      // listing does not, and on a confined host each probe is a second
      // process (`@smthrs/platform-node/AtomicFileSystem` spawns one CPython
      // interpreter per operation), so a walk of D directories bought D forks
      // of nothing.
      expect(host.probes).toEqual([])
      // One listing per directory reached, and the absent root is one listing
      // rather than a probe plus a listing.
      expect(host.reads).toEqual([
        // the glob walk, which prunes `src/node_modules`
        "src",
        // the two declared-tree walks, which do not
        "src",
        "src/node_modules",
        "src",
        "src/node_modules",
        // and the absent root
        "missing"
      ])
    }))
})
