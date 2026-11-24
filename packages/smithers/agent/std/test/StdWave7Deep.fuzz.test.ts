import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { Fuzz } from "@smthrs/fuzz"
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Arbitrary, Effect, FileSystem, Layer, Path, PlatformError, Result, Schema, Sink, Stream } from "effect"
import { ExitCode, makeHandle, ProcessId } from "effect/process/ChildProcessSpawner"
import * as fs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as ApplyPatch from "../src/ApplyPatch.ts"
import * as Bash from "../src/Bash.ts"
import * as Container from "../src/Container.ts"
import * as Edit from "../src/Edit.ts"
import * as Grep from "../src/Grep.ts"
import * as ApplyPatchText from "../src/internal/ApplyPatch.ts"
import * as EnvelopePrecheck from "../src/internal/EnvelopePrecheck.ts"
import * as Exec from "../src/internal/Exec.ts"
import * as FileMutation from "../src/internal/FileMutation.ts"
import * as GitWorktree from "../src/internal/GitWorktree.ts"
import * as Read from "../src/Read.ts"
import * as SearchContract from "../src/SearchContract.ts"
import * as StdError from "../src/StdError.ts"
import * as TestRun from "../src/TestRun.ts"
import * as TestRunner from "../src/TestRunner.ts"
import * as Write from "../src/Write.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "60"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261124")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const realHost = Layer.mergeAll(
  NodeFileSystem.layer,
  Path.layer,
  Layer.provide(NodeChildProcessSpawner.layer, Layer.merge(NodeFileSystem.layer, Path.layer))
)

const makeTempDir = (prefix: string): string => fs.mkdtempSync(nodePath.join(os.tmpdir(), prefix))

const cleanTempDir = (dir: string): void => {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // ignore cleanup races
  }
}

const textEncoder = new TextEncoder()

const makeFaultySpawner = (
  handler: (command: unknown) => Effect.Effect<ReturnType<typeof makeHandle>, PlatformError.PlatformError>
): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(handler as never)
  )

const createHandle = (
  stdoutChunks: ReadonlyArray<Uint8Array>,
  stderrChunks: ReadonlyArray<Uint8Array>,
  exitCode: Effect.Effect<ExitCode, PlatformError.PlatformError>
) =>
  makeHandle({
    pid: ProcessId(424242),
    stdin: Sink.drain,
    stdout: Stream.fromIterable(stdoutChunks),
    stderr: Stream.fromIterable(stderrChunks),
    all: Stream.fromIterable([...stdoutChunks, ...stderrChunks]),
    exitCode,
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty
  })

const safeSlug = (raw: string): string => {
  const cleaned = raw.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 8)
  return cleaned.length > 0 ? cleaned : "tok"
}

describe("StdWave7Deep fuzz", () => {
  // 1. EnvelopePrecheck: backslash escapes, double quotes, backticks, nested substitutions, comments, fds, inline scripts
  it("EnvelopePrecheck exercises quoting, escapes, substitutions, comments, redirects, and nesting limits", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        variant: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 11 })),
        raw: Schema.String,
        outsideIdx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 }))
      })
    )
    const outsides = ["/etc/passwd", "/var/tmp/secret.txt", "../escape/file.txt"] as const
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ outsideIdx, raw, variant }) =>
          Effect.gen(function*() {
            const pathSvc = yield* Path.Path
            const token = safeSlug(raw)
            const outside = outsides[outsideIdx]!
            const env: EnvelopePrecheck.Envelope = {
              cwd: "/workspace/repo",
              reads: ["/workspace/repo/**"],
              writes: ["/workspace/repo/out/**"]
            }
            const commands: ReadonlyArray<string> = [
              `cat /workspace/repo/${token}\\ name \\x${token} \\\n${outside}`,
              `echo "hi \\"there\\" \\$HOME \\\`x\\\` \\\n\`cat ${outside}\` $(cat '${outside}' "${outside}")"`,
              `echo \`cat ${outside}\` # comment referencing /ignored/path\ncat /workspace/repo/${token}`,
              `cmd 2>&1 3>${outside} <${outside} $(echo (nested) \`echo ${outside}\` "q $(echo ${token})" 's')`,
              `bash -c "cat ${outside} > /workspace/repo/out/${token}"`,
              `node -e "fs.readFileSync('${outside}')"`,
              `python3 -c 'open("${outside}")'`,
              `sh ${outside}`,
              `${"$(".repeat(36)}echo ${token}${")".repeat(36)}`,
              `${"\"$(".repeat(36)}echo ${token}${")\"".repeat(36)}`,
              `echo \`cat \\\` ${outside} && echo "unclosed ${outside}`,
              `echo $(cat '${outside}`
            ]
            const cmd = commands[variant]!
            try {
              const refs = EnvelopePrecheck.commandReferences(pathSvc, cmd)
              expect(Array.isArray(refs)).toBe(true)
              const violation = EnvelopePrecheck.outsideEnvelope(env, cmd, pathSvc)
              if (violation !== undefined) {
                expect(violation).toBeInstanceOf(StdError.StdError)
              }
            } catch (error) {
              expect(error).toBeInstanceOf(StdError.StdError)
              expect((error as StdError.StdError).code).toBe("invalid_input")
            }
            return true
          }).pipe(Effect.provide(Path.layer)),
        { executions, seed }
      )
    )
    assertPassed(report)
  })

  // 2. SearchContract: validatePattern, validateGlob, expression, canonicalGlob, matchesGlob
  it("SearchContract covers all regex & glob validation rejections and char-class expressions", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        variant: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 21 })),
        raw: Schema.String,
        insensitive: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ insensitive, raw, variant }) =>
          Effect.sync(() => {
            const word = safeSlug(raw)
            const badPatterns: ReadonlyArray<string> = [
              "a".repeat(4097),
              "[[a-z]]",
              "[[:alpha:]]",
              `${word}{1001}`,
              "[]",
              "[^]",
              "[a&&b]",
              "[a--b]",
              "[a~~b]",
              `(${word}`,
              `${word})`,
              `${word}{bad}`,
              `^{1,2}${word}`,
              `${word}}`,
              `${word}]`,
              `*${word}`,
              `(${word}|+${word})`,
              `$?${word}`,
              `[a-z`,
              `(?<1>${word})`,
              `[a\\-z${word}]+[0-9]{1,3}$`,
              `(${word}|[0-9^]+)`
            ]
            const pat = badPatterns[variant]!
            const err = SearchContract.validatePattern(pat, false)
            if (variant <= 19) {
              expect(err).toBeDefined()
              expect(SearchContract.isContractRejection(err!)).toBe(true)
            } else {
              expect(err).toBeUndefined()
              const re = SearchContract.expression(pat, false, insensitive)
              expect(re).toBeInstanceOf(RegExp)
              re.test(word)
            }

            const globs: ReadonlyArray<string> = [
              "\x01bad",
              "a\\b",
              "[a-z].ts",
              "{a,{b,c}}",
              "{single}",
              "unmatched}",
              "{a,b}".repeat(9),
              "{unclosed,a",
              `src/**/${word}.{ts,js}`
            ]
            const glob = globs[variant % globs.length]!
            const globErr = SearchContract.validateGlob(glob)
            if (variant % globs.length === globs.length - 1) {
              expect(globErr).toBeUndefined()
              const canon = SearchContract.canonicalGlob(glob)
              expect(SearchContract.matchesGlob(canon, `src/sub/${word}.ts`, `${word}.ts`)).toBe(true)
            } else {
              expect(globErr).toBeDefined()
            }
            return true
          }),
        { executions, seed: seed + 1 }
      )
    )
    assertPassed(report)
  })

  // 3. internal/ApplyPatch parser, deriveNewContents, printSummary & ApplyPatch.paths
  it("ApplyPatch parser covers environment_id, CRLF, heredoc, context lines, blank lines, and all syntax errors", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        variant: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 16 })),
        rawEnv: Schema.String,
        rawLine: Schema.String
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ rawEnv, rawLine, variant }) =>
          Effect.sync(() => {
            const envId = safeSlug(rawEnv)
            const line = safeSlug(rawLine)
            const patches: ReadonlyArray<{ readonly text: string; readonly valid: boolean }> = [
              {
                text: [
                  "*** Begin Patch",
                  `*** Environment ID: ${envId}`,
                  "*** Update File: a.txt",
                  "*** Move to: b.txt",
                  "@@ header",
                  " header",
                  "",
                  `-${line}`,
                  `+${line}_new`,
                  "*** End of File",
                  "*** End Patch"
                ].join("\r\n"),
                valid: true
              },
              {
                text: [
                  "<<'EOF'",
                  "*** Begin Patch",
                  "*** Add File: added.txt",
                  `+${line}`,
                  "*** Delete File: gone.txt",
                  "*** End Patch",
                  "EOF"
                ].join("\n"),
                valid: true
              },
              {
                text: `*** Begin Patch\n*** Environment ID: ${envId}\n*** Environment ID: ${envId}\n*** End Patch`,
                valid: false
              },
              {
                text: "*** Begin Patch\n*** Environment ID:   \n*** End Patch",
                valid: false
              },
              {
                text: "*** Begin Patch\n*** Rename File: x.txt\n*** End Patch",
                valid: false
              },
              {
                text: `*** Begin Patch\n*** Add File: a.txt\n+${line}\n*** Bogus: b.txt\n*** End Patch`,
                valid: false
              },
              {
                text: "*** Begin Patch\n*** Update File: a.txt\n*** End Patch",
                valid: false
              },
              {
                text: "*** Begin Patch\n*** Update File: a.txt\n@@\n*** End of File\n*** End Patch",
                valid: false
              },
              {
                text: `*** Begin Patch\n*** Update File: a.txt\nnot_a_marker_${line}\n*** End Patch`,
                valid: false
              },
              {
                text: `*** Begin Patch\n*** Update File: a.txt\n@@\n?bad_${line}\n*** End Patch`,
                valid: false
              },
              {
                text: `*** Begin Patch\n*** Update File: a.txt\n@@\n-${line}\n+${line}2\n?bad\n*** End Patch`,
                valid: false
              },
              {
                text: `*** Begin Patch\n*** Update File: a.txt\n\n?bad\n*** End Patch`,
                valid: false
              },
              {
                text: `*** Begin Patch\n*** Add File: a.txt\n+${line}\n*** End Patch\nextra_${line}`,
                valid: false
              },
              {
                text: `*** Begin Patch\n*** Update File: a.txt\n@@\n+${line}\n*** End Patch`,
                valid: true
              },
              {
                text: `*** Begin Patch\n*** Update File: a.txt\n@@\n-${line}\n+${line}2\n*** Weird: x\n*** End Patch`,
                valid: false
              },
              {
                text: `*** Begin Patch\n*** Add File: a.txt\nnot_plus_${line}\n*** End Patch`,
                valid: false
              },
              {
                text: `*** Begin Patch\n*** Add File: s.txt\n+${line}\n*** End Patch\n\n`,
                valid: true
              }
            ]

            const sample = patches[variant]!
            const pathsResult = ApplyPatch.paths(sample.text)
            expect(ApplyPatch.effectsFor({ input: sample.text })).toBeDefined()

            if (sample.valid) {
              const parsed = ApplyPatchText.parsePatch(sample.text)
              expect(pathsResult).toBeDefined()
              expect(parsed.hunks.length).toBeGreaterThan(0)
              if (variant === 0) {
                expect(parsed.environmentId).toBe(envId)
                expect(pathsResult).toEqual(["a.txt", "b.txt"])
                const hunk = parsed.hunks[0]!
                if (hunk.kind === "update") {
                  const ok = ApplyPatchText.deriveNewContents(`header\nheader\n\n${line}\n`, "a.txt", hunk.chunks)
                  expect(ok).toContain(`${line}_new`)
                  expect(() => ApplyPatchText.deriveNewContents("unrelated\n", "a.txt", hunk.chunks)).toThrow()
                }
              }
              if (variant === 13) {
                const hunk = parsed.hunks[0]!
                if (hunk.kind === "update") {
                  const inserted = ApplyPatchText.deriveNewContents("existing\n", "a.txt", hunk.chunks)
                  expect(inserted).toContain(line)
                }
              }
              const summary = ApplyPatchText.printSummary({
                added: ["a.txt"],
                modified: ["b.txt"],
                deleted: ["c.txt"]
              })
              expect(summary).toContain("A a.txt")
              expect(summary).toContain("M b.txt")
              expect(summary).toContain("D c.txt")
            } else {
              expect(pathsResult).toBeUndefined()
              expect(() => ApplyPatchText.parsePatch(sample.text)).toThrow()
            }
            return true
          }),
        { executions, seed: seed + 2 }
      )
    )
    assertPassed(report)
  })

  // 4. ApplyPatch.run filesystem edge cases (real temp dir in os.tmpdir(), plus faulty FS & BatchedFileSystem)
  it("ApplyPatch.run handles duplicate sections, directory collisions, binary files, batched conflicts, and FS failures", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        variant: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8 })),
        raw: Schema.String
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ raw, variant }) =>
          Effect.gen(function*() {
            const name = safeSlug(raw)
            const dir = makeTempDir("std-w7-patch-")
            try {
              const fileA = nodePath.join(dir, `${name}-a.txt`)
              const subDir = nodePath.join(dir, `${name}-dir`)
              fs.mkdirSync(subDir, { recursive: true })
              fs.writeFileSync(fileA, "alpha\nbeta\n", "utf8")

              if (variant === 0) {
                const patch = [
                  "*** Begin Patch",
                  `*** Update File: ${fileA}`,
                  "@@",
                  "-alpha",
                  "+gamma",
                  `*** Delete File: ${fileA}`,
                  "*** End Patch"
                ].join("\n")
                const err = yield* Effect.flip(ApplyPatch.run({ input: patch }))
                expect(err.code).toBe("invalid_input")
              } else if (variant === 1) {
                const missing = nodePath.join(dir, `missing-${name}.txt`)
                const patch = `*** Begin Patch\n*** Delete File: ${missing}\n*** End Patch`
                const err = yield* Effect.flip(ApplyPatch.run({ input: patch }))
                expect(err.code).toBe("not_found")
              } else if (variant === 2) {
                const patch = `*** Begin Patch\n*** Delete File: ${subDir}\n*** End Patch`
                const err = yield* Effect.flip(ApplyPatch.run({ input: patch }))
                expect(err.code).toBe("not_a_file")
              } else if (variant === 3) {
                const patch = `*** Begin Patch\n*** Add File: ${subDir}\n+hello\n*** End Patch`
                const err = yield* Effect.flip(ApplyPatch.run({ input: patch }))
                expect(err.code).toBe("not_a_file")
              } else if (variant === 4) {
                const patch = [
                  "*** Begin Patch",
                  `*** Update File: ${fileA}`,
                  `*** Move to: ${subDir}`,
                  "@@",
                  "-alpha",
                  "+delta",
                  "*** End Patch"
                ].join("\n")
                const err = yield* Effect.flip(ApplyPatch.run({ input: patch }))
                expect(err.code).toBe("not_a_file")
              } else if (variant === 5) {
                const binFile = nodePath.join(dir, `${name}.bin`)
                fs.writeFileSync(binFile, Buffer.from([0x61, 0x00, 0x62]))
                const patch = `*** Begin Patch\n*** Update File: ${binFile}\n@@\n-a\n+b\n*** End Patch`
                const err = yield* Effect.flip(ApplyPatch.run({ input: patch }))
                expect(err.code).toBe("binary_file")
              } else if (variant === 6) {
                const badUtf8 = nodePath.join(dir, `${name}.bad`)
                fs.writeFileSync(badUtf8, Buffer.from([0xff, 0xfe, 0x80]))
                const patch = `*** Begin Patch\n*** Update File: ${badUtf8}\n@@\n-a\n+b\n*** End Patch`
                const err = yield* Effect.flip(ApplyPatch.run({ input: patch }))
                expect(err.code).toBe("binary_file")
              } else if (variant === 7) {
                const realFs = yield* FileSystem.FileSystem
                const nested = nodePath.join(dir, "nope", `${name}.txt`)
                const faultyFs: FileSystem.FileSystem = {
                  ...realFs,
                  makeDirectory: () =>
                    Effect.fail(
                      PlatformError.systemError({
                        _tag: "PermissionDenied",
                        module: "FileSystem",
                        method: "makeDirectory",
                        pathOrDescriptor: nested,
                        description: "injected mkdir denial"
                      })
                    )
                }
                const patch = `*** Begin Patch\n*** Add File: ${nested}\n+hi\n*** End Patch`
                const err = yield* Effect.flip(
                  ApplyPatch.run({ input: patch }).pipe(Effect.provideService(FileSystem.FileSystem, faultyFs))
                )
                expect(err.code).toBe("permission_denied")
              } else {
                const realFs = yield* FileSystem.FileSystem
                const batchedFs: FileMutation.BatchedFileSystem = {
                  ...realFs,
                  [FileMutation.Batched]: {
                    snapshot: (paths) =>
                      Effect.succeed(
                        paths.map((p) => ({
                          canonical: p,
                          version: "v1",
                          info: Result.succeed({ type: "File" as const, size: 11 }),
                          content: Result.succeed(textEncoder.encode("alpha\nbeta\n"))
                        }))
                      ),
                    commit: () =>
                      Effect.succeed({
                        applied: 0,
                        stopped: { index: 0, reason: "changed" as const }
                      }),
                    list: () => Effect.succeed([])
                  }
                }
                const patch = `*** Begin Patch\n*** Update File: ${fileA}\n@@\n-alpha\n+omega\n*** End Patch`
                const err = yield* Effect.flip(
                  ApplyPatch.run({ input: patch }).pipe(Effect.provideService(FileSystem.FileSystem, batchedFs))
                )
                expect(err.code).toBe("no_match")
              }
            } finally {
              cleanTempDir(dir)
            }
            return true
          }).pipe(Effect.provide(realHost)),
        { executions, seed: seed + 3 }
      )
    )
    assertPassed(report)
  })

  // 5. internal/FileMutation: VersionedFileSystem (with & without prepare) + BatchedFileSystem
  it("FileMutation covers VersionedFileSystem preconditions, missing prepare, and BatchedFileSystem commit states", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        variant: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 })),
        raw: Schema.String
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ raw, variant }) =>
          Effect.gen(function*() {
            const payload = safeSlug(raw)
            const realFs = yield* FileSystem.FileSystem
            const target = `/tmp/fm-${payload}.txt`

            if (variant === 0) {
              const vfs: FileMutation.VersionedFileSystem = {
                ...realFs,
                [FileMutation.Preconditions]: {
                  record: () => Effect.void,
                  validate: () => Effect.void
                }
              }
              expect(FileMutation.isVersioned(vfs)).toBe(true)
              const err = yield* Effect.flip(FileMutation.validate(vfs, [target]))
              expect(err.code).toBe("provider_unavailable")
            } else if (variant === 1) {
              const committed: Array<FileMutation.Change> = []
              const vfs: FileMutation.VersionedFileSystem = {
                ...realFs,
                [FileMutation.Preconditions]: {
                  record: () => Effect.void,
                  validate: () => Effect.void,
                  prepare: () =>
                    Effect.succeed({
                      read: () => Effect.succeed(textEncoder.encode(payload)),
                      commit: (changes) =>
                        Effect.sync(() => {
                          committed.push(...changes)
                        })
                    })
                }
              }
              yield* FileMutation.recordRead(vfs, target, textEncoder.encode(payload))
              yield* FileMutation.validate(vfs, [target])
              yield* Effect.scoped(
                Effect.gen(function*() {
                  const mut = yield* FileMutation.acquire(vfs, [target])
                  const bytes = yield* mut.read(
                    target,
                    () => new StdError.StdError({ code: "not_found", message: "nf" })
                  )
                  expect(new TextDecoder().decode(bytes)).toBe(payload)
                  yield* mut.commit(
                    [{ path: target, content: textEncoder.encode(`${payload}!`) }],
                    Effect.void,
                    () => new StdError.StdError({ code: "command_failed", message: "cf" })
                  )
                })
              )
              expect(committed.length).toBe(1)
            } else if (variant === 2) {
              let commitCalls = 0
              const bfs: FileMutation.BatchedFileSystem = {
                ...realFs,
                [FileMutation.Batched]: {
                  snapshot: (paths) =>
                    Effect.succeed(
                      paths.map((p) => ({
                        canonical: p,
                        version: "v1",
                        info: Result.succeed({ type: "File" as const, size: payload.length }),
                        content: Result.succeed(textEncoder.encode(payload))
                      }))
                    ),
                  commit: (changes) =>
                    Effect.sync(() => {
                      commitCalls++
                      return { applied: changes.length }
                    }),
                  list: () => Effect.succeed([])
                }
              }
              expect(FileMutation.batched(bfs)).toBeDefined()
              yield* Effect.scoped(
                Effect.gen(function*() {
                  const mut = yield* FileMutation.acquire(bfs, [target])
                  const bytes = yield* mut.read(
                    target,
                    () => new StdError.StdError({ code: "not_found", message: "nf" })
                  )
                  expect(new TextDecoder().decode(bytes)).toBe(payload)
                  yield* mut.commit(
                    [],
                    Effect.void,
                    () => new StdError.StdError({ code: "command_failed", message: "cf" })
                  )
                  yield* mut.commit(
                    [{ path: target, content: textEncoder.encode(payload) }],
                    Effect.void,
                    () => new StdError.StdError({ code: "command_failed", message: "cf" })
                  )
                })
              )
              expect(commitCalls).toBe(1)
            } else if (variant === 3) {
              const bfs: FileMutation.BatchedFileSystem = {
                ...realFs,
                [FileMutation.Batched]: {
                  snapshot: (paths) =>
                    Effect.succeed(
                      paths.map((p) => ({
                        canonical: p,
                        version: "v1",
                        info: Result.succeed({ type: "File" as const, size: 1 }),
                        content: Result.succeed(textEncoder.encode("x"))
                      }))
                    ),
                  commit: () =>
                    Effect.succeed({
                      applied: 0,
                      stopped: { index: 0, reason: "locked" as const }
                    }),
                  list: () => Effect.succeed([])
                }
              }
              const err = yield* Effect.flip(
                Effect.scoped(
                  Effect.gen(function*() {
                    const mut = yield* FileMutation.acquire(bfs, [target])
                    yield* mut.commit(
                      [{ path: target, content: textEncoder.encode("y") }],
                      Effect.void,
                      () => new StdError.StdError({ code: "command_failed", message: "cf" })
                    )
                  })
                )
              )
              expect(err).toBeInstanceOf(StdError.StdError)
            } else {
              const bfs: FileMutation.BatchedFileSystem = {
                ...realFs,
                [FileMutation.Batched]: {
                  snapshot: (paths) =>
                    Effect.succeed(
                      paths.map((p) => ({
                        canonical: undefined,
                        version: "v1",
                        info: Result.succeed({ type: "File" as const, size: 1 }),
                        content: Result.succeed(textEncoder.encode("x"))
                      }))
                    ),
                  commit: () =>
                    Effect.succeed({
                      applied: 0,
                      stopped: {
                        index: 0,
                        reason: PlatformError.systemError({
                          _tag: "PermissionDenied",
                          module: "FileSystem",
                          method: "writeFile",
                          pathOrDescriptor: target,
                          description: "denied"
                        })
                      }
                    }),
                  list: () => Effect.succeed([])
                }
              }
              const err = yield* Effect.flip(
                Effect.scoped(
                  Effect.gen(function*() {
                    const mut = yield* FileMutation.acquire(bfs, [target])
                    yield* mut.commit(
                      [{ path: target, content: textEncoder.encode("y") }],
                      Effect.void,
                      () => new StdError.StdError({ code: "permission_denied", message: "denied" })
                    )
                  })
                )
              )
              expect(err.code).toBe("permission_denied")
            }
            return true
          }).pipe(Effect.provide(NodeFileSystem.layer)),
        { executions, seed: seed + 4 }
      )
    )
    assertPassed(report)
  })

  // 6. internal/Exec: UTF-8 multi-byte chunk overflow (tail & ends), capture_overflow, arguments_too_long, toStdError
  it("Exec covers multi-byte UTF-8 overflow (tail/ends), capture_overflow, E2BIG, and toStdError mapping", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        variant: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 })),
        maxBytes: Schema.Int.check(Schema.isBetween({ minimum: 10, maximum: 24 })),
        splitAt: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 }))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ maxBytes, splitAt, variant }) =>
          Effect.gen(function*() {
            const raw = textEncoder.encode("😀€é😀€é😀€é😀€é😀€é😀€é😀€é😀€é")
            const chunks: Array<Uint8Array> = []
            for (let i = 0; i < raw.byteLength; i += splitAt) {
              chunks.push(raw.subarray(i, Math.min(raw.byteLength, i + splitAt)))
            }

            if (variant === 0) {
              const spawner = makeFaultySpawner(() =>
                Effect.succeed(createHandle(chunks, [chunks[0]!], Effect.succeed(ExitCode(0))))
              )
              const res = yield* Exec.exec("echo", { maxCaptureBytes: maxBytes, overflow: "tail" }).pipe(
                Effect.provide(spawner)
              )
              expect(res.exitCode).toBe(0)
              expect(res.stdoutDroppedBytes).toBeGreaterThan(0)
            } else if (variant === 1) {
              const spawner = makeFaultySpawner(() =>
                Effect.succeed(createHandle(chunks, chunks, Effect.succeed(ExitCode(0))))
              )
              const res = yield* Exec.exec("echo", { maxCaptureBytes: maxBytes, overflow: "ends" }).pipe(
                Effect.provide(spawner)
              )
              expect(res.stdoutDroppedBytes).toBeGreaterThan(0)
              expect(res.stderrDroppedBytes).toBeGreaterThan(0)
            } else if (variant === 2) {
              const spawner = makeFaultySpawner(() =>
                Effect.succeed(createHandle(chunks, chunks, Effect.succeed(ExitCode(0))))
              )
              const err = yield* Effect.flip(
                Exec.exec("echo", { maxCaptureBytes: maxBytes, overflow: "refuse" }).pipe(Effect.provide(spawner))
              )
              expect(err.code).toBe("capture_overflow")
              expect(Exec.toStdErrorCode(err)).toBe("command_failed")
              expect(Exec.toStdError("echo", err).code).toBe("command_failed")
            } else if (variant === 3) {
              const e2big = Object.assign(new Error("spawn E2BIG"), { code: "E2BIG" })
              const spawner = makeFaultySpawner(() => Effect.die(e2big))
              const err = yield* Effect.flip(Exec.exec("echo", { args: ["a"] }).pipe(Effect.provide(spawner)))
              expect(err.code).toBe("arguments_too_long")
              expect(Exec.toStdErrorCode(err)).toBe("invalid_input")
              expect(Exec.toStdError("echo", err).code).toBe("invalid_input")
            } else {
              const spawnErr = new Exec.ExecError({ code: "spawn_error", message: "enoent" })
              expect(Exec.toStdErrorCode(spawnErr)).toBe("command_failed")
              expect(Exec.toStdError("missing", spawnErr).message).toContain("Command failed to start")
            }
            return true
          }),
        { executions, seed: seed + 5 }
      )
    )
    assertPassed(report)
  })

  // 6b. Real-clock Exec.exec & Bash.run timeout capture + container routing (real NodeChildProcessSpawner)
  it("Exec and Bash timeout paths preserve partial captured output and container routing", async () => {
    const execErr = await Effect.runPromise(
      Effect.flip(
        Exec.exec("sh", {
          args: ["-c", "printf partial-out; printf partial-err >&2; exec sleep 5"],
          timeoutMs: 150,
          maxCaptureBytes: 64,
          overflow: "ends"
        }).pipe(Effect.provide(realHost))
      )
    )
    expect(execErr.code).toBe("timeout")
    expect(execErr.captured).toBeDefined()
    expect(Exec.toStdErrorCode(execErr)).toBe("timeout")
    expect(Exec.toStdError("sleep", execErr).code).toBe("timeout")

    const bashErr = await Effect.runPromise(
      Effect.flip(
        Bash.run({
          mode: "unhermetic",
          command: "printf partial-bash; sleep 5",
          timeoutMs: 150
        }).pipe(Effect.provide(realHost))
      )
    )
    expect(bashErr.code).toBe("timeout")

    const containerLayer = Layer.succeed(
      Container.Container,
      Container.make({
        exec: () =>
          Effect.succeed({
            file: "sh",
            args: ["-c", "printf partial-box"]
          })
      })
    )
    const boxOut = await Effect.runPromise(
      Bash.run({
        mode: "unhermetic",
        command: "echo hi",
        container: "box-1",
        cwd: "/work",
        env: { FOO: "bar" }
      }).pipe(Effect.provide(Layer.mergeAll(realHost, containerLayer)))
    )
    expect(boxOut.exitCode).toBe(0)
  })

  // 7. Bash.inTerminal, Bash.invocation invalid combos, Container routing with args/stdin
  it("Bash covers inTerminal, container unavailability, container script/args routing, and invalid invocation plans", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        variant: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 7 })),
        raw: Schema.String
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ raw, variant }) =>
          Effect.gen(function*() {
            const word = safeSlug(raw)
            if (variant === 0) {
              const spawner = makeFaultySpawner(() => Effect.succeed(createHandle([], [], Effect.succeed(ExitCode(0)))))
              const err = yield* Effect.flip(
                Bash.run({ mode: "unhermetic", command: `echo ${word}`, container: "c1" }).pipe(
                  Effect.provide(Layer.merge(spawner, Path.layer))
                )
              )
              expect(err.code).toBe("provider_unavailable")
            } else if (variant === 1) {
              let seenReq: Container.Request | undefined
              const spawner = makeFaultySpawner(() =>
                Effect.succeed(createHandle([textEncoder.encode("ok")], [], Effect.succeed(ExitCode(0))))
              )
              const containerLayer = Layer.succeed(
                Container.Container,
                Container.make({
                  exec: (req) => {
                    seenReq = req
                    return Effect.succeed({ file: "docker", args: ["exec", req.container, req.file, ...req.args] })
                  }
                })
              )
              const res = yield* Bash.run({
                mode: "unhermetic",
                interpreter: "node",
                script: `console.log("${word}")`,
                args: [word],
                container: "box-2"
              }).pipe(Effect.provide(Layer.mergeAll(spawner, Path.layer, containerLayer)))
              expect(res.exitCode).toBe(0)
              expect(seenReq?.stdin).toBe(true)
            } else if (variant === 2) {
              const runInTerminal = Bash.inTerminal((input) =>
                Effect.succeed({
                  stdout: `term:${"command" in input ? input.command : input.script}`,
                  stderr: "",
                  exitCode: 0,
                  truncated: false,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  stdoutDroppedBytes: 0,
                  stderrDroppedBytes: 0
                })
              )
              const out = yield* runInTerminal({ mode: "unhermetic", command: `echo ${word}` }).pipe(
                Effect.provide(Path.layer)
              )
              expect(out.stdout).toContain(word)
            } else if (variant === 3) {
              const runInTerminal = Bash.inTerminal(() =>
                Effect.succeed({
                  stdout: "",
                  stderr: "",
                  exitCode: 0,
                  truncated: false,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  stdoutDroppedBytes: 0,
                  stderrDroppedBytes: 0
                })
              )
              const err = yield* Effect.flip(
                runInTerminal({ mode: "unhermetic", command: `echo ${word}`, container: "box-3" }).pipe(
                  Effect.provide(Path.layer)
                )
              )
              expect(err.code).toBe("provider_unavailable")
            } else if (variant === 4) {
              const runInTerminal = Bash.inTerminal(() => Effect.die("unreachable"))
              const err = yield* Effect.flip(
                runInTerminal({
                  mode: "hermetic",
                  reads: ["/workspace/only"],
                  writes: [],
                  command: "cat /etc/passwd"
                }).pipe(Effect.provide(Path.layer))
              )
              expect(err).toBeInstanceOf(StdError.StdError)
            } else if (variant === 5) {
              const combos: ReadonlyArray<Bash.Input> = [
                { mode: "unhermetic", command: "echo hi", script: "echo hi" } as unknown as Bash.Input,
                { mode: "unhermetic" } as unknown as Bash.Input,
                { mode: "unhermetic", script: "echo hi", interpreter: "bash", stdin: "x" } as unknown as Bash.Input,
                { mode: "unhermetic", command: "echo hi", args: ["a"] } as unknown as Bash.Input,
                { mode: "unhermetic", command: "echo hi", interpreter: "bash" } as unknown as Bash.Input
              ]
              for (const combo of combos) {
                const planned = Bash.invocation(combo)
                expect(planned).toBeInstanceOf(StdError.StdError)
              }
            } else if (variant === 6) {
              const denied = Bash.outsideContainer("/box", "/etc/passwd")
              expect(denied.code).toBe("outside_container")
              const sealedHandler = Bash.sealed("/box", { cwd: "/work" })
              const spawner = makeFaultySpawner(() => Effect.succeed(createHandle([], [], Effect.succeed(ExitCode(0)))))
              const wrongContainer = yield* Effect.flip(
                sealedHandler({ mode: "unhermetic", command: `echo ${word}`, container: "/other" }).pipe(
                  Effect.provide(Layer.merge(spawner, Path.layer))
                )
              )
              expect(wrongContainer.code).toBe("outside_container")
            } else {
              const e1 = Bash.effectsFor({ mode: "unhermetic", command: `echo ${word}` })
              const e2 = Bash.effectsFor({ mode: "unhermetic", interpreter: "bash", script: `echo ${word}` })
              expect(e1).toBeDefined()
              expect(e2).toBeDefined()
            }
            return true
          }),
        { executions, seed: seed + 6 }
      )
    )
    assertPassed(report)
  })

  // 8. Read.ts: effectsFor, directory refusal, response_too_large, invalid UTF-8, MAX_LINE_CHARS, batched read,
  //    and missing relative path sibling suggestions (with >12 entries + sharedPrefix + dotfiles) via tmpDir-scoped FileSystem
  it("Read covers effectsFor, directory refusal, oversize, binary UTF-8, line truncation, batched snapshot, and relative suggestions", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        variant: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })),
        raw: Schema.String
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ raw, variant }) =>
          Effect.gen(function*() {
            const prefix = safeSlug(raw)
            const dir = makeTempDir("std-w7-read-")
            try {
              const realFs = yield* FileSystem.FileSystem
              expect(Read.effectsFor({ path: `${prefix}.txt` })).toBeDefined()

              if (variant === 0) {
                const err = yield* Effect.flip(Read.run({ path: dir }))
                expect(err.code).toBe("is_directory")
              } else if (variant === 1) {
                const file = nodePath.join(dir, `${prefix}.big`)
                fs.writeFileSync(file, "small", "utf8")
                const bigFs: FileSystem.FileSystem = {
                  ...realFs,
                  stat: (p) =>
                    realFs.stat(p).pipe(
                      Effect.map((info) => ({
                        ...info,
                        size: BigInt(Read.MAX_READ_FILE_BYTES + 1024) as typeof info.size
                      }))
                    )
                }
                const err = yield* Effect.flip(
                  Read.run({ path: file }).pipe(Effect.provideService(FileSystem.FileSystem, bigFs))
                )
                expect(err.code).toBe("response_too_large")
              } else if (variant === 2) {
                const file = nodePath.join(dir, `${prefix}.bad`)
                fs.writeFileSync(file, Buffer.from([0xff, 0xfe, 0xc3, 0x28]))
                const err = yield* Effect.flip(Read.run({ path: file }))
                expect(err.code).toBe("binary_file")
              } else if (variant === 3) {
                const file = nodePath.join(dir, `${prefix}.long`)
                fs.writeFileSync(file, "x".repeat(2500) + "\nsecond\n", "utf8")
                const out = yield* Read.run({ path: file })
                expect(out.content.length).toBeLessThan(2500)
              } else if (variant === 4) {
                const file = nodePath.join(dir, `${prefix}.batched`)
                const bfs: FileMutation.BatchedFileSystem = {
                  ...realFs,
                  [FileMutation.Batched]: {
                    snapshot: (paths) =>
                      Effect.succeed(
                        paths.map((p) => ({
                          canonical: p,
                          version: "v1",
                          info: Result.succeed({ type: "File" as const, size: 5 }),
                          content: Result.succeed(textEncoder.encode("hello"))
                        }))
                      ),
                    commit: () => Effect.succeed({ applied: 0 }),
                    list: () => Effect.succeed([])
                  }
                }
                const out = yield* Read.run({ path: file }).pipe(Effect.provideService(FileSystem.FileSystem, bfs))
                expect(out.content).toContain("hello")
              } else if (variant === 5) {
                const sub = nodePath.join(dir, "sub")
                fs.mkdirSync(sub, { recursive: true })
                fs.writeFileSync(nodePath.join(sub, ".hidden"), "h")
                for (let i = 0; i < 15; i++) {
                  fs.writeFileSync(nodePath.join(sub, `${prefix}_file_${i}.txt`), String(i))
                }
                const resolveInTmp = (p: string) => (nodePath.isAbsolute(p) ? p : nodePath.join(dir, p))
                const scopedFs: FileSystem.FileSystem = {
                  ...realFs,
                  stat: (p) => realFs.stat(resolveInTmp(p)),
                  readFile: (p) => realFs.readFile(resolveInTmp(p)),
                  readDirectory: (p) => realFs.readDirectory(resolveInTmp(p))
                }
                const err = yield* Effect.flip(
                  Read.run({ path: `sub/${prefix}_missing.txt` }).pipe(
                    Effect.provideService(FileSystem.FileSystem, scopedFs)
                  )
                )
                expect(err.code).toBe("not_found")
                expect(err.message).toContain("and 3 more")
              } else {
                const file = nodePath.join(dir, `${prefix}.fifo`)
                const fifoFs: FileSystem.FileSystem = {
                  ...realFs,
                  stat: () =>
                    realFs.stat(dir).pipe(
                      Effect.map((info) => ({
                        ...info,
                        type: "FIFO" as const,
                        size: BigInt(0) as typeof info.size
                      }))
                    )
                }
                const err = yield* Effect.flip(
                  Read.run({ path: file }).pipe(Effect.provideService(FileSystem.FileSystem, fifoFs))
                )
                expect(err.code).toBe("not_found")
              }
            } finally {
              cleanTempDir(dir)
            }
            return true
          }).pipe(Effect.provide(realHost)),
        { executions, seed: seed + 7 }
      )
    )
    assertPassed(report)
  })

  // 9. One-shot real NodeChildProcessSpawner check for Exec multi-byte UTF-8 overflow (real spawner happy path)
  it("Exec real NodeChildProcessSpawner handles multi-byte UTF-8 overflow in ends mode", async () => {
    const res = await Effect.runPromise(
      Exec.exec("node", {
        args: ["-e", "process.stdout.write('😀€é'.repeat(40))"],
        maxCaptureBytes: 32,
        overflow: "ends"
      }).pipe(Effect.provide(realHost))
    )
    expect(res.exitCode).toBe(0)
    expect(res.stdoutDroppedBytes).toBeGreaterThan(0)
  })

  // 10. GitWorktree error & checkout branches via injected faulty ChildProcessSpawner (zero real git invocations)
  it("GitWorktree covers shadow creation, security, checkout filesystem errors, and detached worktree cleanup", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        variant: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 })),
        raw: Schema.String
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ raw, variant }) =>
          Effect.gen(function*() {
            const name = safeSlug(raw)
            let callIndex = 0
            const spawner = makeFaultySpawner(() => {
              const i = callIndex++
              if (variant === 0) {
                return Effect.succeed(
                  createHandle([], [textEncoder.encode("init failed")], Effect.succeed(ExitCode(1)))
                )
              }
              if (variant === 1) {
                if (i === 0) return Effect.succeed(createHandle([], [], Effect.succeed(ExitCode(0))))
                return Effect.succeed(
                  createHandle([], [textEncoder.encode("chmod failed")], Effect.succeed(ExitCode(1)))
                )
              }
              if (variant === 2) {
                if (i < 2) return Effect.succeed(createHandle([], [], Effect.succeed(ExitCode(0))))
                if (i === 2) {
                  return Effect.succeed(
                    createHandle(
                      [textEncoder.encode("dev1\ndev2\nunwritable\ndev3\n")],
                      [],
                      Effect.succeed(ExitCode(0))
                    )
                  )
                }
                return Effect.succeed(createHandle([], [], Effect.succeed(ExitCode(0))))
              }
              if (variant === 3) {
                if (i < 2) return Effect.succeed(createHandle([], [], Effect.succeed(ExitCode(0))))
                if (i === 2) {
                  return Effect.succeed(
                    createHandle(
                      [textEncoder.encode("dev1\ndev2\ndev1\ndev3\n")],
                      [],
                      Effect.succeed(ExitCode(0))
                    )
                  )
                }
                if (i === 3) {
                  return Effect.succeed(
                    createHandle([], [textEncoder.encode("checkout failed")], Effect.succeed(ExitCode(1)))
                  )
                }
                return Effect.succeed(createHandle([], [], Effect.succeed(ExitCode(0))))
              }
              if (i < 2) return Effect.succeed(createHandle([], [], Effect.succeed(ExitCode(0))))
              if (i === 2) {
                return Effect.succeed(
                  createHandle(
                    [textEncoder.encode("dev1\ndev2\ndev3\ndev1\n")],
                    [],
                    Effect.succeed(ExitCode(0))
                  )
                )
              }
              return Effect.succeed(
                createHandle([], [textEncoder.encode("publish failed")], Effect.succeed(ExitCode(1)))
              )
            })

            const repo: GitWorktree.Repository = {
              root: `/tmp/gw-root-${name}`,
              toplevel: `/tmp/gw-root-${name}`,
              common: `/tmp/gw-root-${name}/.git`,
              index: `/tmp/gw-root-${name}/.git/index`,
              objectFormat: variant % 2 === 0 ? "sha1" : "sha256",
              settings: ["-c", "core.autocrlf=false", "-c", "core.filemode=true"]
            }

            const res = yield* Effect.result(
              GitWorktree.GitWorktree.withDetachedWorktree(repo, "wt", "deadbeef", () => Effect.void)
            ).pipe(Effect.provide(spawner))
            expect(Result.isFailure(res)).toBe(true)
            return true
          }),
        { executions, seed: seed + 8 }
      )
    )
    assertPassed(report)
  })

  // 11. Edit, Write, Grep, TestRun effectsFor & edge cases in os.tmpdir()
  it("Edit, Write, Grep, and TestRun cover effectsFor, lineSpan, miss, binary/dir errors, and container refusal", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        variant: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 })),
        raw: Schema.String
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ raw, variant }) =>
          Effect.gen(function*() {
            const name = safeSlug(raw)
            const dir = makeTempDir("std-w7-ew-")
            try {
              const file = nodePath.join(dir, `${name}.txt`)
              fs.writeFileSync(file, "alpha line\nbeta line\ngamma line\n", "utf8")
              expect(Edit.effectsFor({ path: file, oldString: "alpha", newString: "baz" })).toBeDefined()
              expect(Write.effectsFor({ path: file, content: "x" })).toBeDefined()
              expect(Grep.effectsFor({ root: dir })).toBeDefined()
              expect(Grep.effectsFor({})).toBeDefined()
              expect(TestRun.effectsFor({})).toBeDefined()

              if (variant === 0) {
                const bin = nodePath.join(dir, `${name}.bin`)
                fs.writeFileSync(bin, Buffer.from([0x61, 0x00, 0x62]))
                const err = yield* Effect.flip(Edit.run({ path: bin, oldString: "a", newString: "b" }))
                expect(err.code).toBe("binary_file")
              } else if (variant === 1) {
                const bad = nodePath.join(dir, `${name}.bad`)
                fs.writeFileSync(bad, Buffer.from([0xff, 0xfe, 0xc3, 0x28]))
                const err = yield* Effect.flip(Edit.run({ path: bad, oldString: "a", newString: "b" }))
                expect(err.code).toBe("binary_file")
              } else if (variant === 2) {
                const err = yield* Effect.flip(Edit.run({ path: dir, oldString: "a", newString: "b" }))
                expect(err.code).toBe("command_failed")
              } else if (variant === 3) {
                const err = yield* Effect.flip(Edit.run({ path: file, oldString: "", newString: "b" }))
                expect(err.code).toBe("invalid_input")
              } else if (variant === 4) {
                const ok = yield* Edit.run({ path: file, oldString: "beta", newString: "beta" })
                expect(ok.replacements).toBe(1)
              } else if (variant === 5) {
                const err = yield* Effect.flip(Write.run({ path: dir, content: "nope" }))
                expect(err.code).toBe("command_failed")
              } else if (variant === 6) {
                // Edit miss with nearest region match (alpha line matches, second line differs)
                const err = yield* Effect.flip(
                  Edit.run({ path: file, oldString: "alpha line\nmissing_xyz", newString: "replaced" })
                )
                expect(err.code).toBe("no_match")
              } else if (variant === 7) {
                // Edit miss with completely unrelated text (region === undefined)
                const err = yield* Effect.flip(
                  Edit.run({ path: file, oldString: "zzzz_completely_absent_9999", newString: "replaced" })
                )
                expect(err.code).toBe("no_match")
              } else if (variant === 8) {
                // Edit lineSpan errors: endLine < startLine & startLine > lines.length
                const e1 = yield* Effect.flip(
                  Edit.run({ path: file, startLine: 3, endLine: 1, newString: "x" })
                )
                expect(e1.code).toBe("invalid_input")
                const e2 = yield* Effect.flip(
                  Edit.run({ path: file, startLine: 99, endLine: 100, newString: "x" })
                )
                expect(e2.code).toBe("offset_out_of_range")
              } else if (variant === 9) {
                // Edit valid startLine/endLine replacement + endLine > lines.length
                const e3 = yield* Effect.flip(
                  Edit.run({ path: file, startLine: 1, endLine: 99, newString: "x" })
                )
                expect(e3.code).toBe("offset_out_of_range")
                const ok = yield* Edit.run({ path: file, startLine: 2, endLine: 2, newString: "updated beta" })
                expect(ok.replacements).toBe(1)
              } else {
                // TestRun with container runner but no Container service -> provider_unavailable
                const runnerLayer = Layer.merge(
                  TestRunner.layer({ command: "echo ok", container: "box-missing" }),
                  Evaluator.layerUnavailable()
                )
                const err = yield* Effect.flip(
                  TestRun.run({ selection: ["t1"] }).pipe(Effect.provide(runnerLayer))
                )
                expect(err.code).toBe("provider_unavailable")
              }
            } finally {
              cleanTempDir(dir)
            }
            return true
          }).pipe(Effect.provide(realHost)),
        { executions, seed: seed + 9 }
      )
    )
    assertPassed(report)
  })

  // 12. TestRun real-clock timeout path (covers printed(captured))
  it("TestRun timeout preserves partial runner output", async () => {
    const runnerLayer = Layer.mergeAll(
      realHost,
      TestRunner.layer({ command: "printf '1..1\\nnot ok 1 hanging\\n'; sleep 5" }),
      Evaluator.layerUnavailable()
    )
    const err = await Effect.runPromise(
      Effect.flip(TestRun.run({ timeoutMs: 150 }).pipe(Effect.provide(runnerLayer)))
    )
    expect(err.code).toBe("timeout")
    expect(err.output).toBeDefined()
  })
})
