import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Credential from "@smthrs/control/Credential"
import { Fuzz } from "@smthrs/fuzz"
import { Capability, GrantStore, HttpClient as KernelHttpClient } from "@smthrs/kernel"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Arbitrary, Cause, Effect, FileSystem, Layer, Path, Redacted, Result, Schema, Stream } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as cp from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as ApplyPatch from "../src/ApplyPatch.ts"
import * as Edit from "../src/Edit.ts"
import * as ExaWebSearch from "../src/ExaWebSearch.ts"
import * as Grep from "../src/Grep.ts"
import * as EnvelopePrecheck from "../src/internal/EnvelopePrecheck.ts"
import * as Html from "../src/internal/Html.ts"
import * as Http from "../src/internal/Http.ts"
import * as HttpNetwork from "../src/internal/HttpNetwork.ts"
import * as Ignore from "../src/internal/Ignore.ts"
import * as Preserve from "../src/internal/Preserve.ts"
import * as TestReport from "../src/internal/TestReport.ts"
import * as Text from "../src/internal/Text.ts"
import * as LanguageServer from "../src/LanguageServer.ts"
import * as Ls from "../src/Ls.ts"
import * as Lsp from "../src/Lsp.ts"
import * as NativeSearch from "../src/NativeSearch.ts"
import * as PortableSearch from "../src/PortableSearch.ts"
import * as Search from "../src/Search.ts"
import * as StdError from "../src/StdError.ts"
import * as TestRun from "../src/TestRun.ts"
import * as TestRunner from "../src/TestRunner.ts"
import * as WebSearch from "../src/WebSearch.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const fastExec = Math.max(40, Math.min(executions, 120))
const ioExec = Math.max(16, Math.min(executions, 34))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261310")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const realHost = Layer.mergeAll(
  NodeFileSystem.layer,
  NodePath.layer,
  Layer.provide(NodeChildProcessSpawner.layer, Layer.merge(NodeFileSystem.layer, NodePath.layer))
)

const enc = new TextEncoder()

describe("@smthrs/std Wave10 Deep Fuzz", () => {
  it("Html, Ignore, Text, TestReport, and EnvelopePrecheck pure branch coverage", async () => {
    const htmlSamples = [
      `<!-- comment --><h1>Title</h1><p>Hello   \nWorld</p><a href="https://example.com">Link</a>`,
      `<!-- unclosed comment <p>still here`,
      `<a href="unclosed>bad</a><a href="">empty</a><a href='a' href="https://b.com">multi</a><a>nohref</a><a href="x">no close`,
      `<script>var x = 1;</script  ><style>.a{}</style><noscript>no</noscript><iframe src="x">in</iframe><head><title>t</title></head><p>body</p>`,
      `<script>unclosed script forever`,
      `<ul><li>one</li><li>two</li></ul><pre><code>const x = 1</code></pre><br/><hr/>&amp;&lt;&gt;&quot;&#39;&#x41;&#65;`,
      `<div attr="a>b"><span>nested</span><unclosed`
    ]
    const ignoreRules = [
      `# comment\n\\#literal\n*.log\n!keep.log\nbuild/\n/rootonly.txt\n**/deep/*.tmp\nfile?.txt\n[a-c].dat\ntrailing   \n`
    ]
    const testOutputs = [
      `Test Files  1 failed | 2 passed (3)\n     Tests  2 failed | 10 passed | 1 skipped (13)\n FAIL  test/a.test.ts > suite > case one\n FAIL  test/b.test.ts > case two`,
      `=== RUN   TestAlpha\n--- FAIL: TestAlpha (0.01s)\n=== RUN   TestBeta\n--- PASS: TestBeta (0.00s)\nFAIL\tpkg/foo\t0.1s`,
      `FAILED tests/test_mod.py::test_one - AssertionError\nFAILED tests/test_mod.py::test_two\n2 failed, 5 passed, 1 skipped in 0.4s`,
      `test mod::one ... FAILED\ntest mod::two ... ok\ntest result: FAILED. 1 passed; 1 failed; 0 ignored`,
      `(pass) alpha\n(fail) beta\n 1 pass\n 1 fail`,
      `PASS src/x.test.ts\nFAIL src/y.test.ts\n  ● suite › broken\nTests: 1 failed, 3 passed, 4 total`,
      `unstructured plain stdout without runner markers`
    ]
    const shellCmds = [
      `cat a.txt > out.txt && echo hi >> log.txt < in.txt`,
      `cp src/a.ts dst/b.ts; mv tmp/c.ts tmp/d.ts; rm -rf build/out`,
      `sed -i 's/a/b/' "quoted/file name.ts" | tee /etc/outside.txt`,
      `FOO=1 git diff -- ~/secret.txt $(cat /tmp/sub.txt)`,
      `node -e "console.log(1)" 2>&1`
    ]

    const arb = Arbitrary.schema(
      Schema.Struct({
        hIdx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: htmlSamples.length - 1 }))),
        tIdx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: testOutputs.length - 1 }))),
        tIdx2: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: testOutputs.length - 1 }))),
        cIdx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: shellCmds.length - 1 }))),
        bomMode: Schema.Literals(["none", "utf8", "utf16le", "utf16be"]),
        clipLim: Schema.Literals([0, 3, 5, 12]),
        keep: Schema.Literals(["head", "tail"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ hIdx, tIdx, tIdx2, cIdx, bomMode, clipLim, keep }) =>
          Effect.gen(function*() {
            const pathSvc = yield* Path.Path
            const html = htmlSamples[hIdx]!
            expect(typeof Html.toText(html)).toBe("string")
            expect(typeof Html.toMarkdown(html)).toBe("string")

            const scope = Ignore.parse("/repo", ignoreRules[0]!)
            for (
              const cand of [
                { p: "/repo/a.log", dir: false },
                { p: "/repo/keep.log", dir: false },
                { p: "/repo/build", dir: true },
                { p: "/repo/build", dir: false },
                { p: "/repo/rootonly.txt", dir: false },
                { p: "/repo/sub/rootonly.txt", dir: false },
                { p: "/repo/x/deep/a.tmp", dir: false },
                { p: "/repo/file1.txt", dir: false },
                { p: "/repo/b.dat", dir: false },
                { p: "/repo/#literal", dir: false }
              ]
            ) {
              expect(
                typeof Ignore.ignored([scope], cand.p, pathSvc.basename(cand.p), cand.dir, (a, b) =>
                  pathSvc.relative(a, b))
              ).toBe("boolean")
            }

            const bomBytes = bomMode === "utf8"
              ? new Uint8Array([0xef, 0xbb, 0xbf, 0x61])
              : bomMode === "utf16le"
              ? new Uint8Array([0xff, 0xfe, 0x61, 0x00])
              : bomMode === "utf16be"
              ? new Uint8Array([0xfe, 0xff, 0x00, 0x61])
              : enc.encode("plain")
            expect(typeof Text.byteOrderMark(bomBytes)).toBe("string")
            const multi = "ab\u{1F680}漢cd\nef\n"
            expect(typeof Text.truncateBytes(multi, clipLim, { keep }).text).toBe("string")
            expect(typeof Text.clipUnits(multi, clipLim)).toBe("string")
            expect(typeof Text.elideMiddle("head", 42, "tail")).toBe("string")
            expect(typeof Text.notice("lines", 5, 20)).toBe("string")

            const r1 = TestReport.read({ stdout: testOutputs[tIdx]!, stderr: tIdx === 6 ? testOutputs[0]! : "" })
            const r2 = TestReport.parse(testOutputs[tIdx2]!)
            const attr = TestReport.attribute(r1, r2)
            expect(attr === undefined || Array.isArray(attr.introduced)).toBe(true)

            const refs = EnvelopePrecheck.commandReferences(pathSvc, shellCmds[cIdx]!)
            expect(Array.isArray(refs)).toBe(true)
            const outside = EnvelopePrecheck.outsideEnvelope(
              { reads: ["src/**"], writes: ["dst/**"], cwd: "/repo" },
              shellCmds[cIdx]!,
              pathSvc
            )
            expect(outside === undefined || outside instanceof StdError.StdError).toBe(true)
            return true
          }).pipe(Effect.provide(NodePath.layer)),
        { executions: fastExec, seed }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("ExaWebSearch, HttpNetwork.guarded/refusal, and Http.readBounded/withDeadline/capOutput", async () => {
    const exaModes = [
      "cred-get-fail",
      "cred-resolve-fail",
      "http-timeout",
      "http-fail",
      "429-numeric",
      "429-date",
      "429-no-header",
      "503-retry-after",
      "401",
      "403",
      "500",
      "400",
      "200-oversized",
      "200-bad-json",
      "200-ok-day",
      "200-ok-week"
    ] as const

    const arb = Arbitrary.schema(
      Schema.Struct({
        eIdx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: exaModes.length - 1 }))),
        netMode: Schema.Literals([
          "bad-url",
          "no-pinning",
          "localhost-denied",
          "localhost-granted",
          "resolve-unavailable",
          "resolve-fail",
          "resolve-empty",
          "private-ip-denied",
          "public-ip-ok",
          "refusal-variants"
        ])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ eIdx, netMode }) =>
          Effect.gen(function*() {
            const mode = exaModes[eIdx]!
            const ref = { id: "exa-key", name: "Exa" }
            const cred = Credential.Credential.of({
              ...Credential.makeNoop(),
              get: () => mode === "cred-get-fail" ? Effect.fail({ _tag: "NotFound" } as any) : Effect.succeed(ref),
              resolve: () =>
                mode === "cred-resolve-fail"
                  ? Effect.fail({ _tag: "Unavailable" } as any)
                  : Effect.succeed(Redacted.make("secret-exa"))
            })

            const http = HttpClient.make((req) => {
              if (mode === "http-timeout") {
                return Effect.fail(new Cause.TimeoutError() as any)
              }
              if (mode === "http-fail") {
                return Effect.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({ request: req, cause: new Error("conn refused") })
                  })
                )
              }
              if (mode === "200-oversized") {
                const bigChunk = new Uint8Array(1024 * 1024)
                const bodyStream = new ReadableStream<Uint8Array>({
                  start(controller) {
                    for (let k = 0; k < 6; k++) controller.enqueue(bigChunk)
                    controller.close()
                  }
                })
                return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(bodyStream, { status: 200 })))
              }
              const status = mode.startsWith("429")
                ? 429
                : mode === "503-retry-after"
                ? 503
                : mode === "401"
                ? 401
                : mode === "403"
                ? 403
                : mode === "500"
                ? 500
                : mode === "400"
                ? 400
                : 200
              const headers: Record<string, string> = { "content-type": "application/json" }
              if (mode === "429-numeric" || mode === "503-retry-after") headers["retry-after"] = "12"
              if (mode === "429-date") headers["retry-after"] = new Date(Date.now() + 10_000).toUTCString()
              const payload = mode === "200-bad-json"
                ? "{not json"
                : JSON.stringify({
                  results: [{ title: "T", url: "https://example.com", text: "snippet", publishedDate: "2026-01-01" }]
                })
              return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(payload, { status, headers })))
            })

            const exaLayer = ExaWebSearch.layer("exa-key").pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(Credential.Credential, cred),
                  Layer.succeed(HttpClient.HttpClient, http)
                )
              )
            )
            const exaRes = yield* Effect.result(
              Effect.flatMap(WebSearch.WebSearch, (svc) =>
                svc.search({
                  query: "smithers",
                  numResults: 3,
                  ...(mode === "200-ok-day"
                    ? { freshness: "day" as const }
                    : mode === "200-ok-week"
                    ? { freshness: "week" as const }
                    : {})
                })).pipe(Effect.provide(exaLayer))
            )
            expect(Result.isSuccess(exaRes)).toBe(mode === "200-ok-day" || mode === "200-ok-week")

            if (netMode === "refusal-variants") {
              expect(HttpNetwork.refusal(new Error("plain"))).toBeUndefined()
              const req = HttpClientRequest.get("https://example.com")
              const stdErr = new StdError.StdError({ code: "invalid_input", message: "bad" })
              const wrapped = new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request: req, cause: stdErr })
              })
              expect(HttpNetwork.refusal(wrapped)?.code).toBe("invalid_input")
              const plainWrap = new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request: req, cause: new Error("other") })
              })
              expect(HttpNetwork.refusal(plainWrap)).toBeUndefined()
              expect(Http.header({ "Content-Type": "text/plain" }, "content-type")).toBe("text/plain")
              expect(Http.capOutput("a".repeat(Text.MAX_OUTPUT_BYTES + 100)).truncated).toBe(true)
              expect(Http.requestError("https://example.com", wrapped).code).toBe("invalid_input")
              const badTimeout = yield* Effect.result(Http.withDeadline(Effect.void, "https://example.com", -1))
              expect(Result.isFailure(badTimeout)).toBe(true)
              const timedOut = yield* Effect.result(
                Http.withDeadline(Effect.sleep("200 millis"), "https://example.com", 0.01)
              )
              expect(Result.isFailure(timedOut)).toBe(true)
              const boundedFail = yield* Effect.result(
                Http.readBounded(Stream.fromIterable([new Uint8Array(6 * 1024 * 1024)]), "https://example.com")
              )
              expect(Result.isFailure(boundedFail)).toBe(true)
            } else {
              const rawClient = HttpClient.make((req) =>
                Effect.succeed(HttpClientResponse.fromWeb(req, new Response("ok", { status: 200 })))
              )
              const pinnedClient = netMode === "no-pinning"
                ? rawClient
                : KernelHttpClient.withDestinationPinning(rawClient)
              const guarded = HttpNetwork.guarded(pinnedClient, false)
              const grantLayer = netMode === "localhost-granted" || netMode === "public-ip-ok"
                ? GrantStore.layerNoop
                : Layer.succeed(GrantStore.GrantStore, {
                  ...GrantStore.makeNoop,
                  check: () => Effect.fail({ _tag: "GrantDenied" } as any)
                })
              const resolveLayer = Layer.succeed(
                KernelHttpClient.ResolveHost,
                (hostname: string) => {
                  if (netMode === "resolve-unavailable") {
                    return Effect.fail(new KernelHttpClient.ResolveHostUnavailable({ hostname, reason: "no dns" }))
                  }
                  if (netMode === "resolve-fail") {
                    return Effect.fail(new Error("dns err") as any)
                  }
                  if (netMode === "resolve-empty") return Effect.succeed([])
                  if (netMode === "private-ip-denied") return Effect.succeed(["127.0.0.1"])
                  return Effect.succeed(["93.184.216.34"])
                }
              )
              const targetUrl = netMode === "bad-url"
                ? "ftp://user:pass@example.com/file"
                : netMode === "localhost-denied" || netMode === "localhost-granted"
                ? "http://localhost:8080/api"
                : "https://example.com/api"
              const netRes = yield* Effect.result(
                guarded.execute(HttpClientRequest.get(targetUrl)).pipe(
                  Effect.provide(Layer.mergeAll(grantLayer, resolveLayer))
                )
              )
              if (netMode === "public-ip-ok" || netMode === "localhost-granted") {
                expect(Result.isSuccess(netRes)).toBe(true)
              } else {
                expect(Result.isFailure(netRes)).toBe(true)
              }
            }
            return true
          }) as Effect.Effect<boolean, never, never>,
        { executions: ioExec, seed: seed + 1 }
      )
    )
    assertPassed(report)
  }, 60_000)

  it(
    "Lsp operations, Preserve, ApplyPatch, Edit, PortableSearch/NativeSearch/Grep/Ls, and TestRun against base",
    async () => {
      const tmpRoot = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "smthrs-std-w10-")))
      try {
        const lspOps = [
          "definition",
          "references",
          "hover",
          "documentSymbols",
          "workspaceSymbols",
          "diagnostics",
          "implementation",
          "prepareCallHierarchy",
          "callHierarchyIncoming",
          "callHierarchyOutgoing"
        ] as const

        const arb = Arbitrary.schema(
          Schema.Struct({
            opIdx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: lspOps.length - 1 }))),
            lspFails: Schema.Boolean,
            fsMode: Schema.Literals([
              "preserve-and-edit-edges",
              "apply-patch-edges",
              "search-and-ls-edges",
              "test-run-base-missing-root",
              "test-run-base-git-repo"
            ])
          })
        )

        const report = await Effect.runPromise(
          Fuzz.run(
            arb,
            ({ opIdx, lspFails, fsMode }) =>
              Effect.gen(function*() {
                const dir = fs.mkdtempSync(nodePath.join(tmpRoot, "case-"))
                const op = lspOps[opIdx]!
                const lspInput: typeof Lsp.Input.Type = {
                  operation: op,
                  path: nodePath.join(dir, "a.ts"),
                  line: 1,
                  character: 1,
                  query: "foo"
                }
                expect(Lsp.effectsFor(lspInput)).toBeDefined()

                const mockLsp = lspFails
                  ? LanguageServer.layerNoop
                  : Layer.succeed(
                    LanguageServer.LanguageServer,
                    LanguageServer.make({
                      ...LanguageServer.makeNoop(),
                      definition: () => Effect.succeed([]),
                      references: () => Effect.succeed([]),
                      hover: () => Effect.succeed("hover text"),
                      documentSymbols: () => Effect.succeed([]),
                      workspaceSymbols: () => Effect.succeed([]),
                      diagnostics: () => Effect.succeed([]),
                      implementation: () => Effect.succeed([]),
                      prepareCallHierarchy: () => Effect.succeed([]),
                      callHierarchyIncoming: () => Effect.succeed([]),
                      callHierarchyOutgoing: () => Effect.succeed([])
                    })
                  )
                const lspRes = yield* Effect.result(Lsp.run(lspInput).pipe(Effect.provide(mockLsp)))
                expect(Result.isSuccess(lspRes) || Result.isFailure(lspRes)).toBe(true)

                if (fsMode === "preserve-and-edit-edges") {
                  const fsSvc = yield* FileSystem.FileSystem
                  const target = nodePath.join(dir, "pres.txt")
                  yield* Preserve.writeFileString(fsSvc, target, "line1\r\nline2\r\n")
                  yield* Preserve.writeFile(fsSvc, target, enc.encode("line1\r\nline3\r\n"))
                  const e1 = yield* Effect.result(
                    Edit.run({ path: target, oldString: "missing", newString: "x" }).pipe(
                      Effect.provide(LanguageServer.layerNoop)
                    )
                  )
                  expect(Result.isFailure(e1)).toBe(true)
                  const e2 = yield* Effect.result(
                    Edit.run({ path: target, oldString: "line1", newString: "line1" }).pipe(
                      Effect.provide(LanguageServer.layerNoop)
                    )
                  )
                  expect(Result.isSuccess(e2) || Result.isFailure(e2)).toBe(true)
                  fs.writeFileSync(target, "dup\ndup\n")
                  const e3 = yield* Effect.result(
                    Edit.run({ path: target, oldString: "dup", newString: "one" }).pipe(
                      Effect.provide(LanguageServer.layerNoop)
                    )
                  )
                  expect(Result.isFailure(e3)).toBe(true)
                  const e4 = yield* Edit.run({ path: target, oldString: "dup", newString: "one", replaceAll: true })
                    .pipe(
                      Effect.provide(LanguageServer.layerNoop)
                    )
                  expect(e4.replacements).toBe(2)
                } else if (fsMode === "apply-patch-edges") {
                  const upd = nodePath.join(dir, "upd.txt")
                  const mov = nodePath.join(dir, "moved.txt")
                  const del = nodePath.join(dir, "del.txt")
                  const add = nodePath.join(dir, "added.txt")
                  fs.writeFileSync(upd, "alpha\nbeta\ngamma\n")
                  fs.writeFileSync(del, "bye\n")
                  const patch = [
                    "*** Begin Patch",
                    `*** Add File: ${add}`,
                    "+hello",
                    "+world",
                    `*** Update File: ${upd}`,
                    `*** Move to: ${mov}`,
                    "@@",
                    " alpha",
                    "-beta",
                    "+BETA",
                    " gamma",
                    `*** Delete File: ${del}`,
                    "*** End Patch"
                  ].join("\n")
                  const applied = yield* ApplyPatch.run({ input: patch }).pipe(Effect.provide(LanguageServer.layerNoop))
                  expect(applied.added.length + applied.modified.length + applied.deleted.length)
                    .toBeGreaterThanOrEqual(2)
                  const bad1 = yield* Effect.result(
                    ApplyPatch.run({
                      input: `*** Begin Patch\n*** Update File: ${
                        nodePath.join(dir, "nope.txt")
                      }\n@@\n-a\n+b\n*** End Patch`
                    }).pipe(
                      Effect.provide(LanguageServer.layerNoop)
                    )
                  )
                  expect(Result.isFailure(bad1)).toBe(true)
                } else if (fsMode === "search-and-ls-edges") {
                  fs.writeFileSync(nodePath.join(dir, ".gitignore"), "ignored.txt\n")
                  fs.writeFileSync(nodePath.join(dir, "ignored.txt"), "needle\n")
                  fs.writeFileSync(nodePath.join(dir, "keep.ts"), "export const needle = 42\n// second needle\n")
                  fs.writeFileSync(nodePath.join(dir, "bin.dat"), Buffer.from([0, 1, 2, 0, 65, 66]))
                  const portRes = yield* Effect.flatMap(Search.Search, (s) =>
                    s.grep({
                      pattern: "needle",
                      root: dir,
                      fixedStrings: false,
                      ignoreCase: true,
                      smartCase: false,
                      globs: ["*.ts"],
                      beforeContext: 0,
                      afterContext: 0,
                      filesWithMatches: false,
                      hidden: false,
                      symbols: false,
                      limit: 50
                    })).pipe(Effect.provide(PortableSearch.layer))
                  expect(portRes.matches.length).toBeGreaterThan(0)
                  const invalidRe = yield* Effect.exit(
                    Effect.flatMap(Search.Search, (s) =>
                      s.grep({
                        pattern: "[unclosed",
                        root: dir,
                        fixedStrings: false,
                        ignoreCase: false,
                        smartCase: false,
                        globs: [],
                        beforeContext: 0,
                        afterContext: 0,
                        filesWithMatches: false,
                        hidden: false,
                        symbols: false,
                        limit: 50
                      })).pipe(Effect.provide(PortableSearch.layer))
                  )
                  expect(invalidRe._tag).toBe("Failure")
                  if (invalidRe._tag === "Failure") {
                    const reason = invalidRe.cause.reasons[0]
                    expect(reason?._tag).toBe("Fail")
                    if (reason?._tag === "Fail") expect(reason.error.code).toBe("invalid_pattern")
                  }
                  const grepOut = yield* Grep.run({ pattern: "needle", root: dir }).pipe(
                    Effect.provide(NativeSearch.layer)
                  )
                  expect(grepOut.matches.length).toBeGreaterThan(0)
                  const lsOut = yield* Ls.run({ path: dir, offset: 0, limit: 10 })
                  expect(lsOut.entries.length).toBeGreaterThan(0)
                } else if (fsMode === "test-run-base-missing-root") {
                  const runnerLayer = TestRunner.layer({
                    command: `${process.execPath} -e "console.log('1 pass')"`
                  })
                  const r = yield* Effect.result(
                    TestRun.run({ against: "base" }).pipe(
                      Effect.provide(Layer.mergeAll(runnerLayer, Evaluator.layerUnavailable()))
                    )
                  )
                  expect(Result.isFailure(r)).toBe(true)
                } else if (fsMode === "test-run-base-git-repo") {
                  cp.execFileSync("git", ["init", "-q"], { cwd: dir })
                  cp.execFileSync("git", ["config", "user.email", "w10@example.com"], { cwd: dir })
                  cp.execFileSync("git", ["config", "user.name", "W10"], { cwd: dir })
                  fs.writeFileSync(
                    nodePath.join(dir, "check.mjs"),
                    "console.log('Test Files  1 passed (1)\\n     Tests  1 passed (1)')\n"
                  )
                  cp.execFileSync("git", ["add", "."], { cwd: dir })
                  cp.execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir })
                  const runnerLayer = TestRunner.layer({
                    root: dir,
                    cwd: dir,
                    command: `${process.execPath} check.mjs`
                  })
                  const res = yield* TestRun.run({ against: "base" }).pipe(
                    Effect.provide(Layer.mergeAll(runnerLayer, Evaluator.layerUnavailable()))
                  )
                  expect(res.exitCode).toBe(0)
                  expect(res.base).toBeDefined()
                }
                return true
              }).pipe(Effect.provide(realHost)),
            { executions: ioExec, seed: seed + 2 }
          )
        )
        assertPassed(report)
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true })
      }
    },
    90_000
  )
})
