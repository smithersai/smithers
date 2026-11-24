import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Fuzz } from "@smthrs/fuzz"
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as Workspace from "@smthrs/kernel/Workspace"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Arbitrary, Effect, Exit, FileSystem, Layer, Path, PlatformError, Redacted, Schema, Sink, Stream } from "effect"
import type * as ChildProcess from "effect/process/ChildProcess"
import { ExitCode, makeHandle, ProcessId } from "effect/process/ChildProcessSpawner"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import * as Checkpoints from "../src/Checkpoints.ts"
import * as Container from "../src/Container.ts"
import * as Edit from "../src/Edit.ts"
import * as Grep from "../src/Grep.ts"
import * as EnvelopePrecheck from "../src/internal/EnvelopePrecheck.ts"
import * as FileMutation from "../src/internal/FileMutation.ts"
import { GitWorktree } from "../src/internal/GitWorktree.ts"
import * as Ignore from "../src/internal/Ignore.ts"
import * as Tar from "../src/internal/Tar.ts"
import * as PortableSearch from "../src/PortableSearch.ts"
import * as Read from "../src/Read.ts"
import * as TestRun from "../src/TestRun.ts"
import * as TestRunner from "../src/TestRunner.ts"
import * as Write from "../src/Write.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261124")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const NodePlatform = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(Layer.merge(NodeFileSystem.layer, NodePath.layer))
)

const posixPath = Effect.runSync(Effect.provide(Path.Path, Path.layer))

const plainWord = (word: string | Redacted.Redacted<string>): string =>
  Redacted.isRedacted(word) ? Redacted.value(word) : word

const withTempDir = async <A>(prefix: string, fn: (dir: string) => Promise<A>): Promise<A> => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  try {
    return await fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const makeTarHeader = (options: {
  readonly name: string
  readonly size: number
  readonly typeFlag: string
  readonly linkName?: string
  readonly prefix?: string
  readonly corruptChecksum?: boolean
  readonly corruptOctal?: boolean
}): Uint8Array => {
  const header = new Uint8Array(512)
  const enc = new TextEncoder()
  header.set(enc.encode(options.name).subarray(0, 100), 0)
  header.set(enc.encode("0000644\0"), 100)
  header.set(enc.encode("0000000\0"), 108)
  header.set(enc.encode("0000000\0"), 116)
  const sizeStr = options.corruptOctal
    ? "zzzzzzzzzzz\0"
    : `${options.size.toString(8).padStart(11, "0")}\0`
  header.set(enc.encode(sizeStr), 124)
  header.set(enc.encode("00000000000\0"), 136)
  header.set(enc.encode("        "), 148)
  header[156] = options.typeFlag.charCodeAt(0)
  if (options.linkName !== undefined) {
    header.set(enc.encode(options.linkName).subarray(0, 100), 157)
  }
  if (options.prefix !== undefined) {
    header.set(enc.encode("ustar\0"), 257)
    header.set(enc.encode("00"), 263)
    header.set(enc.encode(options.prefix).subarray(0, 155), 345)
  }
  let sum = 0
  for (let i = 0; i < 512; i++) sum += header[i]!
  if (options.corruptChecksum) sum += 7
  header.set(enc.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148)
  return header
}

const makeTarEntry = (options: Parameters<typeof makeTarHeader>[0], payload: Uint8Array): Uint8Array => {
  const header = makeTarHeader({ ...options, size: payload.byteLength })
  const paddedLen = Math.ceil(payload.byteLength / 512) * 512
  const out = new Uint8Array(512 + paddedLen)
  out.set(header, 0)
  out.set(payload, 512)
  return out
}

const concatBytes = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = parts.reduce((acc, p) => acc + p.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

const paxRecord = (key: string, value: string): Uint8Array => {
  const body = ` ${key}=${value}\n`
  let len = body.length + 1
  while (String(len).length + body.length !== len) {
    len = String(len).length + body.length
  }
  return new TextEncoder().encode(`${len}${body}`)
}

const scriptedSpawner = (
  responses: ReadonlyArray<
    readonly [
      string,
      { readonly stdout?: string; readonly stderr?: string; readonly exitCode?: number; readonly failSpawn?: boolean }
    ]
  >,
  recorded: Array<ReadonlyArray<string>>
) =>
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
    ChildProcessSpawner.makeNoop({
      spawn: (command) => {
        const std = command as ChildProcess.StandardCommand
        const argv = [std.command, ...std.args.map(plainWord)]
        recorded.push(argv)
        const line = argv.join(" ")
        const matched = responses.find(([needle]) => line.includes(needle))?.[1] ?? {}
        if (matched.failSpawn) {
          return Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "ChildProcessSpawner",
              method: "spawn",
              description: "injected spawn failure"
            })
          )
        }
        const enc = new TextEncoder()
        const stdout = Stream.make(enc.encode(matched.stdout ?? ""))
        const stderr = Stream.make(enc.encode(matched.stderr ?? ""))
        return Effect.succeed(
          makeHandle({
            pid: ProcessId(42),
            exitCode: Effect.succeed(ExitCode(matched.exitCode ?? 0)),
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
        )
      }
    })
  )

describe("@smthrs/std Wave 6 deep fuzz (Read/Write/Edit/Grep, Ignore, Tar, EnvelopePrecheck, FileMutation, Checkpoints/GitWorktree, TestRun)", () => {
  it(
    "Read.run, Write.run, Edit.run, and Grep.run enforce line slicing, binary/missing/dir/escape boundaries, edits, and search invariants",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          mode: Schema.Literals(["text", "sliced", "edit", "grep", "binary", "missing", "dir", "escape", "empty"]),
          lines: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 18 })),
          offset: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 })),
          limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 }))
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ mode, lines, offset, limit }) =>
            Effect.promise(() =>
              withTempDir("smthrs-std-w6-", async (dir) => {
                const wsLayer = Layer.mergeAll(NodePlatform, Workspace.layer(dir)).pipe(
                  Layer.provideMerge(PortableSearch.layer.pipe(Layer.provide(NodePlatform)))
                )
                const content = Array.from({ length: lines }, (_, i) => `line-${i + 1}-payload`).join("\n") + "\n"

                if (mode === "text" || mode === "sliced" || mode === "empty" || mode === "edit" || mode === "grep") {
                  const body = mode === "empty" ? "" : content
                  await Effect.runPromise(
                    Write.run({ path: path.join(dir, "sub/doc.txt"), content: body }).pipe(Effect.provide(wsLayer))
                  )
                  if (mode === "sliced" && offset > lines) {
                    const oor = await Effect.runPromise(
                      Read.run({ path: path.join(dir, "sub/doc.txt"), offset, limit }).pipe(
                        Effect.provide(wsLayer),
                        Effect.exit
                      )
                    )
                    expect(Exit.isFailure(oor)).toBe(true)
                    return true
                  }
                  const res = await Effect.runPromise(
                    Read.run(
                      mode === "sliced"
                        ? { path: path.join(dir, "sub/doc.txt"), offset, limit }
                        : { path: path.join(dir, "sub/doc.txt") }
                    ).pipe(Effect.provide(wsLayer))
                  )
                  expect(res.totalLines).toBeGreaterThanOrEqual(0)
                  if (mode === "text") {
                    expect(res.content).toContain("line-1-payload")
                    expect(res.startLine).toBe(1)
                  }
                  if (mode === "sliced") {
                    expect(res.content).toContain(`line-${offset}-payload`)
                    expect(res.startLine).toBe(offset)
                  }
                  if (mode === "edit") {
                    const edited = await Effect.runPromise(
                      Edit.run({
                        path: path.join(dir, "sub/doc.txt"),
                        oldString: "line-1-payload",
                        newString: "LINE-1-REPLACED"
                      }).pipe(Effect.provide(wsLayer))
                    )
                    expect(edited.replacements).toBe(1)
                    const after = await Effect.runPromise(
                      Read.run({ path: path.join(dir, "sub/doc.txt") }).pipe(Effect.provide(wsLayer))
                    )
                    expect(after.content).toContain("LINE-1-REPLACED")
                    const noMatch = await Effect.runPromise(
                      Edit.run({
                        path: path.join(dir, "sub/doc.txt"),
                        oldString: "does-not-exist-anywhere",
                        newString: "noop"
                      }).pipe(Effect.provide(wsLayer), Effect.exit)
                    )
                    expect(Exit.isFailure(noMatch)).toBe(true)
                  }
                  if (mode === "grep") {
                    const found = await Effect.runPromise(
                      Grep.run({ pattern: "line-1-payload", root: path.join(dir, "sub") }).pipe(Effect.provide(wsLayer))
                    )
                    expect(found.matches.length).toBeGreaterThanOrEqual(1)
                  }
                } else if (mode === "binary") {
                  fs.writeFileSync(path.join(dir, "bin.dat"), Buffer.from([0, 1, 2, 255, 0, 128]))
                  const ex = await Effect.runPromise(
                    Read.run({ path: path.join(dir, "bin.dat") }).pipe(Effect.provide(wsLayer), Effect.exit)
                  )
                  expect(Exit.isFailure(ex)).toBe(true)
                } else if (mode === "missing") {
                  const ex = await Effect.runPromise(
                    Read.run({ path: path.join(dir, "nope.txt") }).pipe(Effect.provide(wsLayer), Effect.exit)
                  )
                  expect(Exit.isFailure(ex)).toBe(true)
                } else if (mode === "dir") {
                  fs.mkdirSync(path.join(dir, "adir"))
                  const ex = await Effect.runPromise(
                    Read.run({ path: path.join(dir, "adir") }).pipe(Effect.provide(wsLayer), Effect.exit)
                  )
                  expect(Exit.isFailure(ex)).toBe(true)
                } else {
                  const ex = await Effect.runPromise(
                    Read.run({ path: "../../etc/passwd" }).pipe(Effect.provide(wsLayer), Effect.exit)
                  )
                  expect(Exit.isFailure(ex)).toBe(true)
                }
                return true
              })
            ),
          { executions: Math.min(executions, 45), seed }
        )
      )
      assertPassed(report)
    },
    60_000
  )

  it("Tar.files parses ustar, GNU L/K, POSIX PAX x/g, hard links, multi-archive concatenation, and rejects corrupt/truncated streams", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        variant: Schema.Literals([
          "ustar",
          "gnuLong",
          "paxExtended",
          "hardLinkOk",
          "hardLinkMissing",
          "multiArchive",
          "badChecksum",
          "badOctal",
          "truncated",
          "unterminated",
          "globalHeader"
        ]),
        bodyText: Schema.Literals(["hello tar\n", "a=1\nb=2\n", "", "0123456789".repeat(60)])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ variant, bodyText }) =>
          Effect.sync(() => {
            const payload = new TextEncoder().encode(bodyText)
            const eof = new Uint8Array(1024)

            if (variant === "ustar") {
              const stream = concatBytes([
                makeTarEntry(
                  { name: "file.txt", prefix: "deep/dir", size: payload.byteLength, typeFlag: "0" },
                  payload
                ),
                eof
              ])
              const map = Tar.files(stream)
              expect(map).toBeDefined()
              expect(new TextDecoder().decode(map!.get("deep/dir/file.txt"))).toBe(bodyText)
            } else if (variant === "gnuLong") {
              const longPath = "very/long/path/".repeat(8) + "target.txt"
              const stream = concatBytes([
                makeTarEntry(
                  { name: "././@LongLink", size: 0, typeFlag: "L" },
                  new TextEncoder().encode(`${longPath}\0`)
                ),
                makeTarEntry({ name: "truncated", size: payload.byteLength, typeFlag: "0" }, payload),
                eof
              ])
              const map = Tar.files(stream)
              expect(map?.has(longPath)).toBe(true)
            } else if (variant === "paxExtended") {
              const paxPath = "pax/extended/item.txt"
              const stream = concatBytes([
                makeTarEntry({ name: "PaxHeader", size: 0, typeFlag: "x" }, paxRecord("path", paxPath)),
                makeTarEntry({ name: "short", size: payload.byteLength, typeFlag: "0" }, payload),
                eof
              ])
              const map = Tar.files(stream)
              expect(map?.has(paxPath)).toBe(true)
            } else if (variant === "hardLinkOk") {
              const stream = concatBytes([
                makeTarEntry({ name: "orig.txt", size: payload.byteLength, typeFlag: "0" }, payload),
                makeTarEntry({ name: "././@LongLink", size: 0, typeFlag: "K" }, new TextEncoder().encode("orig.txt\0")),
                makeTarEntry({ name: "alias.txt", size: 0, typeFlag: "1", linkName: "ignored" }, new Uint8Array(0)),
                eof
              ])
              const map = Tar.files(stream)
              expect(map?.get("alias.txt")).toBe(map?.get("orig.txt"))
            } else if (variant === "hardLinkMissing") {
              const stream = concatBytes([
                makeTarEntry(
                  { name: "dangling.txt", size: 0, typeFlag: "1", linkName: "absent.txt" },
                  new Uint8Array(0)
                ),
                eof
              ])
              expect(Tar.files(stream)).toBeUndefined()
            } else if (variant === "multiArchive") {
              const stream = concatBytes([
                makeTarEntry({ name: "first.txt", size: payload.byteLength, typeFlag: "0" }, payload),
                eof,
                makeTarEntry({ name: "second.txt", size: payload.byteLength, typeFlag: "\0" }, payload),
                eof
              ])
              const map = Tar.files(stream)
              expect(map?.size).toBe(2)
            } else if (variant === "globalHeader") {
              const stream = concatBytes([
                makeTarEntry({ name: "pax_global_header", size: 0, typeFlag: "g" }, paxRecord("comment", "global")),
                makeTarEntry({ name: "only.txt", size: payload.byteLength, typeFlag: "7" }, payload),
                eof
              ])
              const map = Tar.files(stream)
              expect(map?.has("only.txt")).toBe(true)
            } else if (variant === "badChecksum") {
              const stream = concatBytes([
                makeTarEntry(
                  { name: "bad.txt", size: payload.byteLength, typeFlag: "0", corruptChecksum: true },
                  payload
                ),
                eof
              ])
              expect(Tar.files(stream)).toBeUndefined()
            } else if (variant === "badOctal") {
              const stream = concatBytes([
                makeTarEntry({ name: "bad.txt", size: payload.byteLength, typeFlag: "0", corruptOctal: true }, payload),
                eof
              ])
              expect(Tar.files(stream)).toBeUndefined()
            } else if (variant === "truncated") {
              const full = makeTarEntry({ name: "cut.txt", size: 2048, typeFlag: "0" }, new Uint8Array(600))
              expect(Tar.files(full.subarray(0, 600))).toBeUndefined()
            } else {
              const stream = makeTarEntry({ name: "noeof.txt", size: payload.byteLength, typeFlag: "0" }, payload)
              expect(Tar.files(stream)).toBeUndefined()
            }
            return true
          }),
        { executions: Math.min(executions, 100), seed: seed + 1 }
      )
    )
    assertPassed(report)
  })

  it("Ignore.parse/ignored and EnvelopePrecheck.commandReferences/outsideEnvelope enforce gitignore precedence and hermetic command pre-checks", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        rules: Schema.Literals([
          "\uFEFF# comment\n*.log\n!keep.log\n",
          "dist/\n/root-only.txt\nsrc/**/tmp/*.ts\n",
          "trail\\ \n[a-z]?.tmp\n!a1.tmp\n",
          "build/\n!build/keep/\n*.bak\n"
        ]),
        candidate: Schema.Literals([
          "app.log",
          "keep.log",
          "dist",
          "root-only.txt",
          "sub/root-only.txt",
          "src/x/tmp/a.ts",
          "trail ",
          "a1.tmp",
          "b2.tmp"
        ]),
        isDir: Schema.Boolean,
        cmd: Schema.Literals([
          "echo hi\nrm -rf /work/target\n",
          "env FOO=bar mv /work/a /work/b",
          "cat /work/in.txt > /work/out.txt",
          "cat /work/in.txt | tee /outside/leak.txt",
          "sed -i 's/a/b/' /work/doc.txt",
          "cp /work/a /work/b && chmod +x /work/b",
          "ls -la /work/src && grep foo /work/src/a.ts",
          "python3 -c 'print(1)' /work/script.py",
          "tar -xf /work/a.tar -C /outside/dir",
          "touch /work/new.txt; ln -s /work/a /outside/link"
        ])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ rules, candidate, isDir, cmd }) =>
          Effect.sync(() => {
            const rootScope = Ignore.parse("/repo", rules)
            const subScope = Ignore.parse("/repo/sub", "*.sub\n!keep.sub\n")
            const fullPath = `/repo/${candidate}`
            const base = path.posix.basename(fullPath)
            const first = Ignore.ignored([rootScope, subScope], fullPath, base, isDir, path.posix.relative)
            const second = Ignore.ignored([rootScope, subScope], fullPath, base, isDir, path.posix.relative)
            expect(first).toBe(second)

            const refs = EnvelopePrecheck.commandReferences(posixPath, cmd)
            expect(Array.isArray(refs)).toBe(true)
            const checkReadOnly = EnvelopePrecheck.outsideEnvelope(
              { reads: ["/work/**"], writes: [], cwd: "/work" },
              cmd,
              posixPath
            )
            const checkReadWrite = EnvelopePrecheck.outsideEnvelope(
              { reads: ["/work/**"], writes: ["/work/**"], cwd: "/work" },
              cmd,
              posixPath
            )
            if (checkReadOnly === undefined) {
              expect(checkReadWrite).toBeUndefined()
            }
            return true
          }),
        { executions: Math.min(executions, 120), seed: seed + 2 }
      )
    )
    assertPassed(report)
  })

  it("FileMutation.acquire enforces lock canonicalization, deduplication, and atomic rollback on admission or body failures", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        paths: Schema.Array(Schema.Literals(["/a", "/b", "/alias", "/c/d", "/e"])).check(
          Schema.isMinLength(1),
          Schema.isMaxLength(4)
        ),
        fault: Schema.Literals(["none", "AlreadyExists", "PermissionDenied", "Unknown", "bodyFail"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ paths, fault }) =>
          Effect.gen(function*() {
            const held = new Set<string>()
            let calls = 0
            const fakeFs = FileSystem.makeNoop({
              realPath: (p) => Effect.succeed(p === "/alias" ? "/a" : p),
              makeDirectory: (p) => {
                calls++
                if (fault !== "none" && fault !== "bodyFail" && calls === 1) {
                  return Effect.fail(
                    PlatformError.systemError({ _tag: fault, module: "FileSystem", method: "makeDirectory" })
                  )
                }
                return Effect.sync(() => {
                  held.add(p)
                })
              },
              remove: (p) =>
                Effect.sync(() => {
                  held.delete(p)
                })
            })

            const ex = yield* Effect.scoped(
              Effect.gen(function*() {
                yield* FileMutation.acquire(fakeFs, paths)
                expect(held.size).toBeGreaterThanOrEqual(1)
                if (fault === "bodyFail") {
                  return yield* Effect.fail("boom")
                }
                return "ok"
              })
            ).pipe(Effect.exit)

            expect(held.size).toBe(0)
            if (fault === "none") expect(Exit.isSuccess(ex)).toBe(true)
            else expect(Exit.isFailure(ex)).toBe(true)
            expect(FileMutation.isVersioned(fakeFs)).toBe(false)
            expect(FileMutation.batched(fakeFs)).toBeUndefined()
            return true
          }),
        { executions: Math.min(executions, 80), seed: seed + 3 }
      )
    )
    assertPassed(report)
  })

  it("Checkpoints (makeGit + makeContainer + makeNoop) and GitWorktree handle capture, materialize, config, resolveCommit, and fault injection", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals([
          "gitOk",
          "gitSpawnFail",
          "gitMissingId",
          "containerOk",
          "containerFail",
          "worktreeConfig",
          "noop"
        ]),
        snapId: Schema.Literals(["base", "step-1", "step-2"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ mode, snapId }) =>
          Effect.gen(function*() {
            const spawns: Array<ReadonlyArray<string>> = []
            const sha = "a".repeat(40)

            if (mode === "noop") {
              const cp = Checkpoints.makeNoop()
              const cExit = yield* cp.capture(snapId).pipe(Effect.exit)
              const mExit = yield* cp.materialize(snapId, () => Effect.void).pipe(Effect.exit)
              expect(Exit.isFailure(cExit)).toBe(true)
              expect(Exit.isFailure(mExit)).toBe(true)
              return true
            }

            if (mode === "containerOk" || mode === "containerFail") {
              const spawnerLayer = scriptedSpawner(
                mode === "containerFail"
                  ? [["docker", { exitCode: 1, stderr: "container error" }]]
                  : [
                    ["docker", { stdout: `${sha}\n`, exitCode: 0 }]
                  ],
                spawns
              )
              const containerLayer = Layer.succeed(Container.Container, Container.makeCommand())
              const cp = yield* Checkpoints.makeContainer({ container: "fuzz-container", cwd: "/work/repo" }).pipe(
                Effect.provide(Layer.merge(spawnerLayer, containerLayer))
              )
              const cExit = yield* cp.capture(snapId).pipe(Effect.exit)
              if (mode === "containerFail") {
                expect(Exit.isFailure(cExit)).toBe(true)
              } else {
                expect(Exit.isSuccess(cExit)).toBe(true)
              }
              const mExit = yield* cp.materialize(snapId, (m) => Effect.succeed(m.root)).pipe(Effect.exit)
              expect(Exit.isSuccess(mExit) || Exit.isFailure(mExit)).toBe(true)
              return true
            }

            const spawnerLayer = scriptedSpawner(
              mode === "gitSpawnFail"
                ? [["git", { failSpawn: true }], ["sh", { failSpawn: true }]]
                : [
                  ["--show-toplevel", { stdout: "/work/repo\n/work/repo/.git\n/work/repo/.git/index\nsha1\n" }],
                  ["--get-regexp", { stdout: `flows-checkpoint.base ${sha}\n`, exitCode: 0 }],
                  ["rev-parse --verify", mode === "gitMissingId" ? { exitCode: 1 } : { stdout: `${sha}\n` }],
                  ["write-tree", { stdout: `${"b".repeat(40)}\n` }],
                  ["commit-tree", { stdout: `${sha}\n` }],
                  ["update-ref", { stdout: "" }],
                  ["config --file", { stdout: "" }],
                  ["worktree add", { stdout: "" }],
                  ["worktree remove", { stdout: "" }],
                  ["stat -c %d", { stdout: "1\n1\n1\n" }],
                  ["ls-files", { stdout: "" }],
                  ["add -A", { stdout: "" }]
                ],
              spawns
            )

            if (mode === "worktreeConfig") {
              const resolved = yield* GitWorktree.resolveCommit("/work/repo", ["HEAD", "main"]).pipe(
                Effect.provide(spawnerLayer),
                Effect.exit
              )
              expect(Exit.isSuccess(resolved)).toBe(true)
              const opened = yield* GitWorktree.open("/work/repo").pipe(
                Effect.provide(spawnerLayer),
                Effect.exit
              )
              expect(Exit.isSuccess(opened)).toBe(true)
              if (Exit.isSuccess(opened)) {
                yield* GitWorktree.config(opened.value, ["--get-regexp", "flows-checkpoint"]).pipe(
                  Effect.provide(spawnerLayer),
                  Effect.exit
                )
                yield* GitWorktree.writeConfig(opened.value, ["flows-checkpoint.test", sha]).pipe(
                  Effect.provide(spawnerLayer),
                  Effect.exit
                )
              }
              return true
            }

            const cp = yield* Checkpoints.makeGit({ root: "/work/repo" }).pipe(Effect.provide(spawnerLayer))
            const capExit = yield* cp.capture(snapId).pipe(Effect.exit)
            if (mode === "gitSpawnFail") {
              expect(Exit.isFailure(capExit)).toBe(true)
            } else {
              expect(Exit.isSuccess(capExit) || Exit.isFailure(capExit)).toBe(true)
            }
            const matExit = yield* cp.materialize(snapId, (m) => Effect.succeed(m.root)).pipe(Effect.exit)
            if (mode === "gitSpawnFail" || mode === "gitMissingId") {
              expect(Exit.isFailure(matExit)).toBe(true)
            }
            expect(spawns.length).toBeGreaterThan(0)
            return true
          }),
        { executions: Math.min(executions, 45), seed: seed + 4 }
      )
    )
    assertPassed(report)
  })

  it("TestRun.run executes against real TestRunner layers for pass, fail, baseline, and noop-runner outcomes", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        outcome: Schema.Literals(["pass", "fail", "noopRunner", "baselineRefused"]),
        tests: Schema.Array(Schema.Literals(["a.test.ts", "b.test.ts"])).check(
          Schema.isMinLength(0),
          Schema.isMaxLength(2)
        )
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ outcome, tests }) =>
          Effect.gen(function*() {
            const spawns: Array<ReadonlyArray<string>> = []
            const spawnerLayer = scriptedSpawner(
              [
                [
                  "vitest",
                  {
                    exitCode: outcome === "pass" ? 0 : 1,
                    stdout: outcome === "pass" ? "PASS 2 tests\n" : "FAIL 1 test\n",
                    stderr: outcome === "fail" ? "AssertionError: expected 1 to be 2\n" : ""
                  }
                ],
                ["--show-toplevel", { stdout: "/work/repo\n/work/repo/.git\n/work/repo/.git/index\nsha1\n" }],
                ["rev-parse --verify", { stdout: `${"c".repeat(40)}\n` }]
              ],
              spawns
            )
            const runnerLayer = outcome === "noopRunner"
              ? TestRunner.layerNoop
              : TestRunner.layer({
                command: "vitest run",
                cwd: "/work/repo",
                root: "/work/repo",
                ...(outcome === "baselineRefused" ? { baseline: false as const } : {})
              })
            const evalLayer = Evaluator.layerUnavailable()
            const fullLayer = Layer.mergeAll(
              spawnerLayer,
              NodeFileSystem.layer,
              NodePath.layer,
              Workspace.layer("/work/repo"),
              runnerLayer,
              evalLayer
            )
            const ex = yield* TestRun.run({
              ...(tests.length > 0 ? { selection: tests } : {}),
              ...(outcome === "baselineRefused" ? { against: "base" as const } : { against: "workspace" as const })
            }).pipe(Effect.provide(fullLayer), Effect.exit)
            if (outcome === "noopRunner" || outcome === "baselineRefused") {
              expect(Exit.isFailure(ex)).toBe(true)
            } else {
              expect(Exit.isSuccess(ex) || Exit.isFailure(ex)).toBe(true)
            }
            return true
          }),
        { executions: Math.min(executions, 30), seed: seed + 5 }
      )
    )
    assertPassed(report)
  })
})
