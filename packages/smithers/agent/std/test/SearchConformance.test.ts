import { NodeFileSystem, NodePath, NodeServices } from "@effect/platform-node"
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import { Cause, Effect, Exit, Layer, Sink, Stream } from "effect"
import type * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ExitCode, makeHandle, ProcessId } from "effect/unstable/process/ChildProcessSpawner"
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as Glob from "../src/Glob.ts"
import * as Grep from "../src/Grep.ts"
import * as NativeSearch from "../src/NativeSearch.ts"
import * as PortableSearch from "../src/PortableSearch.ts"
import * as Search from "../src/Search.ts"
import * as SearchConformance from "../src/SearchConformance.ts"
import * as StdError from "../src/StdError.ts"

const root = mkdtempSync(join(tmpdir(), "flows-search-conformance-"))
const linkedRoot = join(root, "linked-root")
const unusualNames = ["line\nbreak.txt", "carriage\rreturn.txt", "tab\tname.txt", "éclair.txt", "-leading.txt"]
// Windows cannot create control-character filenames; the protocol case below
// still checks every byte on every host.
const hostNames = process.platform === "win32" ? unusualNames.slice(3) : unusualNames
const file = (relative: string, content: string | Uint8Array): void => {
  const target = join(root, relative)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
}

// A directory the process may not list belongs in its own root: every search
// rooted above it would otherwise depend on the same skip, and a filesystem
// that does not enforce the mode (or a run as root) would hide the case
// instead of failing it.
const deniedRoot = mkdtempSync(join(tmpdir(), "flows-search-denied-"))
const denied = join(deniedRoot, "locked")
mkdirSync(denied, { recursive: true })
writeFileSync(join(denied, "hidden.ts"), "needle denied\n")
writeFileSync(join(deniedRoot, "listed.ts"), "needle denied\n")
chmodSync(denied, 0o000)
const modeEnforced = ((): boolean => {
  try {
    readdirSync(denied)
    return false
  } catch {
    return true
  }
})()

beforeAll(() => {
  file("src/a.ts", "intro\nNeedle one\ncontext after\nneedle two\nend")
  file("src/nested/b.ts", "needle b\nmore")
  file("src/nested/excluded.ts", "needle excluded")
  file("src/z.js", "needle javascript")
  file("src/.secret.ts", "needle secret")
  file("src/.git/objects/object.ts", "needle git")
  file("src/node_modules/pkg/index.ts", "needle dependency")
  file("src/.gitignore", "nested/ignored.ts\n")
  file("src/nested/ignored.ts", "needle ignored\n")
  file("edge/crlf.txt", "foo\r\nbar\r\n")
  file("edge/unicode.txt", "é\n😀\n")
  file("edge/invalid-utf8.txt", new Uint8Array([110, 101, 101, 100, 108, 101, 32, 0xff, 10]))
  file("edge/binary/binary.bin", "needle before\n\0needle after\n")
  file("edge/binary/text.txt", "needle text\n")
  file("edge/long.txt", "x".repeat(600))
  file("edge/symlink-target.txt", "needle symlink target\n")
  symlinkSync(join(root, "edge/symlink-target.txt"), join(root, "edge/symlink.txt"))
  file("literal/metacharacters.txt", "foo?\nfoo\nfo\na+b\nab\nx*y\nxy\n[z]\nz\n?\n")
  file("linked-target/a.ts", "linked root\n")
  symlinkSync(join(root, "linked-target"), linkedRoot, "dir")
  file("max-count/one.txt", "needle one\nneedle two\n")
  file("max-count/two.txt", "needle three\nneedle four\n")
  for (const name of hostNames) file(`weird-names/${name}`, "")
  file("brace-ceiling/a0wm.ts", "")
  file("globs/a.ts", "")
  file("globs/nested/a.ts", "")
  file("globs/nested/deeper/dd.ts", "")
  file("globs/.hidden/h.ts", "")
  file("globs/é.ts", "")
  file("globs/😀.ts", "")
  file(
    "symbols/mod.py",
    "class Widget:\n    def widen(self, value):\n        needle = value\n        return needle\n\n\ndef other():\n    pass\n"
  )
  file("symbols/plain.txt", "needle at top level\n")
  file("budget/many.txt", "one\nneedle a\nthree\nfour\nneedle b\nsix\n")
  file("counted/one.txt", "counted needle\n")
  file("counted/two.txt", "nothing here\n")
  file("counted/three.txt", "nothing here\n")
  file("hostile/present.ts", "needle hostile\n")
  symlinkSync(join(root, "hostile/present.ts"), join(root, "hostile/alias.ts"))
  symlinkSync(join(root, "hostile/absent.ts"), join(root, "hostile/dangling.ts"))
  symlinkSync(join(root, "hostile/cycle-b"), join(root, "hostile/cycle-a"))
  symlinkSync(join(root, "hostile/cycle-a"), join(root, "hostile/cycle-b"))
})

afterAll(() => {
  chmodSync(denied, 0o755)
  rmSync(root, { recursive: true, force: true })
  rmSync(deniedRoot, { recursive: true, force: true })
})

const peers = [
  ["portable", PortableSearch.layer.pipe(Layer.provide(NodeServices.layer))],
  ["native", NativeSearch.layer.pipe(Layer.provide(NodeServices.layer))]
] as const
const portableHost = Layer.merge(NodeFileSystem.layer, NodePath.layer)

const scriptedNative = (options: {
  readonly stdout?: string
  readonly stderr?: string
  readonly exitCode?: number
  readonly commands?: Array<ChildProcess.StandardCommand>
}) => {
  const spawner = ChildProcessSpawner.makeNoop({
    spawn: (command) =>
      Effect.sync(() => {
        options.commands?.push(command as ChildProcess.StandardCommand)
        const stdout = Stream.make(new TextEncoder().encode(options.stdout ?? ""))
        const stderr = Stream.make(new TextEncoder().encode(options.stderr ?? ""))
        return makeHandle({
          pid: ProcessId(1),
          exitCode: Effect.succeed(ExitCode(options.exitCode ?? 0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout,
          stderr,
          all: Stream.concat(stdout, stderr),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void)
        })
      })
  })
  return NativeSearch.layer.pipe(Layer.provide(Layer.mergeAll(
    NodeFileSystem.layer,
    NodePath.layer,
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(spawner)
  )))
}

const failure = <A>(exit: Exit.Exit<A, unknown>): { readonly code: unknown; readonly message: unknown } | undefined => {
  if (!Exit.isFailure(exit)) return undefined
  const reason = exit.cause.reasons.find(Cause.isFailReason)
  if (reason === undefined || typeof reason.error !== "object" || reason.error === null) return undefined
  const record = reason.error as { readonly code?: unknown; readonly message?: unknown }
  return { code: record.code, message: record.message }
}

for (const [peer, implementation] of peers) {
  describe(`Search conformance (${peer})`, () => {
    const grep = (input: typeof Grep.Input.Type) => Effect.runPromise(Effect.provide(Grep.run(input), implementation))
    const glob = (input: typeof Glob.Input.Type) => Effect.runPromise(Effect.provide(Glob.run(input), implementation))

    it("matches with smart case, ordered include/exclude globs, context, and per-file max-count", async () => {
      const result = await grep({
        pattern: "needle",
        root: join(root, "src"),
        smartCase: true,
        globs: ["*.ts", "!excluded.ts"],
        context: 1,
        maxCount: 1
      })
      expect(result).toEqual({
        matches: [
          {
            file: join(root, "src/a.ts"),
            line: 2,
            text: "Needle one",
            before: [{ line: 1, text: "intro" }],
            after: [{ line: 3, text: "context after" }]
          },
          {
            file: join(root, "src/nested/b.ts"),
            line: 1,
            text: "needle b",
            before: [],
            after: [{ line: 2, text: "more" }]
          }
        ],
        files: [],
        filesSearched: 2,
        skippedBinary: 0,
        truncated: false
      })
    })

    it("returns sorted files for --files-with-matches and applies -i", async () => {
      const result = await grep({
        pattern: "NEEDLE",
        root: join(root, "src"),
        ignoreCase: true,
        globs: ["*.ts", "!excluded.ts"],
        filesWithMatches: true
      })
      expect(result.files).toEqual([join(root, "src/a.ts"), join(root, "src/nested/b.ts")])
      expect(result.matches).toEqual([])
    })

    it("keeps fixed strings distinct from the accepted ASCII regex dialect", async () => {
      file("edge/dialect.txt", "abc\na.c\nabbbc\n")
      const literal = await grep({ pattern: "a.c", root: join(root, "edge/dialect.txt"), fixedStrings: true })
      const regex = await grep({ pattern: "^(a.c|ab{3}c)$", root: join(root, "edge/dialect.txt") })
      expect(literal.matches.map((match) => match.line)).toEqual([2])
      expect(regex.matches.map((match) => match.line)).toEqual([1, 2, 3])
    })

    it("treats every fixed-string metacharacter literally, including a bare question mark", async () => {
      const searchRoot = join(root, "literal/metacharacters.txt")
      const cases = [
        ["foo?", [1]],
        ["a+b", [4]],
        ["x*y", [6]],
        ["[z]", [8]],
        ["?", [1, 10]]
      ] as const
      const contents = ["foo?", "foo", "fo", "a+b", "ab", "x*y", "xy", "[z]", "z", "?"]
      for (const [pattern, lines] of cases) {
        const result = await grep({ pattern, root: searchRoot, fixedStrings: true })
        expect(result, pattern).toEqual({
          matches: lines.map((line) => ({
            file: searchRoot,
            line,
            text: contents[line - 1],
            before: [],
            after: []
          })),
          files: [],
          filesSearched: 1,
          skippedBinary: 0,
          truncated: false
        })
      }
    })

    it("aligns CRLF anchors, Unicode scalars, and replacement-decoded non-UTF8 bytes", async () => {
      const crlf = await grep({ pattern: "foo$", root: join(root, "edge/crlf.txt") })
      const unicode = await grep({ pattern: "^.$", root: join(root, "edge/unicode.txt") })
      const invalidUtf8 = await grep({ pattern: "needle", root: join(root, "edge/invalid-utf8.txt") })
      expect(crlf.matches).toEqual([
        { file: join(root, "edge/crlf.txt"), line: 1, text: "foo", before: [], after: [] }
      ])
      expect(unicode.matches.map(({ line, text }) => ({ line, text }))).toEqual([
        { line: 1, text: "é" },
        { line: 2, text: "😀" }
      ])
      expect(invalidUtf8.matches).toEqual([
        { file: join(root, "edge/invalid-utf8.txt"), line: 1, text: "needle �", before: [], after: [] }
      ])
    })

    it("normalizes CRLF match and context previews without retaining carriage returns", async () => {
      const result = await grep({ pattern: "bar", root: join(root, "edge/crlf.txt"), beforeContext: 1 })
      expect(result.matches).toEqual([{
        file: join(root, "edge/crlf.txt"),
        line: 2,
        text: "bar",
        before: [{ line: 1, text: "foo" }],
        after: []
      }])
    })

    it("skips and counts NUL-bearing files and rejects an explicitly named binary root", async () => {
      const directory = await grep({ pattern: "needle", root: join(root, "edge/binary") })
      const explicit = await Effect.runPromise(Effect.exit(Effect.provide(
        Grep.run({ pattern: "absent", root: join(root, "edge/binary/binary.bin") }),
        implementation
      )))
      expect(directory).toEqual({
        matches: [
          { file: join(root, "edge/binary/text.txt"), line: 1, text: "needle text", before: [], after: [] }
        ],
        files: [],
        filesSearched: 2,
        skippedBinary: 1,
        truncated: false
      })
      expect(failure(explicit)?.code).toBe("binary_file")
    })

    it("caps very long lines and does not follow symlinks", async () => {
      const long = await grep({ pattern: "x", root: join(root, "edge/long.txt") })
      const symlink = await grep({ pattern: "needle", root: join(root, "edge"), filesWithMatches: true })
      expect(long.matches[0]?.text.length).toBeLessThanOrEqual(500)
      expect(symlink.files).toContain(join(root, "edge/symlink-target.txt"))
      expect(symlink.files).not.toContain(join(root, "edge/symlink.txt"))
    })

    it("searches a directory symlink when the caller names it as the root", async () => {
      const paths = await glob({ pattern: "*.ts", root: linkedRoot })
      const matches = await grep({ pattern: "linked root", root: linkedRoot, filesWithMatches: true })
      expect(paths.paths).toEqual([join(linkedRoot, "a.ts")])
      expect(matches.files).toEqual([join(linkedRoot, "a.ts")])
    })

    it.skip("streams a file larger than available memory (skipped: a hermetic test cannot exhaust its runner)", () => {})

    it("discloses global truncation and notice semantics", async () => {
      const result = await grep({ pattern: "needle", root: join(root, "src"), globs: ["*.ts"], limit: 1 })
      expect(result).toMatchObject({ truncated: true })
      expect(result.matches).toHaveLength(1)
      expect(result.notice).toBe("Showing 1 of 3 matches; output was truncated.")
    })

    it("treats limit zero as a truncated result with no returned entries", async () => {
      const grepResult = await grep({ pattern: "needle", root: join(root, "src"), globs: ["*.ts"], limit: 0 })
      const globResult = await glob({ pattern: "*.ts", root: join(root, "globs"), limit: 0 })
      expect(grepResult).toMatchObject({ matches: [], files: [], truncated: true })
      expect(grepResult.notice).toBe("Showing 0 of 3 matches; output was truncated.")
      expect(globResult).toMatchObject({ paths: [], total: 5, truncated: true })
      expect(globResult.notice).toBe("Showing 0 of 5 entries; output was truncated.")
    })

    it("combines per-file max-count with files-with-matches", async () => {
      const result = await grep({
        pattern: "needle",
        root: join(root, "max-count"),
        maxCount: 1,
        filesWithMatches: true
      })
      expect(result.matches).toEqual([])
      expect(result.files).toEqual([join(root, "max-count/one.txt"), join(root, "max-count/two.txt")])
    })

    it("keeps hidden search opt-in and fixed skip roots explicit", async () => {
      const hidden = await grep({
        pattern: "needle",
        root: join(root, "src"),
        globs: ["*.ts"],
        hidden: true,
        filesWithMatches: true
      })
      const explicit = await grep({
        pattern: "needle",
        root: join(root, "src/.git"),
        globs: ["*.ts"],
        filesWithMatches: true
      })
      expect(hidden.files).toContain(join(root, "src/.secret.ts"))
      expect(hidden.files).not.toContain(join(root, "src/.git/objects/object.ts"))
      expect(explicit.files).toEqual([join(root, "src/.git/objects/object.ts")])
    })

    it("implements rg --files globs with ordering, braces, hidden, and skip rules", async () => {
      const regular = await glob({ pattern: "**/*.{ts,js}", root: join(root, "src") })
      const hidden = await glob({ pattern: "**/*.ts", root: join(root, "src"), hidden: true })
      const explicit = await glob({ pattern: "**/*.ts", root: join(root, "src/node_modules") })
      expect(regular.paths).toEqual([
        join(root, "src/a.ts"),
        join(root, "src/nested/b.ts"),
        join(root, "src/nested/excluded.ts"),
        join(root, "src/z.js")
      ])
      expect(hidden.paths).toContain(join(root, "src/.secret.ts"))
      expect(hidden.paths).not.toContain(join(root, "src/.git/objects/object.ts"))
      expect(explicit.paths).toEqual([join(root, "src/node_modules/pkg/index.ts")])
    })

    it("preserves legal host filename bytes", async () => {
      const result = await glob({ pattern: "*.txt", root: join(root, "weird-names") })
      expect(result).toEqual({
        paths: hostNames.map((name) => join(root, "weird-names", name)).sort(),
        total: hostNames.length,
        truncated: false
      })
    })

    it("accepts a brace glob at the 256-expansion ceiling", async () => {
      const result = await glob({
        pattern: "{a,b,c,d,e,f,g,h}{0,1,2,3}{w,x,y,z}{m,n}.ts",
        root: join(root, "brace-ceiling")
      })
      expect(result.paths).toEqual([join(root, "brace-ceiling/a0wm.ts")])
    })

    it("implements root-anchored globs and ripgrep's UTF-8 byte width for ?", async () => {
      const anchored = await glob({ pattern: "/a.ts", root: join(root, "globs") })
      const oneByte = await glob({ pattern: "?.ts", root: join(root, "globs") })
      expect(anchored.paths).toEqual([join(root, "globs/a.ts")])
      expect(oneByte.paths).toEqual([
        join(root, "globs/a.ts"),
        join(root, "globs/nested/a.ts")
      ])
    })

    it("matches relative patterns against root-relative paths", async () => {
      const nested = await glob({ pattern: "nested/*.ts", root: join(root, "globs") })
      const fromRoot = await glob({ pattern: "globs/nested/**/*.ts", root })
      const crossing = await glob({ pattern: "globs/**/dd.ts", root })
      const alternatives = await glob({ pattern: "{globs,src}/nested/*.ts", root })
      expect(nested.paths).toEqual([join(root, "globs/nested/a.ts")])
      expect(fromRoot.paths).toEqual([
        join(root, "globs/nested/a.ts"),
        join(root, "globs/nested/deeper/dd.ts")
      ])
      expect(crossing.paths).toEqual([join(root, "globs/nested/deeper/dd.ts")])
      expect(alternatives.paths).toEqual([
        join(root, "globs/nested/a.ts"),
        join(root, "src/nested/b.ts"),
        join(root, "src/nested/excluded.ts")
      ])
    })

    it("reads a leading / or ./ as the root anchor, not as a filesystem path", async () => {
      const relative = await glob({ pattern: "nested/a.ts", root: join(root, "globs") })
      const anchored = await glob({ pattern: "/nested/a.ts", root: join(root, "globs") })
      const dotted = await glob({ pattern: "./nested/a.ts", root: join(root, "globs") })
      const interior = await glob({ pattern: "nested/./a.ts", root: join(root, "globs") })
      const basename = await glob({ pattern: "a.ts", root: join(root, "globs") })
      expect(anchored.paths).toEqual(relative.paths)
      expect(dotted.paths).toEqual(relative.paths)
      expect(interior.paths).toEqual(relative.paths)
      expect(basename.paths).toEqual([join(root, "globs/a.ts"), join(root, "globs/nested/a.ts")])
    })

    it("separates a pattern that found nothing from one that could never match", async () => {
      const searched = await glob({ pattern: "globs/**/*.rs", root })
      const absolute = await glob({ pattern: `${join(root, "globs")}/**/*.ts`, root: join(root, "globs") })
      const missing = await glob({ pattern: "missing/**/*.ts", root: join(root, "globs") })
      const skipped = await glob({ pattern: "node_modules/**/*.ts", root: join(root, "src") })
      const hidden = await glob({ pattern: ".hidden/*.ts", root: join(root, "globs") })
      const included = await glob({ pattern: ".hidden/*.ts", root: join(root, "globs"), hidden: true })
      const partial = await glob({ pattern: "{missing,nested}/*.rs", root: join(root, "globs") })
      expect(searched).toEqual({ paths: [], total: 0, truncated: false })
      expect(partial).toEqual({ paths: [], total: 0, truncated: false })
      expect(absolute.notice).toBe(
        `No file under ${join(root, "globs")} can match "${
          join(root, "globs")
        }/**/*.ts": glob patterns are relative to the search root, so use "**/*.ts" instead.`
      )
      expect(missing.notice).toBe(
        `No file under ${join(root, "globs")} can match "missing/**/*.ts": there is no missing directory there.`
      )
      expect(skipped.notice).toBe(
        `No file under ${join(root, "src")} can match "node_modules/**/*.ts": node_modules is never descended into; ` +
          "name it as the search root to look inside it."
      )
      expect(hidden.notice).toBe(
        `No file under ${
          join(root, "globs")
        } can match ".hidden/*.ts": hidden paths are excluded unless hidden is true.`
      )
      expect(included.paths).toEqual([join(root, "globs/.hidden/h.ts")])
    })

    it("reads grep globs by the same rules and reports the unsatisfiable ones", async () => {
      const nested = await grep({
        pattern: "needle",
        root,
        globs: ["src/nested/*.ts", "!**/excluded.ts"],
        filesWithMatches: true
      })
      const searched = await grep({ pattern: "definitely absent", root: join(root, "src"), globs: ["*.ts"] })
      const absolute = await grep({ pattern: "needle", root: join(root, "src"), globs: [`${join(root, "src")}/*.ts`] })
      const exclusionOnly = await grep({ pattern: "definitely absent", root: join(root, "src"), globs: ["!missing/*"] })
      const several = await grep({ pattern: "needle", root: join(root, "src"), globs: ["missing/*.ts", "gone/*.ts"] })
      expect(nested.files).toEqual([join(root, "src/nested/b.ts")])
      expect(several.notice).toBe(
        `No file under ${join(root, "src")} can match "missing/*.ts": there is no missing directory there. ` +
          `No file under ${join(root, "src")} can match "gone/*.ts": there is no gone directory there.`
      )
      expect(searched.notice).toContain("noIgnore: true")
      expect(absolute).toMatchObject({ matches: [], files: [] })
      expect(absolute.notice).toBe(
        `No file under ${join(root, "src")} can match "${
          join(root, "src")
        }/*.ts": glob patterns are relative to the search root, so use "*.ts" instead.`
      )
      expect(exclusionOnly.notice).toContain("noIgnore: true")
    })

    it("searches a root that names one file whatever the globs say", async () => {
      const matching = await grep({
        pattern: "needle",
        root: join(root, "src/a.ts"),
        globs: ["*.ts"],
        filesWithMatches: true
      })
      const mismatching = await grep({
        pattern: "needle",
        root: join(root, "src/a.ts"),
        globs: ["missing/*.js"],
        filesWithMatches: true
      })
      const empty = await grep({ pattern: "definitely absent", root: join(root, "src/a.ts"), globs: ["missing/*.js"] })
      const listed = await glob({ pattern: "*.js", root: join(root, "src/a.ts") })
      const linked = await grep({ pattern: "hostile", root: join(root, "hostile/alias.ts"), filesWithMatches: true })
      expect(matching.files).toEqual([join(root, "src/a.ts")])
      expect(mismatching.files).toEqual([join(root, "src/a.ts")])
      expect(mismatching.notice).toBeUndefined()
      expect(empty).toEqual({ matches: [], files: [], filesSearched: 1, skippedBinary: 0, truncated: false })
      expect(listed.paths).toEqual([join(root, "src/a.ts")])
      expect(linked.files).toEqual([join(root, "hostile/alias.ts")])
    })

    it("counts every file the search covered, not only the files that matched", async () => {
      const found = await grep({ pattern: "counted needle", root: join(root, "counted") })
      const absent = await grep({ pattern: "definitely absent", root: join(root, "counted") })
      expect(found).toMatchObject({ filesSearched: 3, skippedBinary: 0, matches: [{ line: 1 }] })
      expect(absent).toMatchObject({ filesSearched: 3, matches: [], truncated: false })
    })

    it("walks past dangling links and link cycles instead of failing the search", async () => {
      const paths = await glob({ pattern: "*.ts", root: join(root, "hostile") })
      const matches = await grep({ pattern: "hostile", root: join(root, "hostile"), filesWithMatches: true })
      expect(paths.paths).toEqual([join(root, "hostile/present.ts")])
      expect(matches).toMatchObject({ files: [join(root, "hostile/present.ts")], filesSearched: 1 })
    })

    it.skipIf(!modeEnforced)("walks past a directory it may not list", async () => {
      const paths = await glob({ pattern: "**/*.ts", root: deniedRoot })
      const matches = await grep({ pattern: "denied", root: deniedRoot, filesWithMatches: true })
      expect(paths.paths).toEqual([join(deniedRoot, "listed.ts")])
      expect(matches).toMatchObject({ files: [join(deniedRoot, "listed.ts")], filesSearched: 1 })
    })

    it("drops a glob's trailing spaces as rg does and rejects what that leaves blank", async () => {
      const padded = await glob({ pattern: "a.ts ", root: join(root, "globs") })
      const anchored = await glob({ pattern: "/nested/a.ts  ", root: join(root, "globs") })
      const blank = await Effect.runPromise(Effect.exit(Effect.provide(
        Glob.run({ pattern: "  ", root }),
        implementation
      )))
      const noMatchWanted = await Effect.runPromise(Effect.exit(Effect.provide(
        Grep.run({ pattern: "needle", root: join(root, "src"), maxCount: 0 }),
        implementation
      )))
      expect(padded.paths).toEqual([join(root, "globs/a.ts"), join(root, "globs/nested/a.ts")])
      expect(anchored.paths).toEqual([join(root, "globs/nested/a.ts")])
      expect(failure(blank)).toEqual({
        code: "invalid_pattern",
        message: "Unsupported ripgrep pattern \"  \": glob patterns must not be empty"
      })
      expect(failure(noMatchWanted)).toEqual({
        code: "invalid_input",
        message: "Invalid ripgrep options: --max-count must be at least 1"
      })
    })

    it("spends the limit on matches and never drops a hit to fit its context", async () => {
      const clipped = await grep({ pattern: "needle", root: join(root, "budget"), context: 2, limit: 1 })
      const whole = await grep({ pattern: "needle", root: join(root, "budget"), context: 2 })
      expect(clipped.matches).toEqual([{
        file: join(root, "budget/many.txt"),
        line: 2,
        text: "needle a",
        before: [{ line: 1, text: "one" }],
        after: [{ line: 3, text: "three" }]
      }])
      expect(clipped.truncated).toBe(true)
      expect(clipped.notice).toBe("Showing 1 of 2 matches; output was truncated.")
      expect(whole.matches.map((match) => match.line)).toEqual([2, 5])
      // Every context line the search selected belongs to exactly one hit.
      expect(whole.matches.flatMap((match) => [...match.before, ...match.after].map((line) => line.line)))
        .toEqual([1, 3, 4, 6])
    })

    it("reports the definition a hit sits in, and omits it on request", async () => {
      const python = await grep({ pattern: "needle", root: join(root, "symbols"), globs: ["*.py"] })
      const topLevel = await grep({ pattern: "needle", root: join(root, "symbols"), globs: ["*.txt"] })
      const without = await grep({ pattern: "needle", root: join(root, "symbols"), globs: ["*.py"], symbols: false })
      expect(python.matches[0]?.symbol).toEqual({ kind: "def", name: "widen", startLine: 2, endLine: 4 })
      expect(topLevel.matches[0]?.symbol).toBeUndefined()
      expect(without.matches[0]?.symbol).toBeUndefined()
    })

    it("retries a metacharacter pattern as a literal and flags that it did", async () => {
      const retried = await grep({ pattern: "widen(self, value)", root: join(root, "symbols"), globs: ["*.py"] })
      const absent = await grep({ pattern: "absent(x)", root: join(root, "symbols") })
      expect(retried.matches.map((match) => match.line)).toEqual([2])
      expect(retried.retriedAsLiteral).toBe(true)
      expect(retried.notice).toContain("fixedStrings: true")
      expect(absent.matches).toEqual([])
      expect(absent.retriedAsLiteral).toBeUndefined()
    })

    it("returns clean empty results and a typed missing-root failure", async () => {
      const empty = await grep({ pattern: "definitely absent", root: join(root, "src") })
      const missing = await Effect.runPromise(Effect.exit(Effect.provide(
        Grep.run({ pattern: "needle", root: join(root, "missing") }),
        implementation
      )))
      expect(empty).toMatchObject({ matches: [], files: [], truncated: false })
      expect(failure(missing)?.code).toBe("not_found")
    })

    it("rejects every option outside the declared subset with typed errors", async () => {
      const unsupported = await Effect.runPromise(Effect.exit(Effect.provide(
        Grep.run({ pattern: "(?=needle)", root }),
        implementation
      )))
      const emptyExclusion = await Effect.runPromise(Effect.exit(Effect.provide(
        Glob.run({ pattern: "!", root }),
        implementation
      )))
      const oversizedRepetition = await Effect.runPromise(Effect.exit(Effect.provide(
        Grep.run({ pattern: "a{10000000}", root }),
        implementation
      )))
      expect(failure(unsupported)).toEqual({
        code: "invalid_pattern",
        message: "Unsupported ripgrep pattern \"(?=needle)\": special groups and lookaround are not supported"
      })
      expect(failure(emptyExclusion)?.code).toBe("invalid_pattern")
      expect(failure(oversizedRepetition)?.code).toBe("invalid_pattern")
    })
  })
}

it("the in-process peer answers without an rg process service", async () => {
  const result = await Effect.runPromise(Effect.provide(
    Grep.run({ pattern: "needle", root: join(root, "src"), fixedStrings: true, globs: ["*.ts"] }),
    PortableSearch.layer.pipe(Layer.provide(portableHost))
  ))
  expect(result.matches.length).toBeGreaterThan(0)
})

it("both peers reject unsupported regex syntax identically", async () => {
  const exits = await Promise.all(
    peers.map(([, implementation]) =>
      Effect.runPromise(Effect.exit(Effect.provide(Grep.run({ pattern: "(a)\\1", root }), implementation)))
    )
  )
  const portable = exits[0]
  const native = exits[1]
  expect(portable).toBeDefined()
  expect(native).toBeDefined()
  if (portable === undefined || native === undefined) return
  expect(failure(portable)).toEqual(failure(native))
})

it("the native peer turns absence, non-zero exits, and malformed JSON into typed failures", async () => {
  const unavailable = NativeSearch.layer.pipe(Layer.provide(Layer.mergeAll(
    NodeFileSystem.layer,
    NodePath.layer,
    ChildProcessSpawner.layerNoop()
  )))
  const cases = [
    [unavailable, "provider_unavailable"],
    [scriptedNative({ stderr: "killed", exitCode: 137 }), "request_failed"],
    [scriptedNative({ stdout: "{}\n" }), "request_failed"]
  ] as const
  for (const [implementation, code] of cases) {
    const exit = await Effect.runPromise(Effect.exit(Effect.provide(
      Grep.run({ pattern: "needle", root: join(root, "src") }),
      implementation
    )))
    expect(failure(exit)?.code).toBe(code)
  }
})

it.each([false, true])("the native peer confines rg configuration with noIgnore=%s", async (noIgnore) => {
  const commands: Array<ChildProcess.StandardCommand> = []
  const summary = JSON.stringify({ type: "summary", data: { stats: { searches: 0 } } })
  await Effect.runPromise(Effect.provide(
    Grep.run({ pattern: "absent", root: join(root, "src"), noIgnore }),
    scriptedNative({ stdout: `${summary}\n`, commands })
  ))
  expect(commands).toHaveLength(2)
  expect(commands.every((command) => command.command === "rg")).toBe(true)
  expect(commands.every((command) => command.options.cwd === join(root, "src"))).toBe(true)
  for (const command of commands) {
    expect(command.args.includes("--no-ignore")).toBe(noIgnore)
    for (
      const flag of [
        "--no-config",
        "--no-require-git",
        "--no-ignore-global",
        "--no-ignore-parent",
        "--no-ignore-exclude",
        "--no-ignore-dot"
      ]
    ) {
      expect(command.args).toContain(flag)
    }
  }
})

it("the native peer preserves control characters in NUL-delimited filename records", async () => {
  const searchRoot = join(root, "weird-names")
  const listed = await Effect.runPromise(Effect.provide(
    Glob.run({ pattern: "*.txt", root: searchRoot }),
    scriptedNative({ stdout: `${unusualNames.join("\0")}\0` })
  ))
  expect(listed).toEqual({
    paths: unusualNames.map((name) => join(searchRoot, name)).sort(),
    total: unusualNames.length,
    truncated: false
  })
})

it("the native peer keeps what rg produced when it only skipped what it could not read", async () => {
  const summary = JSON.stringify({ type: "summary", data: { stats: { searches: 0 } } })
  const tolerated = await Effect.runPromise(Effect.provide(
    Grep.run({ pattern: "absent", root: join(root, "src") }),
    scriptedNative({ stdout: `${summary}\n`, exitCode: 2 })
  ))
  const listed = await Effect.runPromise(Effect.provide(
    Glob.run({ pattern: "*.ts", root: join(root, "src") }),
    scriptedNative({ stdout: "a.ts\0", exitCode: 2 })
  ))
  const rejected = await Effect.runPromise(Effect.exit(Effect.provide(
    Glob.run({ pattern: "*.ts", root: join(root, "src") }),
    scriptedNative({ stderr: "rg: error parsing glob", exitCode: 2 })
  )))
  expect(tolerated).toMatchObject({ matches: [], files: [] })
  expect(listed.paths).toEqual([join(root, "src/a.ts")])
  expect(failure(rejected)).toEqual({ code: "invalid_pattern", message: "rg: error parsing glob" })
})

// The table above pins the divergences somebody already found: `?` under
// fixedStrings, a newline in a filename, a symlinked root. Each of those was
// invisible until a person thought of it. This is the other half of std-20 —
// a generated tree and a generated batch of calls, run through both peers,
// asserting they answered byte for byte alike. The generator stays inside the
// ground both peers claim to share (no symlinks, no CRLF, no unreadable
// directories, no NUL bytes), because outside it a difference is a documented
// choice rather than a drift.
//
// Seeds are fixed rather than random: a suite that fails on a different input
// every run cannot be bisected, and a seed that ever finds something belongs
// in the list permanently.
describe("Search conformance (generated)", () => {
  // Seeds 1, 2, 21 and 34 caught `rg` reporting more matches than `maxCount`
  // when an after-context line matched too; seeds 4, 40, 51, 103 and 118
  // caught `--smart-case` overriding `--ignore-case` in the native peer only.
  // Both were fixed in `NativeSearch`; the seeds stay so neither can return.
  // A 120-seed sweep over the same generator is clean, and takes two and a
  // half minutes, which is why twelve of them live here instead.
  const seeds = [1, 2, 4, 21, 34, 40, 51, 89, 103, 118, 144, 233]
  const generatedRoot = mkdtempSync(join(tmpdir(), "flows-search-generated-"))

  afterAll(() => {
    rmSync(generatedRoot, { recursive: true, force: true })
  })

  it.each(seeds)("answers every generated call alike on both peers (seed %i)", async (seed) => {
    const treeRoot = join(generatedRoot, `seed-${seed}`)
    const plan = SearchConformance.plan({ seed, root: treeRoot })

    const divergences = await Effect.runPromise(
      Effect.gen(function*() {
        yield* SearchConformance.materialize(plan)
        const portable = yield* Effect.provide(Search.Search, PortableSearch.layer)
        const native = yield* Effect.provide(Search.Search, NativeSearch.layer)
        return yield* SearchConformance.compare({ plan, subject: native, reference: portable })
      }).pipe(Effect.provide(NodeServices.layer))
    )

    expect(SearchConformance.report(divergences)).toBe("")
    expect(divergences).toEqual([])
  })
})

describe("Search conformance (regression detector)", () => {
  const generated = SearchConformance.plan({ seed: 1, root: "/tiny", files: 0, calls: 1 })
  const grepInput = generated.grep[0]!
  const globInput = generated.glob[0]!
  const plan = { ...generated, grep: [grepInput], glob: [globInput] }
  const grepValue: Search.GrepOutput = {
    matches: [],
    files: [],
    filesSearched: 1,
    skippedBinary: 0,
    truncated: false
  }
  const globValue: Search.GlobOutput = { paths: ["/tiny/a"], total: 1, truncated: false }
  const refused = (code: StdError.Code, message = "refused") => Effect.fail(new StdError.StdError({ code, message }))
  const peer = (
    grep: Effect.Effect<Search.GrepOutput, StdError.StdError>,
    glob: Effect.Effect<Search.GlobOutput, StdError.StdError>
  ) => Search.make({ grep: () => grep, glob: () => glob })

  it("detects exact grep and glob value divergences", async () => {
    const otherGrep = { ...grepValue, filesSearched: 2 }
    const otherGlob = { paths: ["/tiny/b"], total: 1, truncated: false }
    const differences = await Effect.runPromise(SearchConformance.compare({
      plan,
      subject: peer(Effect.succeed(grepValue), Effect.succeed(globValue)),
      reference: peer(Effect.succeed(otherGrep), Effect.succeed(otherGlob))
    }))
    expect(differences).toEqual([
      { call: "grep", input: grepInput, subject: JSON.stringify(grepValue), reference: JSON.stringify(otherGrep) },
      { call: "glob", input: globInput, subject: JSON.stringify(globValue), reference: JSON.stringify(otherGlob) }
    ])
    expect(SearchConformance.report(differences)).toBe(
      `grep(${JSON.stringify(grepInput)})\n  subject:   ${JSON.stringify(grepValue)}\n  reference: ${
        JSON.stringify(otherGrep)
      }` +
        `\n\nglob(${JSON.stringify(globInput)})\n  subject:   ${JSON.stringify(globValue)}\n  reference: ${
          JSON.stringify(otherGlob)
        }`
    )
  })

  it("detects successes versus refusals in either direction", async () => {
    const differences = await Effect.runPromise(SearchConformance.compare({
      plan,
      subject: peer(Effect.succeed(grepValue), refused("not_found")),
      reference: peer(refused("invalid_pattern"), Effect.succeed(globValue))
    }))
    expect(differences).toEqual([
      {
        call: "grep",
        input: grepInput,
        subject: JSON.stringify(grepValue),
        reference: "{\"failure\":\"invalid_pattern\"}"
      },
      { call: "glob", input: globInput, subject: "{\"failure\":\"not_found\"}", reference: JSON.stringify(globValue) }
    ])
    expect(SearchConformance.report(differences)).toBe(
      `grep(${JSON.stringify(grepInput)})\n  subject:   ${
        JSON.stringify(grepValue)
      }\n  reference: {"failure":"invalid_pattern"}` +
        `\n\nglob(${JSON.stringify(globInput)})\n  subject:   {"failure":"not_found"}\n  reference: ${
          JSON.stringify(globValue)
        }`
    )
  })

  it("detects differing refusal codes for both operations", async () => {
    const differences = await Effect.runPromise(SearchConformance.compare({
      plan,
      subject: peer(refused("invalid_pattern"), refused("not_found")),
      reference: peer(refused("not_found"), refused("invalid_pattern"))
    }))
    expect(differences).toEqual([
      {
        call: "grep",
        input: grepInput,
        subject: "{\"failure\":\"invalid_pattern\"}",
        reference: "{\"failure\":\"not_found\"}"
      },
      {
        call: "glob",
        input: globInput,
        subject: "{\"failure\":\"not_found\"}",
        reference: "{\"failure\":\"invalid_pattern\"}"
      }
    ])
    expect(SearchConformance.report(differences)).toBe(
      `grep(${
        JSON.stringify(grepInput)
      })\n  subject:   {"failure":"invalid_pattern"}\n  reference: {"failure":"not_found"}` +
        `\n\nglob(${
          JSON.stringify(globInput)
        })\n  subject:   {"failure":"not_found"}\n  reference: {"failure":"invalid_pattern"}`
    )
  })

  it("agrees on matching refusals even when messages differ", async () => {
    const differences = await Effect.runPromise(SearchConformance.compare({
      plan,
      subject: peer(refused("invalid_pattern", "subject"), refused("not_found", "subject")),
      reference: peer(refused("invalid_pattern", "reference"), refused("not_found", "reference"))
    }))
    expect(differences).toEqual([])
    expect(SearchConformance.report(differences)).toBe("")
  })
})
