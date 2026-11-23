import * as Evaluator from "@smthrs/model/Evaluator"
import { CapabilityPattern } from "@smthrs/capability/Capability"
import { Rule } from "@smthrs/capability/Permission"
import * as Credential from "@smthrs/control/Credential"
import { Fuzz } from "@smthrs/fuzz"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as HttpClient from "@smthrs/kernel/HttpClient"
import { ResolveHost } from "@smthrs/kernel/HttpClient"
import * as Workspace from "@smthrs/kernel/Workspace"
import { Arbitrary, Effect, FileSystem, Layer, Path, Redacted, Result, Schema } from "effect"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { describe, expect, it } from "vitest"
import {
  ApplyPatch,
  Bash,
  Checkpoints,
  Container,
  Edit,
  ExaWebSearch,
  Explore,
  Fetch,
  Glob,
  Grep,
  HttpPost,
  LanguageServer,
  Ls,
  Lsp,
  Manifest,
  Read,
  Relocate,
  ShellCommand,
  TestRun,
  TestRunner,
  TreeFingerprint,
  UpdatePlan,
  WebFetch,
  WebSearch,
  Write
} from "../src/index.ts"
import {
  deriveNewContents,
  parsePatch,
  printSummary,
  seekSequence,
  StreamingPatchParser
} from "../src/internal/ApplyPatch.ts"
import * as CodexText from "../src/internal/CodexText.ts"
import { commandReferences, outsideEnvelope } from "../src/internal/EnvelopePrecheck.ts"
import * as Grouping from "../src/internal/Grouping.ts"
import * as Html from "../src/internal/Html.ts"
import * as Ignore from "../src/internal/Ignore.ts"
import * as IpAddress from "../src/internal/IpAddress.ts"
import * as LinearRegex from "../src/internal/LinearRegex.ts"
import * as Match from "../src/internal/Match.ts"
import * as Symbols from "../src/internal/Symbols.ts"
import * as Tar from "../src/internal/Tar.ts"
import * as TestReport from "../src/internal/TestReport.ts"
import { layer } from "./TestLayers.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const assertPassed = (report: Parameters<typeof Fuzz.formatReport>[0]): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const makeNetLayer = (
  ips: ReadonlyArray<string>,
  responder: (url: string, method: string) => Response
) =>
  Layer.mergeAll(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.withDestinationPinning(
        HttpClient.make((req) => Effect.sync(() => HttpClientResponse.fromWeb(req, responder(req.url, req.method))))
      )
    ),
    Layer.succeed(ResolveHost, () => Effect.succeed(ips)),
    GrantStore.layer({
      attended: false,
      rules: [
        new Rule({ effect: "allow", pattern: new CapabilityPattern({ action: "net:get", resource: "*" }) }),
        new Rule({ effect: "allow", pattern: new CapabilityPattern({ action: "net:post", resource: "*" }) })
      ]
    }).pipe(Layer.provide(Workspace.layer("/workspace")))
  )

const makeTar = (entries: ReadonlyArray<{ readonly name: string; readonly content: string }>): Uint8Array => {
  const enc = new TextEncoder()
  const blocks: Array<Uint8Array> = []
  for (const entry of entries) {
    const data = enc.encode(entry.content)
    const header = new Uint8Array(512)
    header.set(enc.encode(entry.name).subarray(0, 100), 0)
    header.set(enc.encode("0000644\0"), 100)
    header.set(enc.encode("0000000\0"), 108)
    header.set(enc.encode("0000000\0"), 116)
    header.set(enc.encode(`${data.length.toString(8).padStart(11, "0")}\0`), 124)
    header.set(enc.encode("00000000000\0"), 136)
    header.fill(0x20, 148, 156)
    header[156] = 0x30 // '0' regular file
    header.set(enc.encode("ustar\0"), 257)
    header.set(enc.encode("00"), 263)
    let sum = 0
    for (let i = 0; i < 512; i += 1) sum += header[i]!
    header.set(enc.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148)
    blocks.push(header)
    if (data.length > 0) {
      const padded = new Uint8Array(Math.ceil(data.length / 512) * 512)
      padded.set(data, 0)
      blocks.push(padded)
    }
  }
  blocks.push(new Uint8Array(1024))
  const total = blocks.reduce((acc, b) => acc + b.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const b of blocks) {
    out.set(b, offset)
    offset += b.length
  }
  return out
}

describe("@smthrs/std fuzz invariants", () => {
  it("ApplyPatch parser, StreamingPatchParser chunk invariance, seekSequence & ApplyPatch.run", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        kind: Schema.Literals([
          "add",
          "delete",
          "update",
          "update-move",
          "update-eof",
          "multi-hunk",
          "bad-header",
          "bad-footer",
          "empty-update",
          "traversal",
          "missing-context"
        ]),
        chunkSize: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 19 }))),
        lineA: Schema.Literals(["alpha", "const x = 1", "foo  ", "hello"]),
        lineB: Schema.Literals(["beta", "const y = 2", "bar", "world"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ kind, chunkSize, lineA, lineB }) =>
          Effect.gen(function*() {
            const initial = {
              "/a.txt": `${lineA}\nkeep\n${lineB}\n`,
              "/del.txt": "remove me\n"
            }
            const patch = kind === "add"
              ? `*** Begin Patch\n*** Add File: /new.txt\n+${lineA}\n+${lineB}\n*** End Patch`
              : kind === "delete"
              ? `*** Begin Patch\n*** Delete File: /del.txt\n*** End Patch`
              : kind === "update"
              ? `*** Begin Patch\n*** Update File: /a.txt\n@@\n ${lineA}\n-keep\n+changed\n ${lineB}\n*** End Patch`
              : kind === "update-move"
              ? `*** Begin Patch\n*** Update File: /a.txt\n*** Move to: /moved.txt\n@@\n ${lineA}\n-keep\n+moved\n ${lineB}\n*** End Patch`
              : kind === "update-eof"
              ? `*** Begin Patch\n*** Update File: /a.txt\n@@\n ${lineB}\n+tail\n*** End of File\n*** End Patch`
              : kind === "multi-hunk"
              ? `*** Begin Patch\n*** Add File: /added.txt\n+hi\n*** Update File: /a.txt\n@@\n-keep\n+kept\n*** Delete File: /del.txt\n*** End Patch`
              : kind === "bad-header"
              ? `not begin\n*** End Patch`
              : kind === "bad-footer"
              ? `*** Begin Patch\n*** Add File: /x\n+1`
              : kind === "empty-update"
              ? `*** Begin Patch\n*** Update File: /a.txt\n*** End Patch`
              : kind === "traversal"
              ? `*** Begin Patch\n*** Add File: /../escape.txt\n+bad\n*** End Patch`
              : `*** Begin Patch\n*** Update File: /a.txt\n@@\n-nonexistent-line\n+nope\n*** End Patch`

            // 1. Compare StreamingPatchParser across arbitrary chunk splits against parsePatch
            let batchResult: ReturnType<typeof parsePatch> | undefined
            let batchErr: unknown
            try {
              batchResult = parsePatch(patch)
            } catch (err) {
              batchErr = err
            }

            let streamHunks: ReadonlyArray<unknown> | undefined
            let streamErr: unknown
            try {
              const parser = new StreamingPatchParser()
              for (let i = 0; i < patch.length; i += chunkSize) {
                parser.pushDelta(patch.slice(i, i + chunkSize))
              }
              streamHunks = parser.finish()
            } catch (err) {
              streamErr = err
            }

            if ((batchErr === undefined) !== (streamErr === undefined)) return false
            if (batchResult !== undefined && streamHunks !== undefined) {
              if (JSON.stringify(batchResult.hunks) !== JSON.stringify(streamHunks)) return false
            }

            const foundIdx = seekSequence([lineA.trimEnd(), "keep", lineB], ["keep"], 0, false)
            if (foundIdx !== 1) return false
            if (batchResult !== undefined && kind === "update") {
              const hunk = batchResult.hunks[0]
              if (hunk !== undefined && hunk.kind === "update") {
                const derived = deriveNewContents(initial["/a.txt"], "/a.txt", hunk.chunks)
                if (!derived.includes("changed")) return false
              }
              const summary = printSummary({ added: ["/new.txt"], modified: ["/a.txt"], deleted: ["/del.txt"] })
              if (!summary.includes("A /new.txt") || !summary.includes("M /a.txt") || !summary.includes("D /del.txt")) {
                return false
              }
            }

            // 2. Run ApplyPatch.run over real memory FS layer
            const res = yield* Effect.result(
              Effect.gen(function*() {
                const applied = yield* ApplyPatch.run({ input: patch })
                const fs = yield* FileSystem.FileSystem
                const aExists = yield* fs.exists("/a.txt")
                return { applied, aExists }
              }).pipe(Effect.provide(layer({ files: initial })))
            )

            const expectFailure = kind === "bad-header" || kind === "bad-footer" || kind === "empty-update" ||
              kind === "missing-context"
            if (expectFailure) {
              if (Result.isSuccess(res)) return false
            } else if (kind !== "traversal") {
              if (Result.isFailure(res)) throw new Error(`ApplyPatch failed for ${kind}: ${JSON.stringify(res)}`)
            }
            return true
          }),
        { seed, executions }
      )
    )
    assertPassed(report)
  })

  it("Read, Write, Edit, Ls, Glob, Grep, UpdatePlan, Tar, Html, TestReport & Manifest uphold invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        crlf: Schema.Boolean,
        replaceAll: Schema.Boolean,
        useLineAnchor: Schema.Boolean,
        grepFixed: Schema.Boolean,
        grepCaseInsensitive: Schema.Boolean,
        word: Schema.Literals(["needle", "target_fn", "item42", "token"]),
        reportKind: Schema.Literals(["vitest", "pytest", "go", "unittest", "bun"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ crlf, replaceAll, useLineAnchor, grepFixed, grepCaseInsensitive, word, reportKind }) =>
          Effect.gen(function*() {
            const eol = crlf ? "\r\n" : "\n"
            const content = `function demo() {${eol}  const a = "${word}"${eol}  const b = "${word}"${eol}}${eol}`
            const files = {
              "/src/app.ts": content,
              "/src/sub/readme.md": `# Title\nmentions ${word} here\n`,
              "/.gitignore": "*.log\n",
              "/debug.log": `${word} ignored\n`
            }

            const ok = yield* Effect.gen(function*() {
              yield* Write.run({ path: "/src/written.ts", content: `export const v = "${word}"\n` })
              const page = yield* Read.run({ path: "/src/app.ts", offset: 1, limit: 10 })
              if (!page.content.includes(word)) return false

              const line2 = yield* Read.run({ path: "/src/app.ts", offset: 2, limit: 1 })
              const editRes = yield* Effect.result(
                Edit.run({
                  path: "/src/app.ts",
                  ...(useLineAnchor
                    ? { startLine: line2.startLine, endLine: line2.endLine, expect: line2.content }
                    : { oldString: word, replaceAll }),
                  newString: useLineAnchor ? line2.content.replace(word, "UPDATED") : "UPDATED"
                })
              )
              if (!useLineAnchor && !replaceAll) {
                if (Result.isSuccess(editRes)) return false
              } else {
                if (Result.isFailure(editRes)) return false
              }

              const listed = yield* Ls.run({ path: "/src" })
              if (listed.entries.length < 2) return false
              const globbed = yield* Glob.run({ pattern: "**/*.ts", root: "/src" })
              if (globbed.paths.length < 2) return false
              const grepped = yield* Grep.run({
                pattern: grepCaseInsensitive ? word.toUpperCase() : word,
                root: "/src",
                fixedStrings: grepFixed,
                ignoreCase: grepCaseInsensitive,
                context: 0
              })
              if (grepped.matches.length === 0) return false

              const planOut = yield* UpdatePlan.run({
                explanation: "fuzz plan",
                plan: [
                  { step: "step 1", status: "completed" },
                  { step: "step 2", status: "in_progress" },
                  { step: "step 3", status: "pending" }
                ]
              })
              if (planOut.output !== "Plan updated") return false

              return true
            }).pipe(Effect.provide(layer({ files })))

            if (!ok) return false

            // LinearRegex, Match, Ignore, Html, CodexText, Symbols, Grouping, TestReport, Tar, Manifest, Explore
            const rx = LinearRegex.compile(word, grepCaseInsensitive)
            const gen = rx.test(`prefix ${word} suffix`)
            let step = gen.next()
            while (!step.done) step = gen.next()
            if (!step.value) return false

            const locs = Match.locate(content, word)
            if (locs.length !== 2) return false
            const near = Match.nearest(content, `const a = "${word}"`)
            if (near === undefined) return false
            const hk = Match.hunk(content, locs[0]!.start, locs[0]!.end)
            if (hk.startLine < 1) return false

            const scope = Ignore.parse("/", "*.log\n!keep.log\nbuild/\n# comment\n")
            const rel = (from: string, to: string) => to.startsWith(from) ? to.slice(from.length) : to
            if (!Ignore.ignored([scope], "/debug.log", "debug.log", false, rel)) return false
            if (Ignore.ignored([scope], "/keep.log", "keep.log", false, rel)) return false

            const html = `<h1>${word}</h1><p>hello &amp; <a href="https://example.com">link</a></p><ul><li>item</li></ul><pre><code>x = 1</code></pre><script>evil()</script>`
            const plain = Html.toText(html)
            const md = Html.toMarkdown(html)
            if (!plain.includes(word) || plain.includes("evil()") || !md.includes(word)) return false

            const trunc = CodexText.truncateMiddleWithTokenBudget("a".repeat(200), 10)
            const truncChars = CodexText.truncateMiddleChars("b".repeat(200), 30)
            const formatted = CodexText.formatExecOutputForModel({
              output: "ok\n",
              exitCode: 0,
              durationSeconds: 0.1,
              maxOutputTokens: 100
            })
            if (trunc.text.length === 0 || truncChars.length === 0 || !formatted.includes("ok")) return false

            const sym = Symbols.enclosing(["export function foo() {", "  return 1", "}"], 2)
            if (sym?.name !== "foo") return false

            const grouped = Grouping.group([
              { file: "/src/app.ts", line: 1, text: "function demo() {", kind: "context" },
              { file: "/src/app.ts", line: 2, text: `  const a = "${word}"`, kind: "match" }
            ])
            const annotated = Grouping.annotate(grouped, new Map([["/src/app.ts", content.split(/\r?\n/)]]))
            if (annotated.length !== 1) return false

            const reportText = reportKind === "vitest"
              ? "FAIL test/a.test.ts > fails\nTests  1 failed | 2 passed (3)\n"
              : reportKind === "pytest"
              ? "FAILED test_a.py::test_one - AssertionError\n1 failed, 2 passed in 0.1s\n"
              : reportKind === "go"
              ? "--- PASS: TestOk (0.00s)\n--- FAIL: TestBad (0.00s)\nFAIL\n"
              : reportKind === "unittest"
              ? "FAIL: test_x (test_mod.MyTest)\nRan 2 tests in 0.01s\nFAILED (failures=1)\n"
              : "2 pass\n1 fail\n"
            const tr = TestReport.read({ stdout: reportText, stderr: "" })
            const attr = TestReport.attribute(tr, { passed: 2, failed: [], parsed: true, reportedFailed: 0 })
            if (tr.passed < 0 || (tr.parsed && attr === undefined)) return false

            // Valid tar round-trip + invalid tar refusal
            const tarBytes = makeTar([{ name: `dir/${word}.txt`, content: `hello ${word}` }])
            const extracted = Tar.files(tarBytes)
            if (extracted === undefined || extracted.size !== 1) return false
            if (Tar.files(new Uint8Array(512).fill(0x41)) !== undefined) return false

            // Relocate precheck
            const relocCheck = Relocate.precheck("read", { path: "/workspace/a.ts" })
            const relocUnk = Relocate.precheck("unknown_flow", {})
            return (relocCheck === undefined || "_tag" in relocCheck) && (relocUnk === undefined || "_tag" in relocUnk) && Manifest.names.length > 0 && Explore.flow.flows.length === 4
          }),
        { seed: seed + 1, executions: Math.min(executions, 80) }
      )
    )
    assertPassed(report)
  })

  it("Fetch, HttpPost, WebFetch, ExaWebSearch & IpAddress enforce SSRF/private-IP and scheme safety", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        ip: Schema.Literals([
          "93.184.216.34",
          "127.0.0.1",
          "10.0.0.1",
          "172.16.0.5",
          "192.168.1.1",
          "169.254.169.254",
          "100.64.0.1",
          "0.0.0.0",
          "::1",
          "::ffff:127.0.0.1",
          "::ffff:169.254.169.254",
          "fc00::1",
          "fe80::1",
          "2606:2800:220:1:248:1893:25c8:1946",
          "not-an-ip"
        ]),
        urlKind: Schema.Literals(["https-ok", "http-localhost", "file-scheme", "ftp-scheme", "bad-url"]),
        status: Schema.Literals([200, 400, 404]),
        contentType: Schema.Literals(["text/html", "application/json", "text/plain"])
      })
    )

    const credLayer = Layer.succeed(
      Credential.Credential,
      Credential.Credential.of({
        ...Credential.makeNoop(),
        get: (id) => Effect.succeed({ id, name: "Test Exa" }),
        resolve: () => Effect.succeed(Redacted.make("exa-secret-key"))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ ip, urlKind, status, contentType }) =>
          Effect.gen(function*() {
            const fam = IpAddress.family(ip)
            const pub = IpAddress.isPublic(ip)
            const isKnownPublic = ip === "93.184.216.34" || ip === "2606:2800:220:1:248:1893:25c8:1946"
            if (ip === "not-an-ip" && (fam !== 0 || pub)) return false
            if (isKnownPublic && !pub) return false
            if (!isKnownPublic && pub) return false

            const url = urlKind === "https-ok"
              ? "https://example.com/docs"
              : urlKind === "http-localhost"
              ? "http://localhost/admin"
              : urlKind === "file-scheme"
              ? "file:///etc/passwd"
              : urlKind === "ftp-scheme"
              ? "ftp://example.com/a"
              : ":::invalid"

            let httpCalled = 0
            const bodyText = contentType === "text/html"
              ? "<html><body><h1>Docs</h1><p>Hello</p></body></html>"
              : contentType === "application/json"
              ? JSON.stringify({ results: [{ title: "T", url: "https://example.com", text: "snippet" }] })
              : "plain body"

            const resolvedIps = isKnownPublic ? [ip] : [ip === "not-an-ip" ? "127.0.0.1" : ip]
            const netLayer = makeNetLayer(resolvedIps, () => {
              httpCalled += 1
              return new Response(bodyText, { status, headers: { "content-type": contentType } })
            })

            const fetchRes = yield* Effect.result(Fetch.run({ url }).pipe(Effect.provide(netLayer)))
            const postRes = yield* Effect.result(
              HttpPost.run({ url, body: "{\"a\":1}" }).pipe(Effect.provide(netLayer))
            )
            const webRes = yield* Effect.result(
              WebFetch.run({ url, format: "markdown" }).pipe(Effect.provide(netLayer))
            )

            if (urlKind !== "https-ok" || !isKnownPublic) {
              if (Result.isSuccess(fetchRes) || Result.isSuccess(postRes) || Result.isSuccess(webRes)) return false
              if (httpCalled !== 0) return false
            } else {
              if (Result.isFailure(fetchRes)) return false
              if (fetchRes.success.status !== status) return false
              if (Result.isFailure(postRes)) return false
            }

            // ExaWebSearch + WebSearch over injected HttpClient + Credential
            const exaNet = makeNetLayer(["93.184.216.34"], () =>
              new Response(
                JSON.stringify({
                  results: [{ title: "Doc", url: "https://example.com/doc", text: "hello world" }]
                }),
                { status, headers: { "content-type": "application/json" } }
              )
            )
            const exaLayer = ExaWebSearch.layer("test-exa").pipe(
              Layer.provide(Layer.merge(credLayer, exaNet))
            )
            const wsRes = yield* Effect.result(
              WebSearch.run({ query: "smithers" }).pipe(Effect.provide(exaLayer))
            )
            if (status === 200 && Result.isFailure(wsRes)) return false
            if (status !== 200 && Result.isSuccess(wsRes)) return false
            return true
          }),
        { seed: seed + 2, executions: Math.min(executions, 80) }
      )
    )
    assertPassed(report)
  })

  it("EnvelopePrecheck, Container, TreeFingerprint, Checkpoints, Lsp, Bash, ShellCommand & TestRun", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        cmdKind: Schema.Literals([
          "safe-read",
          "write-outside",
          "newline-rm",
          "pipe-redirect",
          "subshell-escape",
          "chmod-outside"
        ]),
        containerName: Schema.Literals(["devbox", "bad;rm", "", "-flag"]),
        envVar: Schema.Literals(["VALID_VAR", "123BAD", "BAD=VAL"]),
        lspOp: Schema.Literals(["hover", "definition", "references", "diagnostics"])
      })
    )

    const pathSvc = Effect.runSync(Effect.provide(Effect.flatMap(Path.Path, Effect.succeed), Path.layer))

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ cmdKind, containerName, envVar, lspOp }) =>
          Effect.gen(function*() {
            const script = cmdKind === "safe-read"
              ? "cat /work/a.ts"
              : cmdKind === "write-outside"
              ? "echo hi > /etc/passwd"
              : cmdKind === "newline-rm"
              ? "echo hi\nrm -rf /outside/target"
              : cmdKind === "pipe-redirect"
              ? "cat /work/a.ts | tee /outside/out.txt"
              : cmdKind === "subshell-escape"
              ? "echo $(cat /etc/shadow)"
              : "chmod 777 /outside/file"

            const refs = commandReferences(pathSvc, script)
            const refusal = outsideEnvelope(
              { cwd: "/work", reads: ["/work", "/work/**"], writes: ["/work", "/work/**"] },
              script,
              pathSvc
            )
            if (cmdKind === "safe-read") {
              if (refusal !== undefined) throw new Error(`unexpected refusal: ${JSON.stringify(refusal)}`)
            } else {
              if (refusal === undefined) return false
            }

            // Container command builder & noop
            const cmdContainer = Container.makeCommand({ program: "docker" })
            const planRes = yield* Effect.result(
              cmdContainer.exec({
                container: containerName,
                file: "sh",
                args: ["-c", "echo hi"],
                stdin: false,
                cwd: "/work",
                env: { [envVar]: "1" }
              })
            )
            const badContainer = containerName === "" || containerName.startsWith("-")
            const badEnv = envVar !== "VALID_VAR"
            if (badContainer || badEnv) {
              if (Result.isSuccess(planRes)) return false
            } else if (Result.isFailure(planRes)) {
              return false
            }

            const noopContainer = yield* Effect.result(
              Container.makeNoop().exec({ container: "devbox", file: "sh", args: [], stdin: false })
            )
            if (Result.isSuccess(noopContainer)) return false

            // Lsp flow over LanguageServer.layerNoop & custom responding LanguageServer
            const fsLayer = layer({ files: { "/src/a.ts": "export const x = 1\n" } })
            const lspNoopRes = yield* Effect.result(
              Lsp.run({ operation: lspOp, path: "/src/a.ts", line: 1, character: 0 }).pipe(
                Effect.provide(Layer.merge(fsLayer, LanguageServer.layerNoop))
              )
            )
            if (Result.isSuccess(lspNoopRes)) return false

            const lspLive = Layer.succeed(
              LanguageServer.LanguageServer,
              LanguageServer.make({
                ...LanguageServer.makeNoop(),
                hover: () => Effect.succeed({ contents: "number" }),
                definition: () => Effect.succeed([{ path: "/src/a.ts", line: 1, character: 13 }]),
                references: () => Effect.succeed([]),
                diagnostics: () => Effect.succeed([])
              })
            )
            const lspOkRes = yield* Effect.result(
              Lsp.run({ operation: lspOp, path: "/src/a.ts", line: 1, character: 0 }).pipe(
                Effect.provide(Layer.merge(fsLayer, lspLive))
              )
            )
            if (Result.isFailure(lspOkRes)) throw new Error(`lspOkRes failed: ${JSON.stringify(lspOkRes)}`)

            // TreeFingerprint, Checkpoints.layerNoop, Bash/ShellCommand/TestRun declarations
            const around = TreeFingerprint.around()
            if (around.length === 0) return false
            const cpNoop = yield* Effect.result(
              Effect.flatMap(Checkpoints.Checkpoints, (c) => c.capture("snap-1")).pipe(
                Effect.provide(Checkpoints.layerNoop)
              )
            )
            if (Result.isSuccess(cpNoop)) return false

            const trNoop = yield* Effect.result(
              TestRun.run({}).pipe(
                Effect.provide(Layer.mergeAll(fsLayer, TestRunner.layerNoop, Checkpoints.layerNoop, Container.layerNoop, Evaluator.layerUnavailable()))
              )
            )
            if (Result.isSuccess(trNoop)) return false

            return refs.length >= 0 && Bash.flow.name === "bash" && ShellCommand.flow.name === "shell_command"
          }),
        { seed: seed + 3, executions: Math.min(executions, 80) }
      )
    )
    assertPassed(report)
  })

  it("LinearRegex.compile terminates and rejects unterminated character classes and quantifiers instead of looping forever", async () => {
    const report = await Effect.runPromise(
      Fuzz.run(
        Arbitrary.schema(
          Schema.Struct({
            bad: Schema.Literals(["[unclosed", "[a-z", "[\\]", "a{1", "a{1,2", "(abc[def", "[a\\"]),
            insensitive: Schema.Boolean
          })
        ),
        ({ bad, insensitive }) =>
          Effect.sync(() => {
            try {
              LinearRegex.compile(bad, insensitive)
              return false
            } catch {
              return true
            }
          }),
        { seed: seed + 77, executions: 60 }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
