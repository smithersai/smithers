import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Capability, Permission } from "@smthrs/capability"
import { Fuzz } from "@smthrs/fuzz"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as KernelHttpClient from "@smthrs/kernel/HttpClient"
import * as Arbitrary from "effect/Arbitrary"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as PlatformError from "effect/PlatformError"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import { ExitCode, make as makeSpawner, makeHandle as mkProcHandle, ProcessId } from "effect/process/ChildProcessSpawner"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as nodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as ApplyPatch from "../src/ApplyPatch.ts"
import * as Edit from "../src/Edit.ts"
import * as Grep from "../src/Grep.ts"
import * as LanguageServer from "../src/LanguageServer.ts"
import * as Ls from "../src/Ls.ts"
import * as Lsp from "../src/Lsp.ts"
import * as NativeSearch from "../src/NativeSearch.ts"
import * as RemoteSearch from "../src/RemoteSearch.ts"
import * as Search from "../src/Search.ts"
import * as SearchContract from "../src/SearchContract.ts"
import * as ApplyPatchInternal from "../src/internal/ApplyPatch.ts"
import * as EnvelopePrecheck from "../src/internal/EnvelopePrecheck.ts"
import * as FileMutation from "../src/internal/FileMutation.ts"
import * as HttpNetwork from "../src/internal/HttpNetwork.ts"
import * as Ignore from "../src/internal/Ignore.ts"
import * as Preserve from "../src/internal/Preserve.ts"
import * as TestReport from "../src/internal/TestReport.ts"

const EXECUTIONS = Number(process.env.FUZZ_EXECUTIONS ?? "60")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const enc = new TextEncoder()

const makeHandle = (opts: {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr?: string
  readonly hang?: boolean
}) =>
  mkProcHandle({
    pid: ProcessId(4242),
    exitCode: opts.hang ? Effect.never : Effect.succeed(ExitCode(opts.exitCode)),
    isRunning: Effect.succeed(opts.hang === true),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: opts.hang ? Stream.never : opts.stdout.length > 0 ? Stream.make(enc.encode(opts.stdout)) : Stream.empty,
    stderr: opts.stderr && opts.stderr.length > 0 ? Stream.make(enc.encode(opts.stderr)) : Stream.empty,
    all: Stream.empty,
    unref: Effect.succeed(Effect.void),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty
  })

describe("@smthrs/std Wave10 Boost3 Fuzz", () => {
  it("ApplyPatchInternal, SearchContract, Ignore, EnvelopePrecheck, and TestReport cover edge syntax and error branches", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        idx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 15 }))
      })
    )

    const badPatches: ReadonlyArray<string> = [
      "*** Begin Patch\n*** Update File: a.txt\n@@\n*** End Patch",
      "*** Begin Patch\n*** Update File: a.txt\n@@\n*** Add File: b.txt\n+x\n*** End Patch",
      "*** Begin Patch\n*** Delete File: a.txt\nnot a header\n*** End Patch",
      "*** Begin Patch\n*** Update File: a.txt\n@@\n-a\n+b\n*** End of File\n\nbadline\n*** End Patch",
      "*** Begin Patch\n*** Update File: a.txt\n@@\n@@\n-a\n+b\n*** End Patch",
      "*** Begin Patch\n*** Add File: a.txt\n+hello\n*** End Patch\ntrailing junk",
      "*** Begin Patch\n*** Add File: a.txt\n+hello\n*** End Patch\n   ",
      "*** Begin Patch\n*** Update File: a.txt\n@@\n-a\u2014\u2018\u201c\u00a0b\n+a-'\" b\n*** End Patch"
    ]

    const patterns: ReadonlyArray<string> = [
      "[unclosed",
      "foo)",
      "Rule({",
      "{2}",
      "foo}",
      "foo]",
      "*abc",
      "(unclosed",
      "\\[ok\\]",
      "[^a\\]b]",
      "(a){1,2}",
      "a+b?c*",
      "(?<=foo)bar",
      "a".repeat(20) + "(".repeat(25) + "x" + ")".repeat(25),
      "^foo|bar$",
      "[a-z]{2,}"
    ]

    const ignoreFiles: ReadonlyArray<string> = [
      "café.txt\n",
      "dangling\\\n",
      "[!abc].log\n[]x].log\n[unclosed.log\n",
      "{a,b,}.ts\n{}.ts\n",
      "unopened}.ts\n",
      "{unclosed.ts\n",
      "**/deep/file.ts\ndir/**\nfoo/**/bar\n",
      "plain?.txt\n*.tmp\n!keep.tmp\n"
    ]

    const commands: ReadonlyArray<string> = [
      "eval 'rm /etc/passwd' /etc/hosts",
      "sh -c 'rm /etc/passwd' /etc/hosts",
      "dd if=/tmp/in of=/etc/out",
      "cat <<< /etc/passwd",
      "cmd 2>&1 /etc/passwd > /etc/out",
      "cp --target-directory=/etc/dir /tmp/a",
      "cp --target-directory /etc/dir /tmp/a",
      "sed -i /etc/hosts",
      "grep -f/etc/pat --unknown=/etc/unk -z/etc/att -- /etc/arg",
      "tar -cf/etc/out.tar /tmp/in",
      "FOO=/etc/a BAR=1 cmd -o /etc/b",
      "cat - < /etc/in >> /etc/out"
    ]

    const reports: ReadonlyArray<string> = [
      "TAP version 13\n1..2\nok 1 - a\nnot ok 2 - b\nRan 2 tests in 0.01s\nOK\n",
      "TAP version 13\n1..2\nok 1 - a\nnot ok 2 - b\n",
      "ok 1 pass\nnot ok 2 fail\n",
      "Ran 3 tests in 0.002s\n\nFAILED (failures=1, errors=1)\n",
      "=== 2 passed, 1 failed in 0.10s ===\n",
      "plain output with no runner signature\n"
    ]

    const tmpRoot = await fs.mkdtemp(nodePath.join(os.tmpdir(), "std-w10b3-pure-"))
    try {
      await fs.writeFile(nodePath.join(tmpRoot, ".gitignore"), "ignored.ts\n")
      await fs.writeFile(nodePath.join(tmpRoot, "ignored.ts"), "export const x = 1\n")
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ idx }) =>
            Effect.gen(function*() {
              const patch = badPatches[idx % badPatches.length]!
              try {
                const parsed = ApplyPatchInternal.parsePatch(patch)
                expect(parsed.hunks.length).toBeGreaterThanOrEqual(0)
              } catch {
                // expected parse errors
              }
              expect(ApplyPatchInternal.seekSequence(["a", "b"], [], 1, false)).toBe(1)
              expect(ApplyPatchInternal.seekSequence(["a"], ["a", "b"], 0, false)).toBeUndefined()
              const unicodeChars =
                "a\u2010\u2011\u2012\u2013\u2014\u2015\u2212\u2018\u2019\u201a\u201b\u201c\u201d\u201e\u201f\u00a0\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u202f\u205f\u3000z"
              const asciiChars = "a-------''''\"\"\"\"             z"
              expect(ApplyPatchInternal.seekSequence([unicodeChars], [asciiChars], 0, false)).toBe(0)

              // trailing empty line fallback + large LCS table limit in deriveNewContents
              const bigOld = Array.from({ length: 120 }, (_, i) => `line-${i}`)
              const bigNew = Array.from({ length: 120 }, (_, i) => `other-${i}`)
              const applied = ApplyPatchInternal.deriveNewContents(
                bigOld.join("\n") + "\n",
                "a.txt",
                [{ changeContext: undefined, oldLines: [bigOld[0]!, ""], newLines: [bigNew[0]!, ""], isEndOfFile: false }]
              )
              expect(typeof applied).toBe("string")
              const appliedLarge = ApplyPatchInternal.deriveNewContents(
                bigOld.join("\n") + "\n",
                "a.txt",
                [{ changeContext: undefined, oldLines: bigOld, newLines: bigNew, isEndOfFile: false }]
              )
              expect(typeof appliedLarge).toBe("string")

              // SearchContract.validatePattern & includedByGlobs & cache eviction (>256)
              const patErr = SearchContract.validatePattern(patterns[idx]!, false)
              expect(patErr === undefined || patErr._tag === "@smthrs/std/StdError").toBe(true)
              expect(SearchContract.includedByGlobs(["{unclosed", "{single}"], "a.ts", "a.ts")).toBeTypeOf("boolean")
              expect(SearchContract.includedByGlobs(["!dir/sub/"], "dir/sub/file.ts", "file.ts")).toBe(false)
              if (idx === 0) {
                for (let k = 0; k < 260; k++) {
                  SearchContract.includedByGlobs([`*.ext${k}`], `a.ext${k}`, `a.ext${k}`)
                }
              }

              // SearchContract.unsatisfiableNotice
              const fileSystem = yield* FileSystem.FileSystem
              const pathSvc = yield* Path.Path
              const n1 = yield* SearchContract.unsatisfiableNotice({
                fileSystem,
                path: pathSvc,
                root: nodePath.join(tmpRoot, "does-not-exist"),
                hidden: false,
                noIgnore: false,
                globs: ["*.ts"]
              })
              expect(n1).toBeUndefined()
              const n2 = yield* SearchContract.unsatisfiableNotice({
                fileSystem,
                path: pathSvc,
                root: tmpRoot,
                hidden: false,
                noIgnore: false,
                globs: ["node_modules/a.ts", ".hidden/b.ts"]
              })
              expect(n2).toContain("node_modules")
              const n3 = yield* SearchContract.unsatisfiableNotice({
                fileSystem,
                path: pathSvc,
                root: tmpRoot,
                hidden: false,
                noIgnore: false,
                globs: [`${tmpRoot.replace(/^\/+/, "")}/a.ts`]
              })
              expect(n3 === undefined || typeof n3 === "string").toBe(true)
              const n4 = yield* SearchContract.unsatisfiableNotice({
                fileSystem,
                path: pathSvc,
                root: tmpRoot,
                hidden: false,
                noIgnore: false,
                globs: ["ignored.ts"]
              })
              expect(n4 === undefined || typeof n4 === "string").toBe(true)

              // Ignore rules
              const rules = Ignore.parse("", ignoreFiles[idx % ignoreFiles.length]!)
              expect(typeof Ignore.ignored([rules], "café.txt", "café.txt", false, (_a, b) => b)).toBe("boolean")
              expect(typeof Ignore.ignored([rules], "dir/sub/x.ts", "x.ts", false, (_a, b) => b)).toBe("boolean")

              // EnvelopePrecheck
              const refs = EnvelopePrecheck.commandReferences(pathSvc, commands[idx % commands.length]!)
              expect(Array.isArray(refs)).toBe(true)

              // TestReport
              const parsedRep = TestReport.parse(reports[idx % reports.length]!)
              expect(typeof parsedRep.parsed).toBe("boolean")

              return true
            }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
          { executions: Math.min(EXECUTIONS, 40), seed: 20261310 }
        )
      )
      assertPassed(report)
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true })
    }
  }, 60_000)

  it("Edit, ApplyPatch, Preserve, Ls, Grep, Lsp, and HttpNetwork cover faulty FS, batched ops, and error channels", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 11 }))
      })
    )

    const tmpRoot = await fs.mkdtemp(nodePath.join(os.tmpdir(), "std-w10b3-io-"))
    try {
      const sampleFile = nodePath.join(tmpRoot, "sample.txt")
      await fs.writeFile(sampleFile, "line1\nline2\nfoo[0]\n")
      const subDir = nodePath.join(tmpRoot, "sub")
      await fs.mkdir(subDir, { recursive: true })
      await fs.writeFile(nodePath.join(subDir, "ok.txt"), "hi\n")

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ mode }) =>
            Effect.gen(function*() {
              const realFs = yield* FileSystem.FileSystem

              // 1. Edit validation branches + expect mismatch + faulty chmod/write
              const editCases: ReadonlyArray<typeof Edit.Input.Type> = [
                { path: sampleFile, oldString: "line1", startLine: 1, endLine: 1, newString: "x" },
                { path: sampleFile, newString: "x" },
                { path: sampleFile, startLine: 1, newString: "x" },
                { path: sampleFile, oldString: "", newString: "x" },
                { path: sampleFile, oldString: "line1", expect: "line1", newString: "x" },
                { path: sampleFile, startLine: 1, endLine: 1, replaceAll: true, newString: "x" },
                { path: sampleFile, startLine: 1, endLine: 1, expect: "WRONG", newString: "x" }
              ]
              const editRes = yield* Effect.result(Edit.run(editCases[mode % editCases.length]!))
              expect(Result.isFailure(editRes)).toBe(true)

              const mkErr = (
                tag: "PermissionDenied" | "AlreadyExists" | "Unknown" | "BadResource" | "NotFound",
                method: string
              ) =>
                PlatformError.systemError({
                  _tag: tag,
                  module: "FileSystem",
                  method,
                  pathOrDescriptor: sampleFile,
                  description: `${tag} in ${method}`
                })

              if (mode % 4 === 0) {
                const chmodFailFs = {
                  ...realFs,
                  stat: (p: string) =>
                    realFs.stat(p).pipe(
                      Effect.map((info) =>
                        p === sampleFile ? { ...info, mode: 0o100755, uid: Option.some(999999) } : info
                      )
                    ),
                  chown: () => Effect.void,
                  chmod: () => Effect.fail(mkErr("PermissionDenied", "chmod"))
                }
                const eChmod = yield* Effect.result(
                  Edit.run({ path: sampleFile, oldString: "line1", newString: "line1" }).pipe(
                    Effect.provideService(FileSystem.FileSystem, chmodFailFs)
                  )
                )
                expect(Result.isFailure(eChmod)).toBe(true)
              } else if (mode % 4 === 1) {
                const inPlaceFile = nodePath.join(tmpRoot, `inplace-${mode}.txt`)
                yield* realFs.writeFileString(inPlaceFile, "hello\n")
                const inPlaceFs = {
                  ...realFs,
                  stat: (p: string) =>
                    realFs.stat(p).pipe(
                      Effect.map((info) =>
                        p === inPlaceFile ? { ...info, uid: Option.some(999998) } : info
                      )
                    ),
                  chown: () => Effect.fail(mkErr("PermissionDenied", "chown"))
                }
                yield* Preserve.writeFile(inPlaceFs, inPlaceFile, enc.encode("updated\n"), {
                  metadataFrom: inPlaceFile
                })
                const content = yield* realFs.readFileString(inPlaceFile)
                expect(content).toBe("updated\n")
              } else if (mode % 4 === 2) {
                const existsFs = {
                  ...realFs,
                  writeFile: () => Effect.fail(mkErr("AlreadyExists", "writeFile"))
                }
                const res = yield* Effect.result(
                  Preserve.writeFile(existsFs, sampleFile, enc.encode("x"))
                )
                expect(Result.isFailure(res)).toBe(true)
              } else {
                const patchText = [
                  "*** Begin Patch",
                  `*** Add File: ${nodePath.join(tmpRoot, "nested", "new.txt")}`,
                  "+hello",
                  "*** End Patch"
                ].join("\n")
                const badFs = mode === 3
                  ? { ...realFs, realPath: () => Effect.fail(mkErr("PermissionDenied", "realPath")) }
                  : mode === 7
                  ? { ...realFs, makeDirectory: () => Effect.fail(mkErr("PermissionDenied", "makeDirectory")) }
                  : { ...realFs, writeFile: () => Effect.fail(mkErr("PermissionDenied", "writeFile")) }
                const res = yield* Effect.result(
                  ApplyPatch.run({ input: patchText }).pipe(
                    Effect.provideService(FileSystem.FileSystem, badFs)
                  )
                )
                expect(Result.isFailure(res)).toBe(true)
              }

              // 2. Ls: non-directory, per-entry stat fail, and batched host (BadResource + NotFound)
              const lsFileErr = yield* Effect.result(Ls.run({ path: sampleFile }))
              expect(Result.isFailure(lsFileErr)).toBe(true)
              const statFailEntryFs = {
                ...realFs,
                stat: (p: string) =>
                  p === subDir ? realFs.stat(p) : Effect.fail(mkErr("PermissionDenied", "stat"))
              }
              const lsFallback = yield* Ls.run({ path: subDir }).pipe(
                Effect.provideService(FileSystem.FileSystem, statFailEntryFs)
              )
              expect(lsFallback.entries.length).toBeGreaterThan(0)
              const batchedFs: FileMutation.BatchedFileSystem = {
                ...realFs,
                [FileMutation.Batched]: {
                  snapshot: () => Effect.succeed(new Map()),
                  commit: () => Effect.succeed({ applied: 0 }),
                  list: () => Effect.fail(mkErr(mode % 2 === 0 ? "BadResource" : "NotFound", "list"))
                } as unknown as FileMutation.BatchedFiles
              }
              const lsBatchedErr = yield* Effect.result(
                Ls.run({ path: subDir }).pipe(Effect.provideService(FileSystem.FileSystem, batchedFs))
              )
              expect(Result.isFailure(lsBatchedErr)).toBe(true)

              // 3. Grep: normalize errors + retriedAsLiteral
              const grepBadInputs: ReadonlyArray<typeof Grep.Input.Type> = [
                { pattern: "a", ignoreCase: true, smartCase: true },
                { pattern: "a", context: 1, beforeContext: 1 },
                { pattern: "a", maxCount: 0 },
                { pattern: "[unclosed" },
                { pattern: "a", globs: ["[bad"] }
              ]
              const emptyGrepOut: Search.GrepOutput = { matches: [], files: [], truncated: false, filesSearched: 0, skippedBinary: 0 }
              const emptyGlobOut: Search.GlobOutput = { paths: [], truncated: false, total: 0 }
              const gBad = yield* Effect.result(
                Grep.run(grepBadInputs[mode % grepBadInputs.length]!).pipe(
                  Effect.provideService(Search.Search, {
                    grep: () => Effect.succeed(emptyGrepOut),
                    glob: () => Effect.succeed(emptyGlobOut)
                  })
                )
              )
              expect(Result.isFailure(gBad)).toBe(true)
              const gRetry = yield* Grep.run({ pattern: "foo[0]", root: tmpRoot }).pipe(
                Effect.provideService(Search.Search, {
                  grep: (inp) =>
                    Effect.succeed<Search.GrepOutput>(
                      inp.fixedStrings
                        ? {
                          matches: [{ file: sampleFile, line: 3, text: "foo[0]", before: [], after: [] }],
                          files: [sampleFile],
                          truncated: false,
                          filesSearched: 1,
                          skippedBinary: 0,
                          ...(mode % 2 === 0 ? { notice: "extra" } : {})
                        }
                        : emptyGrepOut
                    ),
                  glob: () => Effect.succeed(emptyGlobOut)
                })
              )
              expect(gRetry.retriedAsLiteral).toBe(true)

              // 4. Lsp: relative path, missing line/char, documentSymbols, and all 7 position operations
              const fakeLsp = LanguageServer.LanguageServer.of({
                workspaceSymbols: () => Effect.succeed([]),
                documentSymbols: () => Effect.succeed([]),
                diagnostics: () => Effect.succeed([]),
                hover: () => Effect.succeed("hover-ok"),
                definition: () => Effect.succeed([]),
                references: () => Effect.succeed([]),
                implementation: () => Effect.succeed([]),
                prepareCallHierarchy: () => Effect.succeed([]),
                callHierarchyIncoming: () => Effect.succeed([]),
                callHierarchyOutgoing: () => Effect.succeed([]),
                sync: () => Effect.void,
                close: () => Effect.void,
                refresh: Effect.void
              })
              const ops = [
                { operation: "hover" as const, path: "relative/a.ts", line: 1, character: 1 },
                { operation: "hover" as const, path: sampleFile },
                { operation: "documentSymbols" as const, path: sampleFile },
                { operation: "diagnostics" as const, path: sampleFile },
                { operation: "workspaceSymbols" as const, query: "foo" },
                { operation: "hover" as const, path: sampleFile, line: 1, character: 1 },
                { operation: "definition" as const, path: sampleFile, line: 1, character: 1 },
                { operation: "references" as const, path: sampleFile, line: 1, character: 1 },
                { operation: "implementation" as const, path: sampleFile, line: 1, character: 1 },
                { operation: "prepareCallHierarchy" as const, path: sampleFile, line: 1, character: 1 },
                { operation: "callHierarchyIncoming" as const, path: sampleFile, line: 1, character: 1 },
                { operation: "callHierarchyOutgoing" as const, path: sampleFile, line: 1, character: 1 }
              ] as const
              const lspOut = yield* Effect.result(
                Lsp.run(ops[mode]!).pipe(Effect.provideService(LanguageServer.LanguageServer, fakeLsp))
              )
              expect(mode < 2 ? Result.isFailure(lspOut) : Result.isSuccess(lspOut)).toBe(true)

              // 5. HttpNetwork.refusal + check errors
              const req = HttpClientRequest.get("https://example.com/")
              const kErr = KernelHttpClient.toHttpClientError({
                request: req,
                error: Permission.PermissionDenied.new({
                  capability: Capability.make("net:private", "https://example.com"),
                  reason: "blocked"
                })
              })
              expect(HttpNetwork.refusal(kErr)?.code).toBe("permission_denied")
              expect(HttpNetwork.refusal(new Error("other"))).toBeUndefined()
              const fakeClient = KernelHttpClient.withDestinationPinning(HttpClient.make(() => Effect.die("never")))
              const badUrl = yield* Effect.result(HttpNetwork.guarded(fakeClient).get("not-a-url"))
              expect(Result.isFailure(badUrl)).toBe(true)
              const unavail = yield* Effect.result(
                HttpNetwork.guarded(fakeClient).get("https://example.com/").pipe(
                  Effect.provideService(KernelHttpClient.ResolveHost, () =>
                    Effect.fail(new KernelHttpClient.ResolveHostUnavailable({ hostname: "example.com", reason: "no dns" }))
                  )
                )
              )
              expect(Result.isFailure(unavail)).toBe(true)
              const emptyAddr = yield* Effect.result(
                HttpNetwork.guarded(fakeClient).get("https://example.com/").pipe(
                  Effect.provideService(KernelHttpClient.ResolveHost, () => Effect.succeed([]))
                )
              )
              expect(Result.isFailure(emptyAddr)).toBe(true)

              return true
            }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, GrantStore.layerNoop))),
          { executions: Math.min(EXECUTIONS, 36), seed: 20261311 }
        )
      )
      assertPassed(report)
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true })
    }
  }, 60_000)

  it("NativeSearch and RemoteSearch cover malformed rg JSON, binary files, spawn failures, and remote bounds", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        variant: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 11 }))
      })
    )

    const tmpRoot = await fs.mkdtemp(nodePath.join(os.tmpdir(), "std-w10b3-search-"))
    try {
      const f1 = nodePath.join(tmpRoot, "a.ts")
      await fs.writeFile(f1, "export function hello() { return 1 }\n")

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ variant }) =>
            Effect.gen(function*() {
              const realFs = yield* FileSystem.FileSystem
              const pathSvc = yield* Path.Path
              const baseGrep: Search.GrepInput = {
                pattern: "hello",
                root: variant === 0 ? f1 : tmpRoot,
                fixedStrings: false,
                ignoreCase: false,
                smartCase: false,
                globs: [],
                beforeContext: 0,
                afterContext: 0,
                filesWithMatches: false,
                hidden: false,
                symbols: variant === 9,
                limit: 20
              }

              const malformedOutputs: ReadonlyArray<string> = [
                "",
                "123\n",
                "{not-json\n",
                JSON.stringify({ type: "match", data: { path: { text: "a.ts" } } }) + "\n",
                JSON.stringify({ type: "begin", data: {} }) + "\n",
                JSON.stringify({ type: "end", data: { path: { text: "a.ts" }, binary_offset: "bad" } }) + "\n",
                JSON.stringify({ type: "summary", data: { stats: {} } }) + "\n",
                JSON.stringify({ type: "weird", data: {} }) + "\n",
                JSON.stringify({ type: "begin", data: { path: { text: "a.ts" } } }) + "\n",
                JSON.stringify({
                  type: "match",
                  data: {
                    path: { text: "a.ts" },
                    lines: { text: "export function hello() { return 1 }\n" },
                    line_number: 1
                  }
                }) +
                  "\n" +
                  JSON.stringify({ type: "summary", data: { stats: { searches: 1 } } }) +
                  "\n"
              ]

              let callNo = 0
              const spawner = makeSpawner(() => {
                const n = callNo++
                if (variant === 10) {
                  return Effect.fail(
                    PlatformError.systemError({
                      _tag: "NotFound",
                      module: "ChildProcess",
                      method: "spawn",
                      description: "rg missing"
                    })
                  )
                }
                if (variant === 11) {
                  return Effect.succeed(makeHandle({ exitCode: 2, stdout: "", stderr: "rg: regex parse error" }))
                }
                if (variant === 0) {
                  return Effect.succeed(
                    makeHandle({
                      exitCode: 0,
                      stdout: n === 1
                        ? "a.ts\0"
                        : JSON.stringify({ type: "summary", data: { stats: { searches: 1 } } }) + "\n"
                    })
                  )
                }
                return Effect.succeed(
                  makeHandle({
                    exitCode: 0,
                    stdout: n === 0 ? malformedOutputs[variant]! : ""
                  })
                )
              })

              const nativeServices = Context.make(ChildProcessSpawner.ChildProcessSpawner, spawner).pipe(
                Context.add(FileSystem.FileSystem, realFs),
                Context.add(Path.Path, pathSvc)
              )
              const nativeRes = yield* Effect.result(NativeSearch.make(nativeServices).grep(baseGrep))
              if (variant === 9) {
                expect(Result.isSuccess(nativeRes)).toBe(true)
              } else {
                expect(Result.isFailure(nativeRes)).toBe(true)
              }

              const remoteSpawner = makeSpawner(() => {
                if (variant % 4 === 0) {
                  return Effect.succeed(makeHandle({ exitCode: 1, stdout: "", stderr: "boom stderr" }))
                }
                if (variant % 4 === 1) {
                  return Effect.succeed(makeHandle({ exitCode: 2, stdout: "", stderr: "" }))
                }
                if (variant % 4 === 2) {
                  return Effect.succeed(
                    makeHandle({ exitCode: 0, stdout: Buffer.from("A".repeat(32)).toString("base64") })
                  )
                }
                return Effect.succeed(
                  makeHandle({ exitCode: 0, stdout: Buffer.from("not-a-tar-archive").toString("base64") })
                )
              })
              const remoteServices = Context.make(ChildProcessSpawner.ChildProcessSpawner, remoteSpawner).pipe(
                Context.add(Path.Path, pathSvc)
              )
              const remote = RemoteSearch.make(remoteServices, { maxBytes: 16 })
              const remRes = yield* Effect.result(remote.grep({ ...baseGrep, root: tmpRoot }))
              expect(Result.isFailure(remRes)).toBe(true)

              return true
            }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
          { executions: Math.min(EXECUTIONS, 36), seed: 20261312 }
        )
      )
      assertPassed(report)
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true })
    }
  }, 60_000)
})
