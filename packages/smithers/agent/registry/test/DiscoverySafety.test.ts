import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Effect, FileSystem, Layer, Path, PlatformError, Stream } from "effect"
import * as ByteSize from "effect/ByteSize"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Source } from "../src/Descriptor.vibe"
import * as Discovery from "../src/Discovery.vibe"

const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)
const denied = (method: string, location: string) =>
  PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method,
    pathOrDescriptor: location
  })

describe("Discovery safety regressions", () => {
  let directory: string
  let root: string
  beforeEach(() => {
    directory = mkdtempSync(join(process.cwd(), ".registry-safety-"))
    root = join(directory, "flows")
    mkdirSync(join(root, "review"), { recursive: true })
    writeFileSync(join(root, "review", "SKILL.md"), "---\ndescription: Review\ncapabilities: []\n---\nBody")
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  const scan = (faults: (fs: FileSystem.FileSystem) => FileSystem.FileSystem, source: Partial<Source> = {}) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        return yield* Discovery.make(faults(fs), path).scan({ source: "test", root, naming: "path", ...source })
      }).pipe(Effect.provide(platform))
    )

  it("refuses discovery without reading entries when the configured confinement root cannot resolve", async () => {
    const reads: Array<string> = []
    const result = await scan((fs) => ({
      ...fs,
      realPath: (location) =>
        location === directory ? Effect.fail(denied("realPath", location)) : fs.realPath(location),
      readDirectory: (location) => {
        reads.push(location)
        return fs.readDirectory(location)
      }
    }), { confinementRoot: directory })
    expect(result.entries).toEqual([])
    expect(result.warnings).toEqual([expect.objectContaining({ code: "outside_root", path: root })])
    expect(reads).toEqual([])
  })

  it("bounds entry reads independently of an under-reported stat size", async () => {
    const entry = join(root, "review", "SKILL.md")
    writeFileSync(entry, "x".repeat(Discovery.entrySizeLimit + 1024))
    const wholeReads: Array<string> = []
    let streamedBytes = 0
    let readLimit: ByteSize.Input | undefined
    const result = await scan((fs) => ({
      ...fs,
      stat: (location) =>
        fs.stat(location).pipe(Effect.map((info) => location === entry ? { ...info, size: ByteSize.bytes(0) } : info)),
      readFile: (location) => {
        wholeReads.push(location)
        return Effect.fail(denied("readFile", location))
      },
      stream: (location, options) => {
        readLimit = options?.bytesToRead
        return fs.stream(location, options).pipe(Stream.map((chunk) => {
          streamedBytes += chunk.length
          return chunk
        }))
      }
    }))
    expect(wholeReads).toEqual([])
    expect(readLimit).toBe(Discovery.entrySizeLimit + 1)
    expect(streamedBytes).toBe(Discovery.entrySizeLimit + 1)
    expect(result.entries).toEqual([])
    expect(result.warnings).toEqual([expect.objectContaining({ code: "entry_too_large", path: entry })])
  })

  it("visits a retired directory once despite branching symlink cycles", async () => {
    const retired = join(directory, "retired")
    mkdirSync(retired)
    symlinkSync(retired, join(retired, "a"), "dir")
    symlinkSync(retired, join(retired, "b"), "dir")
    let reads = 0
    const result = await scan((fs) => ({
      ...fs,
      // Bound the faulty traversal so the regression never attempts an exponential walk.
      readDirectory: (location) => {
        if (!location.startsWith(retired)) return fs.readDirectory(location)
        reads++
        return reads > 50 ? Effect.fail(denied("readDirectory", location)) : fs.readDirectory(location)
      }
    }), { retiredRoot: retired })
    expect(reads).toBe(1)
    expect(result.entries.map((entry) => entry.name)).toEqual(["review"])
    expect(result.warnings).toEqual([])
  })

  it("still probes a shallower alias after reaching the same retired directory at the depth limit", async () => {
    const retired = join(directory, "retired")
    const shared = join(directory, "shared")
    mkdirSync(join(shared, "review"), { recursive: true })
    writeFileSync(join(shared, "review", "SKILL.md"), "Body")
    let deep = retired
    for (let depth = 0; depth < Discovery.maximumTraversalDepth - 1; depth++) deep = join(deep, "a")
    mkdirSync(deep, { recursive: true })
    symlinkSync(shared, join(deep, "alias"), "dir")
    symlinkSync(shared, join(retired, "z"), "dir")
    const result = await scan((fs) => fs, { retiredRoot: retired })
    expect(result.warnings).toEqual([expect.objectContaining({ code: "retired_root", path: retired })])
  })
})
