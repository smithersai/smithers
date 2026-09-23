import { NodeServices } from "@effect/platform-node"
import * as Path from "@smthrs/kernel/Path"
import { Context, Effect, Layer, PlatformError, Stream } from "effect"
import * as FileSystem from "effect/FileSystem"
import { execFile } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterAll, describe, expect, it, vi } from "vitest"
import * as Grep from "../src/Grep.ts"
import * as Grouping from "../src/internal/Grouping.ts"
import * as LinearRegex from "../src/internal/LinearRegex.ts"
import * as NativeSearch from "../src/NativeSearch.ts"
import * as PortableSearch from "../src/PortableSearch.ts"
import * as Search from "../src/Search.ts"
import * as SearchConformance from "../src/SearchConformance.ts"
import * as SearchContract from "../src/SearchContract.ts"

const root = mkdtempSync(join(tmpdir(), "portable-search-bounds-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const implementation = PortableSearch.layer.pipe(Layer.provide(NodeServices.layer))
const grep = (input: typeof Grep.Input.Type) => Effect.runPromise(Grep.run(input).pipe(Effect.provide(implementation)))

it.each([false, true])(
  "uses an atomic read only before a failing stream has yielded bytes, partial=%s",
  async (partial) => {
    const file = join(root, `refused-stream-${partial}.txt`)
    writeFileSync(file, "needle\n")
    let atomicReads = 0
    const search = await Effect.runPromise(
      Effect.gen(function*() {
        const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
        const fs = yield* FileSystem.FileSystem
        const refused = Stream.fail(PlatformError.badArgument({
          module: "FileSystem",
          method: "stream",
          description: "stream unavailable"
        }))
        return PortableSearch.make(Context.add(services, FileSystem.FileSystem, {
          ...fs,
          stream: () => partial ? Stream.concat(Stream.make(new TextEncoder().encode("needle\n")), refused) : refused,
          readFile: (path) => {
            atomicReads++
            return fs.readFile(path)
          }
        }))
      }).pipe(Effect.provide(NodeServices.layer))
    )
    const result = await Effect.runPromise(
      Grep.run({ root: file, pattern: "needle", symbols: false }).pipe(
        Effect.provideService(Search.Search, search)
      )
    )

    expect(atomicReads).toBe(partial ? 0 : 1)
    expect(result.matches.map(({ line, text }) => ({ line, text })))
      .toEqual(partial ? [] : [{ line: 1, text: "needle" }])
  }
)

describe("portable search bounds", () => {
  it("completes a nested-quantifier near miss while timers can run", async () => {
    const file = join(root, "nested.txt")
    writeFileSync(file, `${"a".repeat(100_000)}!\n`)
    const script = `
      import { Effect, Layer } from "effect"
      import { NodeServices } from "@effect/platform-node"
      import * as PortableSearch from ${JSON.stringify(new URL("../src/PortableSearch.ts", import.meta.url).href)}
      import * as Grep from ${JSON.stringify(new URL("../src/Grep.ts", import.meta.url).href)}
      let ticks = 0
      const timer = setInterval(() => { ticks++ }, 1)
      try {
        const start = performance.now()
        const result = await Effect.runPromise(Grep.run({
          root: ${JSON.stringify(file)}, pattern: "(a+)+$", symbols: false
        }).pipe(Effect.provide(PortableSearch.layer.pipe(Layer.provide(NodeServices.layer)))))
        console.log(JSON.stringify({ matches: result.matches, elapsed: performance.now() - start, ticks }))
      } finally { clearInterval(timer) }
    `
    // A parent-enforced deadline kills a regressed synchronous matcher too.
    const child = await promisify(execFile)(process.execPath, [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      script
    ], {
      timeout: 10_000,
      killSignal: "SIGKILL"
    })
    const result = JSON.parse(child.stdout)
    expect(result.matches).toEqual([])
    expect(result.elapsed).toBeLessThan(5000)
    expect(result.ticks).toBeGreaterThan(1)
  }, 15_000)

  it("retains only the limited matches, their context and one boundary hit", async () => {
    const file = join(root, "many.txt")
    writeFileSync(file, "needle\n".repeat(20_000))
    const group = vi.spyOn(Grouping, "group")
    const annotate = vi.spyOn(Grouping, "annotate")
    try {
      const result = await grep({ root: file, pattern: "needle", limit: 1, context: 1 })
      expect(result.matches).toHaveLength(1)
      expect(result.notice).toContain("20000")
      expect(result.truncated).toBe(true)
      expect(Math.max(...group.mock.calls.map(([rows]) => rows.length))).toBeLessThanOrEqual(6)
      expect(
        annotate.mock.calls.every(([matches, contents]) =>
          matches.length <= 1 && [...contents.keys()].every((file) => matches.some((match) => match.file === file))
        )
      ).toBe(true)
    } finally {
      group.mockRestore()
      annotate.mockRestore()
    }
  })
})

it("streams overflow files and loads symbol source only for the one retained file", async () => {
  const directory = join(root, "many-files")
  mkdirSync(directory)
  for (let index = 0; index < 40; index++) {
    writeFileSync(join(directory, `${String(index).padStart(2, "0")}.py`), "def widen():\n    needle\n".repeat(100))
  }
  const loaded: Array<string> = []
  const search = await Effect.runPromise(
    Effect.gen(function*() {
      const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
      const fs = yield* FileSystem.FileSystem
      return PortableSearch.make(Context.add(services, FileSystem.FileSystem, {
        ...fs,
        readFile: () => Effect.die("grep must stream file reads"),
        readFileString: (file) => {
          loaded.push(file)
          return fs.readFileString(file)
        }
      }))
    }).pipe(Effect.provide(NodeServices.layer))
  )
  const input = {
    ...SearchConformance.plan({ seed: 1, root: directory, calls: 1 }).grep[0]!,
    pattern: "needle",
    root: directory,
    fixedStrings: true,
    globs: [],
    maxCount: undefined,
    symbols: true,
    filesWithMatches: false,
    limit: 1
  }
  const result = await Effect.runPromise(search.grep(input))
  expect(result.matches).toHaveLength(1)
  expect(result.matches[0]?.symbol?.name).toBe("widen")
  expect(result.notice).toBe("Showing 1 of 4000 matches; output was truncated.")
  expect(loaded).toEqual([join(directory, "00.py")])
  loaded.length = 0
  expect((await Effect.runPromise(search.grep({ ...input, limit: 0 }))).matches).toEqual([])
  expect((await Effect.runPromise(search.grep({ ...input, filesWithMatches: true }))).files).toEqual([
    join(directory, "00.py")
  ])
  expect(loaded).toEqual([])
})

it("agrees with rg on boundary context, chunked text and the linear regex grammar", async () => {
  const file = join(root, "grammar.txt")
  writeFileSync(
    file,
    "x".repeat(65535) + "\r\n" +
      "aaa\naaa!\naaaa\nabc\nac\na.c\nKkKSsſ😀é\n\nneedle\none\ntwo\nthree\nneedle\nfive\nneedle\ntrailing"
  )
  const patterns = [
    "",
    "(a+)+$",
    "(a|aa)+$",
    "^(a?)*$",
    "^$",
    "a{0}",
    "a{2,4}?",
    "(ab|a){1,}",
    "a?",
    "a*",
    "a+?",
    "a{2}",
    "(a|)c",
    "[a-z]+",
    "[^a-z]",
    "[a-z-]",
    "[a\\-c]",
    "a\\.c",
    "^.*$",
    "k|s",
    "needle"
  ]
  const template = SearchConformance.plan({ seed: 1, root: file, files: 0, calls: 1 })
  const calls = patterns.flatMap((pattern) =>
    [false, true].map((ignoreCase) => ({
      ...template.grep[0]!,
      root: file,
      pattern,
      fixedStrings: false,
      ignoreCase,
      smartCase: false,
      globs: [],
      beforeContext: 0,
      afterContext: 0,
      maxCount: undefined,
      filesWithMatches: false,
      symbols: false,
      limit: 200
    }))
  )
  for (const beforeContext of [0, 1, 5, 10]) {
    for (const afterContext of [0, 1, 5, 10]) {
      calls.push({ ...calls[0]!, pattern: "needle", beforeContext, afterContext, limit: 1 })
    }
  }
  const differences = await Effect.runPromise(
    Effect.gen(function*() {
      const subject = yield* Effect.provide(Search.Search, PortableSearch.layer)
      const reference = yield* Effect.provide(Search.Search, NativeSearch.layer)
      return yield* SearchConformance.compare({ plan: { ...template, grep: calls, glob: [] }, subject, reference })
    }).pipe(Effect.provide(NodeServices.layer))
  )
  expect(SearchConformance.report(differences)).toBe("")
  expect(differences).toEqual([])
})

it("bounds expanded repetitions and nesting in the shared validator", () => {
  expect(SearchContract.validatePattern("(a{1000}){1000}", false)?.code).toBe("invalid_pattern")
  expect(SearchContract.validatePattern("(".repeat(129) + "a" + ")".repeat(129), false)?.code).toBe("invalid_pattern")
  expect(SearchContract.validatePattern("a{1000}", false)).toBeUndefined()
  expect(SearchContract.validatePattern("(".repeat(128) + "a" + ")".repeat(128), false)).toBeUndefined()
  expect(SearchContract.validatePattern("(a+)+$", false)).toBeUndefined()
})

it("names the construct and column a malformed pattern breaks on", () => {
  const reason = (pattern: string) => SearchContract.validatePattern(pattern, false)?.message
  // A worker searched for this and was told only that the pattern was unsupported.
  expect(reason("layerRules|Rule({|rules:")).toBe(
    "Unsupported ripgrep pattern \"layerRules|Rule({|rules:\": \"{\" at column 17 is not a repetition count; write \\{ for a literal brace"
  )
  expect(reason("foo(bar")).toContain("\"(\" at column 4 is never closed; write \\( for a literal parenthesis")
  expect(reason("a)b")).toContain("\")\" at column 2 closes nothing; write \\) for a literal parenthesis")
  expect(reason("*.ts")).toContain("\"*\" at column 1 repeats nothing; write \\* for a literal *")
  expect(reason("x|+y")).toContain("\"+\" at column 3 repeats nothing; write \\+ for a literal +")
  expect(reason("[abc")).toContain("\"[\" at column 1 is never closed; write \\[ for a literal bracket")
  expect(reason("Rule\\(\\{")).toBeUndefined()
  expect(reason("a{2,3}(b)?")).toBeUndefined()
})

it("agrees with the shared expression on generated short strings", () => {
  const patterns = [
    "(a|b)*abb",
    "((a?)*)*",
    "(ab|a)+b$",
    "^(a|b){0,3}?$",
    "(a|)b?",
    "a{0,}",
    "[ab-]+",
    "[\\^a]",
    "\\^a\\$",
    "a{0,0}"
  ]
  const lines = ["", "a", "b", "ab", "aab", "abb", "aaab", "ababb", "a\nb", "^a$", "😀", "é", "\r", "-"]
  for (const pattern of patterns) {
    expect(SearchContract.validatePattern(pattern, false)).toBeUndefined()
    const regex = LinearRegex.compile(pattern, false)
    const reference = SearchContract.expression(pattern, false, false)
    for (const line of lines) {
      const evaluation = regex.test(line)
      let result = evaluation.next()
      while (!result.done) result = evaluation.next()
      expect(result.value, `${pattern}: ${JSON.stringify(line)}`).toBe(reference.test(line))
    }
  }
})

it("preserves standalone carriage returns when streaming source lines", async () => {
  const file = join(root, "carriage.txt")
  writeFileSync(file, "a\raa\ntrailing\r")
  const result = await grep({ root: file, pattern: "a", fixedStrings: true, symbols: false })
  expect(result.matches.map(({ line, text }) => ({ line, text }))).toEqual([
    { line: 1, text: "a\raa" },
    { line: 2, text: "trailing\r" }
  ])
})

it("discards early hits when a later chunk reveals a binary file", async () => {
  const directory = join(root, "late-binary")
  mkdirSync(directory)
  writeFileSync(join(directory, "a.bin"), "needle\n" + "x".repeat(70_000) + "\0")
  writeFileSync(join(directory, "b.txt"), "needle\n")
  const result = await grep({ root: directory, pattern: "needle", limit: 1, maxCount: 1 })
  expect(result).toMatchObject({ filesSearched: 2, skippedBinary: 1, truncated: false })
  expect(result.matches.map((match) => match.file)).toEqual([join(directory, "b.txt")])
})
