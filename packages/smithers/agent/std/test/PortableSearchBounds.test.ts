/**
 * What the in-process search peer holds in memory for one file.
 *
 * A line is accumulated until its newline arrives, so a file with no newline
 * was buffered whole, and a file with matches was loaded whole a second time
 * to name symbols. Both are bounded here: the scan stops reading at the line
 * bound, and symbols are not named for a file past the size bound.
 */
import { NodeServices } from "@effect/platform-node"
import * as Path from "@smthrs/kernel/Path"
import { Cause, Context, Effect, Exit, Option, Stream } from "effect"
import * as FileSystem from "effect/FileSystem"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as PortableSearch from "../src/PortableSearch.ts"
import type * as Search from "../src/Search.ts"

const root = mkdtempSync(join(tmpdir(), "portable-search-memory-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** The peer over the real filesystem, with `stream` and the limits replaced when given. */
const peer = (options: {
  readonly stream?: (file: string) => Stream.Stream<Uint8Array> | undefined
  readonly limits?: PortableSearch.Limits
  readonly loaded?: Array<string>
} = {}) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
      const fs = yield* FileSystem.FileSystem
      return PortableSearch.make(
        Context.add(services, FileSystem.FileSystem, {
          ...fs,
          stream: (file, streamOptions) => options.stream?.(file) ?? fs.stream(file, streamOptions),
          readFileString: (file, encoding) => {
            options.loaded?.push(file)
            return fs.readFileString(file, encoding)
          }
        }),
        options.limits
      )
    }).pipe(Effect.provide(NodeServices.layer))
  )

const input = (overrides: Partial<Search.GrepInput> & Pick<Search.GrepInput, "root">): Search.GrepInput => ({
  pattern: "needle",
  fixedStrings: true,
  ignoreCase: false,
  smartCase: false,
  globs: [],
  hidden: false,
  noIgnore: false,
  maxCount: undefined,
  beforeContext: 0,
  afterContext: 0,
  symbols: false,
  filesWithMatches: false,
  limit: 50,
  ...overrides
})

describe("the portable peer's line bound", () => {
  it("stops reading a 200 MB newline-free stream at the bound and counts the file as skipped", async () => {
    const directory = join(root, "huge")
    mkdirSync(directory)
    writeFileSync(join(directory, "blob.txt"), "placeholder\n")
    writeFileSync(join(directory, "small.txt"), "needle here\n")
    const megabyte = new Uint8Array(1024 * 1024).fill(120)
    let pulled = 0
    const search = await peer({
      stream: (file) =>
        file.endsWith("blob.txt")
          ? Stream.range(1, 200).pipe(
            Stream.rechunk(1),
            Stream.map(() => {
              pulled++
              return megabyte
            })
          )
          : undefined
    })
    const result = await Effect.runPromise(search.grep(input({ root: directory })))
    expect(PortableSearch.MAX_LINE_UNITS).toBe(8 * 1024 * 1024)
    expect(result.filesSearched).toBe(2)
    expect(result.skippedBinary).toBe(1)
    expect(result.matches.map((match) => match.file)).toEqual([join(directory, "small.txt")])
    // Nine one-megabyte chunks pass the 8 MiB bound; the rest are never read.
    expect(pulled).toBeLessThanOrEqual(16)
  })

  it("refuses a named file with a line past the bound, and names the bound", async () => {
    const file = join(root, "long-line.txt")
    writeFileSync(file, `needle ${"x".repeat(64)}`)
    const search = await peer({ limits: { maxLineUnits: 32 } })
    const exit = await Effect.runPromiseExit(search.grep(input({ root: file })))
    const failure = Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined
    expect(failure).toMatchObject({
      code: "response_too_large",
      path: file,
      message: `Cannot search ${file}: it holds a line longer than 32 characters`
    })
  })

  it("measures each line on its own, so many short lines are never refused", async () => {
    const file = join(root, "short-lines.txt")
    writeFileSync(file, `${"0123456789\n".repeat(50)}needle\nunterminated tail`)
    const search = await peer({ limits: { maxLineUnits: 20 } })
    const result = await Effect.runPromise(search.grep(input({ root: file })))
    expect(result.matches.map((match) => match.line)).toEqual([51])
  })
})

describe("the portable peer's symbol source bound", () => {
  const source = "def widen():\n    needle = 1\n    return needle\n"

  it("names symbols for a file within the bound", async () => {
    const file = join(root, "within.py")
    writeFileSync(file, source)
    const loaded: Array<string> = []
    const search = await peer({ loaded, limits: { maxSymbolSourceBytes: source.length } })
    const result = await Effect.runPromise(search.grep(input({ root: file, symbols: true })))
    expect(result.matches[0]?.symbol?.name).toBe("widen")
    expect(loaded).toEqual([file])
  })

  it("returns a larger file's matches without loading it whole", async () => {
    const file = join(root, "beyond.py")
    writeFileSync(file, source)
    const loaded: Array<string> = []
    const search = await peer({ loaded, limits: { maxSymbolSourceBytes: source.length - 1 } })
    const result = await Effect.runPromise(search.grep(input({ root: file, symbols: true })))
    expect(result.matches.map((match) => match.line)).toEqual([2, 3])
    expect(result.matches.every((match) => match.symbol === undefined)).toBe(true)
    expect(loaded).toEqual([])
  })
})
