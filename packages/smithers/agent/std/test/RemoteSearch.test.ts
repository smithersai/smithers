/**
 * `RemoteSearch` answers exactly what `PortableSearch` answers.
 *
 * The peer brings a machine's tree back in two shell round trips and lets the
 * in-process peer search the copy, so its whole contract is "the same answer,
 * from somewhere else". Here the machine is this host, reached through its own
 * shell, which makes every case a direct comparison against `PortableSearch`
 * reading the same tree through `NodeFileSystem`: the hand-picked edges a
 * listing could lose (ignore files, hidden and skipped names, links, unusual
 * names, unreadable entries, explicit roots) and the generated conformance
 * plans. The cases after them pin how the peer reports a machine that cannot
 * answer.
 */
import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node"
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as Rooted from "@smthrs/kernel/Rooted"
import { Context, Effect, FileSystem, Layer, Path } from "effect"
import { execFileSync } from "node:child_process"
import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as PortableSearch from "../src/PortableSearch.ts"
import * as RemoteSearch from "../src/RemoteSearch.ts"
import type * as Search from "../src/Search.ts"
import * as SearchConformance from "../src/SearchConformance.ts"
import type * as StdError from "../src/StdError.ts"

const root = realpathSync(mkdtempSync(join(tmpdir(), "flows-remote-search-")))
afterAll(() => {
  chmodSync(join(root, "tree/locked"), 0o755)
  rmSync(root, { recursive: true, force: true })
})

const isRoot = process.getuid?.() === 0
const tree = join(root, "tree")

const file = (relative: string, content: string | Uint8Array, mode?: number): void => {
  const target = join(tree, relative)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content, mode === undefined ? {} : { mode })
}

beforeAll(() => {
  file("src/a.ts", "intro\nNeedle one\ncontext after\nneedle two\nend\n")
  file("src/nested/b.ts", "needle b\nmore\n")
  file("src/.gitignore", "nested/ignored.ts\n*.log\n")
  file("src/nested/ignored.ts", "needle ignored\n")
  file("src/build.log", "needle log\n")
  file("src/.hidden.ts", "needle hidden\n")
  file("src/.git/HEAD", "needle git\n")
  file("src/node_modules/pkg/index.ts", "needle dependency\n")
  file("edge/crlf.txt", "needle\r\nbar\r\n")
  file("edge/unicode.txt", "naïve needle ü 日本語 🎉\n")
  file("edge/invalid-utf8.txt", new Uint8Array([110, 101, 101, 100, 108, 101, 32, 0xff, 10]))
  file("edge/binary.bin", "needle before\n\0needle after\n")
  file(process.platform === "win32" ? "edge/line 'break.txt" : "edge/line\nbreak.txt", "needle in an odd name\n")
  file("edge/-leading.txt", "needle leading dash\n")
  file("edge/empty.txt", "")
  file("hardlinks/a.txt", "needle hard link\n")
  linkSync(join(tree, "hardlinks/a.txt"), join(tree, "hardlinks/b.txt"))
  file("edge/target.txt", "needle through a link\n")
  symlinkSync(join(tree, "edge/target.txt"), join(tree, "edge/link.txt"))
  symlinkSync(join(tree, "edge"), join(tree, "edge-link"), "dir")
  symlinkSync(join(tree, "absent"), join(tree, "edge/dangling.txt"))
  file("long/".concat("d".repeat(120), "/", "f".repeat(120), ".txt"), "needle far away\n")
  file("locked/unreadable.txt", "needle unreadable\n", 0o000)
  chmodSync(join(tree, "locked"), 0o555)
})

const platform = Layer.provideMerge(NodeChildProcessSpawner.layer, Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))

/** `PortableSearch` over this host's files and `RemoteSearch` through its shell, both rooted at `at`. */
const peersAt = (at: string) =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const rooted = Rooted.path(path, at)
    return {
      reference: PortableSearch.make(
        Context.make(FileSystem.FileSystem, Rooted.fileSystem(fileSystem, rooted)).pipe(Context.add(Path.Path, rooted))
      ),
      subject: RemoteSearch.make(
        Context.make(ChildProcessSpawner.ChildProcessSpawner, spawner).pipe(Context.add(Path.Path, rooted))
      )
    }
  })

const grep = (input: Partial<Search.GrepInput> & { readonly pattern: string }): Search.GrepInput => ({
  root: ".",
  fixedStrings: false,
  ignoreCase: false,
  smartCase: false,
  globs: [],
  beforeContext: 0,
  afterContext: 0,
  filesWithMatches: false,
  hidden: false,
  noIgnore: false,
  symbols: true,
  limit: 200,
  ...input
})

const glob = (input: Partial<Search.GlobInput> & { readonly pattern: string }): Search.GlobInput => ({
  root: ".",
  hidden: false,
  noIgnore: false,
  limit: 200,
  ...input
})

const agree = (
  calls: { readonly grep?: ReadonlyArray<Search.GrepInput>; readonly glob?: ReadonlyArray<Search.GlobInput> }
) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const { reference, subject } = yield* peersAt(tree)
      return yield* SearchConformance.compare({
        plan: { seed: 0, root: tree, files: [], grep: calls.grep ?? [], glob: calls.glob ?? [] },
        subject,
        reference
      })
    }).pipe(Effect.provide(platform))
  )

describe("RemoteSearch against PortableSearch on the same tree", () => {
  it("answers every hand-picked edge alike", async () => {
    const divergences = await agree({
      grep: [
        grep({ pattern: "needle" }),
        grep({ pattern: "needle", hidden: true }),
        grep({ pattern: "needle", noIgnore: true }),
        grep({ pattern: "needle", hidden: true, noIgnore: true, filesWithMatches: true }),
        grep({ pattern: "Needle", ignoreCase: true, beforeContext: 1, afterContext: 1 }),
        grep({ pattern: "needle", root: "src", globs: ["*.ts", "!b.ts"] }),
        grep({ pattern: "needle", root: "edge/link.txt" }),
        grep({ pattern: "needle", root: "edge-link" }),
        grep({ pattern: "needle", root: `${tree}/edge/unicode.txt` }),
        grep({ pattern: "needle", root: "edge/binary.bin" }),
        grep({ pattern: "needle", root: "missing" }),
        grep({ pattern: "needle", root: "src", globs: ["nested/ignored.ts"] }),
        grep({ pattern: "needle", root: "src", globs: ["absent/**"] }),
        grep({ pattern: "日本語", fixedStrings: true }),
        grep({ pattern: "needle", maxCount: 1, limit: 3 }),
        grep({ pattern: "a(", fixedStrings: true }),
        grep({ pattern: "zzz-not-there" })
      ],
      glob: [
        glob({ pattern: "**/*.txt" }),
        glob({ pattern: "**/*", hidden: true, noIgnore: true }),
        glob({ pattern: "*.log", root: "src" }),
        glob({ pattern: "**/*.ts", root: "missing" }),
        glob({ pattern: "absent/**" })
      ]
    })
    expect(SearchConformance.report(divergences)).toBe("")
  }, 60_000)

  it("searches every hard-linked name from a real tar archive", async () => {
    const divergences = await agree({
      grep: [
        grep({ pattern: "needle", root: "hardlinks" }),
        grep({ pattern: "needle", root: "hardlinks", filesWithMatches: true })
      ]
    })
    expect(SearchConformance.report(divergences)).toBe("")
  })

  it.skipIf(isRoot)("skips an unreadable file and reports an unreadable root as the walk does", async () => {
    const divergences = await agree({
      grep: [grep({ pattern: "needle", root: "locked" }), grep({ pattern: "needle", root: "locked/unreadable.txt" })]
    })
    expect(SearchConformance.report(divergences)).toBe("")
  }, 30_000)

  it.each([1, 2, 4, 21, 40, 103])("answers every generated call alike (seed %i)", async (seed) => {
    const plan = SearchConformance.plan({ seed, root: join(root, `seed-${seed}`) })
    const divergences = await Effect.runPromise(
      Effect.gen(function*() {
        yield* SearchConformance.materialize(plan)
        return yield* SearchConformance.compare({ plan, ...yield* peersAt(plan.root) })
      }).pipe(Effect.provide(platform))
    )
    expect(SearchConformance.report(divergences)).toBe("")
  }, 60_000)
})

describe("RemoteSearch when the machine cannot answer", () => {
  const spare = join(root, "spare")
  const tools = (name: string, scripts: Record<string, string>): string => {
    const bin = join(root, `bin-${name}`)
    mkdirSync(bin, { recursive: true })
    for (const [tool, script] of Object.entries(scripts)) {
      writeFileSync(join(bin, tool), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
    }
    return bin
  }
  const realTar = execFileSync("sh", ["-c", "command -v tar"], { encoding: "utf8" }).trim()
  const realBase64 = execFileSync("sh", ["-c", "command -v base64"], { encoding: "utf8" }).trim()
  /** A `base64` that decodes the program as usual and answers its output with `encoded`. */
  const encodes = (encoded: string) => `if [ "$1" = -d ]; then exec ${realBase64} -d; fi\n${encoded}`
  const hostPath = process.env.PATH

  /** One search under `PATH`, or with the subject's spawner replaced. */
  const searched = async (
    call: (search: Search.Search) => Effect.Effect<unknown, StdError.StdError>,
    options: {
      readonly path?: string
      readonly spawner?: ChildProcessSpawner.ChildProcessSpawner["Service"]
      readonly maxBytes?: number
    } = {}
  ) => {
    process.env.PATH = options.path ?? hostPath
    try {
      return await Effect.runPromise(
        Effect.gen(function*() {
          const path = yield* Path.Path
          const spawner = options.spawner ?? (yield* ChildProcessSpawner.ChildProcessSpawner)
          const search = RemoteSearch.make(
            Context.make(ChildProcessSpawner.ChildProcessSpawner, spawner).pipe(
              Context.add(Path.Path, Rooted.path(path, spare))
            ),
            { maxBytes: options.maxBytes }
          )
          return yield* Effect.match(call(search), {
            onSuccess: (value) => ({ value }),
            onFailure: (error) => ({ code: error.code, message: error.message })
          })
        }).pipe(Effect.provide(platform))
      )
    } finally {
      process.env.PATH = hostPath
    }
  }

  beforeAll(() => {
    mkdirSync(join(spare, "empty"), { recursive: true })
    writeFileSync(join(spare, "big.txt"), "needle and more than eight bytes\n")
    symlinkSync("/bin/sh", join(tools("bare", {}), "sh"))
    symlinkSync("/bin/sh", join(tools("encoding", { base64: `exec ${realBase64} "$@"` }), "sh"))
  })

  it("names the tool the machine lacks", async () => {
    const glob_ = (search: Search.Search) => search.glob(glob({ pattern: "*" }))
    expect(await searched(glob_, { path: join(root, "bin-bare") })).toEqual({
      code: "command_failed",
      message: "Could not search . on this machine: searching this machine needs base64, which it does not have"
    })
    expect(await searched(glob_, { path: join(root, "bin-encoding") })).toEqual({
      code: "command_failed",
      message: "Could not search . on this machine: searching this machine needs find, which it does not have"
    })
  })

  it("refuses output that is not base64, a listing that is not records, and files that are not tar", async () => {
    const garbage = tools("garbage", { base64: encodes("printf '%s' '*not base64*'") })
    const shapeless = tools("shapeless", { base64: encodes("printf '%s' YWJj") })
    const corrupt = tools("corrupt", {
      tar: `if [ "$1" = -chf ]; then head -c 512 /dev/zero | tr '\\0' 1; else exec ${realTar} "$@"; fi`
    })
    const mute = tools("mute", { tar: `if [ "$1" = -chf ]; then exit 2; else exec ${realTar} "$@"; fi` })
    const silent = tools("silent", { base64: encodes("exit 1") })
    const glob_ = (search: Search.Search) => search.glob(glob({ pattern: "*" }))
    expect(await searched(glob_, { path: `${garbage}:${hostPath}` })).toMatchObject({
      message: "Could not search . on this machine: the machine answered with invalid base64"
    })
    expect(await searched(glob_, { path: `${shapeless}:${hostPath}` })).toMatchObject({
      message: "Could not search . on this machine: the listing came back malformed"
    })
    for (const bin of [corrupt, mute]) {
      expect(await searched((search) => search.grep(grep({ pattern: "needle" })), { path: `${bin}:${hostPath}` }))
        .toMatchObject({ message: "Could not search . on this machine: the files came back malformed" })
    }
    expect(await searched(glob_, { path: `${silent}:${hostPath}` })).toMatchObject({
      message: "Could not search . on this machine: exit 1"
    })
  })

  it("refuses more file content than its bound, naming the root to narrow", async () => {
    expect(await searched((search) => search.grep(grep({ pattern: "needle" })), { maxBytes: 8 })).toEqual({
      code: "response_too_large",
      message: "The files under . come to more than 8 bytes; narrow the root or the globs"
    })
  })

  it("fetches nothing for a root with nothing to read", async () => {
    expect(await searched((search) => search.grep(grep({ pattern: "needle", root: "empty" })), { maxBytes: 8 }))
      .toEqual({ value: { matches: [], files: [], filesSearched: 0, skippedBinary: 0, truncated: false } })
  })

  it("says the machine could not be reached when its spawner cannot start a process", async () => {
    const answer = await searched((search) => search.glob(glob({ pattern: "*" })), {
      spawner: ChildProcessSpawner.makeNoop()
    })
    expect(answer).toMatchObject({ code: "command_failed" })
    expect((answer as { message: string }).message).toContain("Could not search . on this machine: exec: sh")
  })
})
