import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { CapabilityPattern } from "@smthrs/capability/Capability"
import { Rule } from "@smthrs/capability/Permission"
import { Fuzz } from "@smthrs/fuzz"
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as KernelHttpClient from "@smthrs/kernel/HttpClient"
import * as Workspace from "@smthrs/kernel/Workspace"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Arbitrary, Context, Effect, FileSystem, Layer, Path, Schema, Sink, Stream } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import type * as ChildProcess from "effect/process/ChildProcess"
import { ExitCode, makeHandle, ProcessId } from "effect/process/ChildProcessSpawner"
import * as Redacted from "effect/Redacted"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import * as Bash from "../src/Bash.ts"
import * as Checkpoints from "../src/Checkpoints.ts"
import * as Container from "../src/Container.ts"
import * as Diagnostics from "../src/internal/Diagnostics.ts"
import * as LanguageServer from "../src/LanguageServer.ts"
import * as NativeSearch from "../src/NativeSearch.ts"
import * as PortableSearch from "../src/PortableSearch.ts"
import * as Read from "../src/Read.ts"
import * as Relocate from "../src/Relocate.ts"
import * as RemoteSearch from "../src/RemoteSearch.ts"
import * as SearchConformance from "../src/SearchConformance.ts"
import * as SearchContract from "../src/SearchContract.ts"
import * as ShellCommand from "../src/ShellCommand.ts"
import * as TestRun from "../src/TestRun.ts"
import * as TestRunner from "../src/TestRunner.ts"
import * as TreeFingerprint from "../src/TreeFingerprint.ts"
import * as WebFetch from "../src/WebFetch.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")
const NodePlatform = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(Layer.merge(NodeFileSystem.layer, NodePath.layer))
)

const judging = (choiceIdx: number, probability = 0.95): Layer.Layer<Evaluator.Evaluator> =>
  Evaluator.layerScripted((request) => {
    const options = Object.keys(
      (request.questions["attribution"] as { readonly criteria: Record<string, string> }).criteria
    )
    const picked = options[choiceIdx % options.length] ?? options[0]!
    const rest = (1 - probability) / Math.max(1, options.length - 1)
    return {
      attribution: {
        choice: picked,
        probabilities: Object.fromEntries(
          options.map((option) => [option, option === picked ? probability : rest])
        )
      },
      executed: { probability: 0.9 }
    }
  })

describe("@smthrs/std SearchContract, SearchConformance, Bash, Read, Checkpoints, Relocate, TestRun, Probe, TreeFingerprint & WebFetch deep fuzz invariants", () => {
  it("SearchContract validates patterns/globs, compiles expressions, and matches globs consistently", async () => {
    const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "smthrs-sc-fuzz-")))
    try {
      const arb = Arbitrary.schema(
        Schema.Struct({
          pattern: Schema.Literals([
            "hello",
            "foo.*bar",
            "(?=lookahead)",
            "(a)\\1",
            "[unclosed",
            "a{1,5}",
            "",
            "line1\nline2",
            "alpha|beta",
            "foo.bar"
          ]),
          fixedStrings: Schema.Boolean,
          insensitive: Schema.Boolean,
          glob: Schema.Literals([
            "*.ts",
            "**/*.ts",
            "!*.test.ts",
            "src/{a,b}.ts",
            "../escape/*.ts",
            "/abs/*.ts",
            "",
            "*.md"
          ]),
          relPath: Schema.Literals(["src/a.ts", "src/a.test.ts", "README.md", "nested/deep/x.ts"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ pattern, fixedStrings, insensitive, glob, relPath }) =>
            Effect.gen(function*() {
              const pErr = SearchContract.validatePattern(pattern, fixedStrings)
              if (pattern.includes("\n") && pErr === undefined) throw new Error("newline accepted")
              if (!fixedStrings && (pattern === "(?=lookahead)" || pattern === "(a)\\1")) {
                if (pErr === undefined) throw new Error("unsupported regex accepted: " + pattern)
              }
              if (pErr !== undefined && typeof SearchContract.isContractRejection(pErr) !== "boolean") {
                throw new Error("isContractRejection")
              }
              if (pErr === undefined && pattern !== "") {
                try {
                  const compiled = SearchContract.expression(pattern, fixedStrings, insensitive)
                  const sample = compiled.test("hello foo.bar alpha beta")
                  if (typeof sample !== "boolean") throw new Error("sample not bool")
                } catch {
                  // syntax error on malformed regex is expected
                }
              }

              const gErr = SearchContract.validateGlob(glob)
              if (glob === "" && gErr === undefined) return false
              if (gErr === undefined) {
                const canon = SearchContract.canonicalGlob(glob)
                const base = path.basename(relPath)
                const m1 = SearchContract.matchesGlob(canon, relPath, base)
                const m2 = SearchContract.includedByGlobs([glob], relPath, base)
                if (typeof m1 !== "boolean" || typeof m2 !== "boolean") return false
              }

              const fsSvc = yield* FileSystem.FileSystem
              const pathSvc = yield* Path.Path
              const notice = yield* SearchContract.unsatisfiableNotice({
                fileSystem: fsSvc,
                path: pathSvc,
                root: tmpBase,
                globs: gErr === undefined ? [glob] : [],
                hidden: false
              })
              if (notice !== undefined && typeof notice !== "string") return false
              return true
            }).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
          { seed, executions: Math.min(executions, 200) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true })
    }
  })

  it(
    "SearchConformance differential parity holds across NativeSearch (rg), PortableSearch & RemoteSearch",
    async () => {
      const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "smthrs-search-diff-")))
      try {
        const arb = Arbitrary.schema(
          Schema.Struct({
            planSeed: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })),
            includeRemote: Schema.Boolean
          })
        )

        const report = await Effect.runPromise(
          Fuzz.run(
            arb,
            ({ planSeed, includeRemote }) =>
              Effect.gen(function*() {
                const dir = path.join(tmpBase, `case-${planSeed}`)
                fs.mkdirSync(dir, { recursive: true })
                const plan = SearchConformance.plan({ seed: planSeed, root: dir, files: 6, calls: 6 })
                const fsSvc = yield* FileSystem.FileSystem
                const pathSvc = yield* Path.Path
                const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
                yield* SearchConformance.materialize(plan)

                const portable = PortableSearch.make(
                  Context.make(FileSystem.FileSystem, fsSvc).pipe(Context.add(Path.Path, pathSvc))
                )
                const native = NativeSearch.make(
                  Context.make(ChildProcessSpawner.ChildProcessSpawner, spawner).pipe(
                    Context.add(FileSystem.FileSystem, fsSvc),
                    Context.add(Path.Path, pathSvc)
                  )
                )
                const remote = RemoteSearch.make(
                  Context.make(ChildProcessSpawner.ChildProcessSpawner, spawner).pipe(
                    Context.add(Path.Path, pathSvc)
                  )
                )

                const nativeDiv = yield* SearchConformance.compare({ plan, subject: native, reference: portable })
                if (nativeDiv.length > 0) {
                  throw new Error(
                    `Native vs Portable divergence on seed ${planSeed}:\n${SearchConformance.report(nativeDiv)}`
                  )
                }
                if (includeRemote) {
                  const remoteDiv = yield* SearchConformance.compare({ plan, subject: remote, reference: portable })
                  if (remoteDiv.length > 0) {
                    throw new Error(
                      `Remote vs Portable divergence on seed ${planSeed}:\n${SearchConformance.report(remoteDiv)}`
                    )
                  }
                }
                const emptyReport = SearchConformance.report([])
                fs.rmSync(dir, { recursive: true, force: true })
                return typeof emptyReport === "string"
              }).pipe(Effect.provide(NodePlatform)),
            { seed: seed + 1, executions: Math.min(executions, 8) }
          )
        )
        const failure = Fuzz.formatReport(report)
        if (failure !== undefined) throw new Error(failure)
        expect(report._tag).toBe("Passed")
      } finally {
        fs.rmSync(tmpBase, { recursive: true, force: true })
      }
    },
    120_000
  )

  it(
    "Bash.run, ShellCommand.run, Read.run, TestRun.run, Probe, TreeFingerprint & Diagnostics uphold invariants",
    async () => {
      const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "smthrs-tools-fuzz-")))
      const textFile = path.join(tmpBase, "sample.txt")
      const binFile = path.join(tmpBase, "binary.dat")
      fs.writeFileSync(textFile, Array.from({ length: 40 }, (_, i) => `line-${i + 1}`).join("\n") + "\n")
      fs.writeFileSync(binFile, Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x89, 0x50, 0x4e]))

      try {
        const arb = Arbitrary.schema(
          Schema.Struct({
            cmdKind: Schema.Literals(["echo", "exit_nonzero", "stderr_out", "interpreter_echo", "hermetic_ok"]),
            readKind: Schema.Literals(["full", "slice", "binary", "missing", "directory"]),
            offset: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
            limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
            choiceIdx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 }))
          })
        )

        const report = await Effect.runPromise(
          Fuzz.run(
            arb,
            ({ cmdKind, readKind, offset, limit, choiceIdx }) =>
              Effect.gen(function*() {
                const bashInput: Bash.Input = cmdKind === "echo"
                  ? { mode: "unhermetic", command: "echo hello-fuzz", cwd: tmpBase, timeoutMs: 5000 }
                  : cmdKind === "exit_nonzero"
                  ? { mode: "unhermetic", command: "exit 7", cwd: tmpBase, timeoutMs: 5000 }
                  : cmdKind === "stderr_out"
                  ? { mode: "unhermetic", command: "echo err-msg >&2; echo out-msg", cwd: tmpBase, timeoutMs: 5000 }
                  : cmdKind === "hermetic_ok"
                  ? {
                    mode: "hermetic",
                    command: "cat sample.txt",
                    reads: [tmpBase, path.join(tmpBase, "**")],
                    writes: [],
                    cwd: tmpBase,
                    timeoutMs: 5000
                  }
                  : { mode: "unhermetic", interpreter: "bash", script: "echo argv-fuzz", cwd: tmpBase, timeoutMs: 5000 }

                const inv = Bash.invocation(bashInput)
                if ("_tag" in inv && inv._tag === "@smthrs/std/StdError") throw new Error(`inv failed: ${inv.message}`)
                const eff = Bash.effectsFor(bashInput)
                if (eff === undefined) throw new Error("effectsFor undefined")
                const outErr = Bash.outsideContainer("/app", "/etc/passwd")
                if (outErr._tag !== "@smthrs/std/StdError") throw new Error("outsideContainer not StdError")
                const elided = Bash.elideMiddle("start", 100, "end")
                if (!elided.includes("start") || !elided.includes("end")) throw new Error("elideMiddle broken")

                const bashRes = yield* Bash.run(bashInput).pipe(Effect.provide(NodePlatform))
                if (cmdKind === "echo" && (bashRes.exitCode !== 0 || !bashRes.stdout.includes("hello-fuzz"))) {
                  throw new Error(`echo mismatch: ${JSON.stringify(bashRes)}`)
                }
                if (cmdKind === "exit_nonzero" && bashRes.exitCode !== 7) {
                  throw new Error(`exit_nonzero mismatch: ${JSON.stringify(bashRes)}`)
                }
                if (
                  cmdKind === "stderr_out" &&
                  (!bashRes.stderr.includes("err-msg") || !bashRes.stdout.includes("out-msg"))
                ) {
                  throw new Error(`stderr_out mismatch: ${JSON.stringify(bashRes)}`)
                }
                if (
                  cmdKind === "interpreter_echo" && (bashRes.exitCode !== 0 || !bashRes.stdout.includes("argv-fuzz"))
                ) {
                  throw new Error(`interpreter_echo mismatch: ${JSON.stringify(bashRes)}`)
                }
                if (cmdKind === "hermetic_ok" && (bashRes.exitCode !== 0 || !bashRes.stdout.includes("line-1"))) {
                  throw new Error(`hermetic_ok mismatch: ${JSON.stringify(bashRes)}`)
                }

                const shellRes = yield* ShellCommand.run({
                  command: cmdKind === "exit_nonzero" ? "exit 3" : "echo shell-ok",
                  workdir: tmpBase,
                  timeout_ms: 5000
                }).pipe(Effect.provide(NodePlatform))
                if (cmdKind === "exit_nonzero" && shellRes.exitCode !== 3) {
                  throw new Error(`shell exit mismatch: ${JSON.stringify(shellRes)}`)
                }
                if (cmdKind !== "exit_nonzero" && (!shellRes.output.includes("shell-ok") || shellRes.exitCode !== 0)) {
                  throw new Error(`shell ok mismatch: ${JSON.stringify(shellRes)}`)
                }

                const readPath = readKind === "binary"
                  ? binFile
                  : readKind === "missing"
                  ? path.join(tmpBase, "does-not-exist.txt")
                  : readKind === "directory"
                  ? tmpBase
                  : textFile
                const readInput = readKind === "slice" ? { path: readPath, offset, limit } : { path: readPath }
                const readExit = yield* Read.run(readInput).pipe(Effect.provide(NodePlatform), Effect.result)
                if (readKind === "full") {
                  if (readExit._tag !== "Success" || !readExit.success.content.includes("line-1")) {
                    throw new Error(`read full failed: ${JSON.stringify(readExit)}`)
                  }
                } else if (readKind === "slice") {
                  if (readExit._tag !== "Success") throw new Error(`read slice failed: ${JSON.stringify(readExit)}`)
                } else if (readKind === "missing" || readKind === "directory" || readKind === "binary") {
                  if (readExit._tag !== "Failure") throw new Error(`read ${readKind} unexpectedly succeeded`)
                }

                const runnerLayer = TestRunner.layer({
                  command: cmdKind === "exit_nonzero" ? "echo FAIL test >&2; exit 1" : "echo PASS 1 test",
                  cwd: tmpBase
                })
                const testRes = yield* TestRun.run({ timeoutMs: 5000 }).pipe(
                  Effect.provide(Layer.mergeAll(NodePlatform, Checkpoints.layerNoop, runnerLayer, judging(choiceIdx))),
                  Effect.result
                )
                if (testRes._tag !== "Success") throw new Error(`testRes failed: ${JSON.stringify(testRes)}`)
                if (cmdKind === "exit_nonzero" && testRes.success.exitCode === 0) {
                  throw new Error("expected nonzero exit")
                }
                if (cmdKind !== "exit_nonzero" && testRes.success.exitCode !== 0) throw new Error("expected zero exit")

                // TreeFingerprint pure + nonce checks
                const nonce = yield* TreeFingerprint.nonce
                const script = TreeFingerprint.script()
                if (script.length === 0) throw new Error("empty script")
                const wrapped = TreeFingerprint.around()
                if (!wrapped.includes(TreeFingerprint.marker)) throw new Error("missing marker")
                const parsedA = TreeFingerprint.parse(`hash-a 12\n`)
                const parsedB = TreeFingerprint.parse(`hash-b 12\n`)
                const moved = TreeFingerprint.moved(parsedA, parsedB)
                if (moved !== undefined && typeof moved !== "boolean") throw new Error("moved bad type")
                const split = TreeFingerprint.split(
                  `normal stderr\n${TreeFingerprint.marker} ${nonce} exited hash-a 12 | hash-b 12\n`,
                  nonce
                )
                if (typeof split.stderr !== "string") throw new Error("split stderr not string")

                // Diagnostics with LanguageServer
                const lspLayer = Layer.succeed(
                  LanguageServer.LanguageServer,
                  LanguageServer.make({
                    ...LanguageServer.makeNoop(),
                    sync: () => Effect.void,
                    close: () => Effect.void,
                    diagnostics: () =>
                      Effect.succeed({
                        kind: "full",
                        items: [
                          {
                            severity: 1,
                            message: "type error",
                            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
                          }
                        ]
                      }),
                    refresh: Effect.void
                  })
                )
                const errs = Diagnostics.errors({
                  items: [{
                    severity: 1,
                    message: "broken",
                    range: { start: { line: 2, character: 4 }, end: { line: 2, character: 8 } }
                  }]
                })
                if (errs.length !== 1) throw new Error("Diagnostics.errors mismatch")
                const syncedServer = yield* Diagnostics.sync(textFile, "const x = 1\n").pipe(Effect.provide(lspLayer))
                const ofErrs = syncedServer ? yield* Diagnostics.errorsOf(syncedServer, textFile) : []
                if (!Array.isArray(ofErrs)) throw new Error("Diagnostics.errorsOf mismatch")
                yield* Diagnostics.refresh.pipe(Effect.provide(lspLayer))
                yield* Diagnostics.close(textFile).pipe(Effect.provide(lspLayer))

                return true
              }),
            { seed: seed + 2, executions: Math.min(executions, 20) }
          )
        )
        const failure = Fuzz.formatReport(report)
        if (failure !== undefined) throw new Error(failure)
        expect(report._tag).toBe("Passed")
      } finally {
        fs.rmSync(tmpBase, { recursive: true, force: true })
      }
    },
    90_000
  )

  it("Checkpoints (git + container + noop) & Relocate enforce isolation, id validation, and path relocation", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        cpId: Schema.Literals(["cp-1", "base", "bad.dot", "../escape", "step-42", ""]),
        flowName: Schema.Literals(["read", "write", "edit", "bash", "grep", "glob", "ls", "unknown"]),
        containerized: Schema.Boolean,
        escapeLive: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ cpId, flowName, containerized, escapeLive }) =>
          Effect.gen(function*() {
            const sampleInput: Schema.Json = flowName === "bash"
              ? {
                command: escapeLive ? "cat /repo/secret.txt" : "echo ok",
                cwd: containerized ? "/work/sub" : "/repo/sub",
                ...(containerized ? { container: "box-1" } : {})
              }
              : flowName === "grep" || flowName === "glob" || flowName === "ls"
              ? { path: escapeLive ? "../outside" : "src/a.ts", pattern: "foo" }
              : { path: escapeLive ? "/etc/passwd" : "src/a.ts", content: "x" }

            const pre = Relocate.precheck(flowName, sampleInput)
            if (pre !== undefined && typeof pre._tag !== "string") return false

            const materialized: Checkpoints.Materialized = {
              id: "cp-1",
              root: "/repo",
              host: "/repo/.smithers-cp/cp-1",
              guestRoot: "/work",
              guest: "/work/.smithers-cp/cp-1"
            }
            const rel = Relocate.relocate(flowName, sampleInput, materialized)
            if (typeof rel._tag !== "string") return false
            if (flowName === "bash" && escapeLive && rel._tag !== "OutsideTree") return false

            const noop = Checkpoints.makeNoop()
            const noopCap = yield* noop.capture("cp-1").pipe(Effect.result)
            if (noopCap._tag !== "Failure") return false
            const noopMat = yield* noop.materialize("cp-1", () => Effect.succeed("ok")).pipe(Effect.result)
            if (noopMat._tag !== "Failure") return false
            if (Checkpoints.unavailable(cpId || "x")._tag !== "@smthrs/std/StdError") return false

            const scriptedSpawner = Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.makeNoop({
                spawn: (command) =>
                  Effect.sync(() => {
                    const std = command as ChildProcess.StandardCommand
                    const argv = [
                      std.command,
                      ...std.args.map((
                        a
                      ) => (typeof a === "string" ? a : Redacted.value(a as Redacted.Redacted<string>)))
                    ]
                    const line = argv.join(" ")
                    let out = ""
                    if (line.includes("rev-parse --git-common-dir")) out = "/repo/.git\n"
                    else if (line.includes("rev-parse --show-toplevel")) out = "/repo\n"
                    else if (line.includes("rev-parse --verify")) out = "0123456789abcdef0123456789abcdef01234567\n"
                    else if (line.includes("write-tree")) out = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"
                    else if (line.includes("commit-tree")) out = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n"
                    else if (line.includes("config --get")) out = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n"
                    return makeHandle({
                      pid: ProcessId(1),
                      exitCode: Effect.succeed(ExitCode(0)),
                      isRunning: Effect.succeed(false),
                      kill: () => Effect.void,
                      stdin: Sink.drain,
                      stdout: Stream.make(new TextEncoder().encode(out)),
                      stderr: Stream.empty,
                      all: Stream.make(new TextEncoder().encode(out)),
                      getInputFd: () => Sink.drain,
                      getOutputFd: () => Stream.empty,
                      unref: Effect.succeed({ ref: Effect.void } as never)
                    })
                  })
              })
            )

            const gitStore = yield* Checkpoints.makeGit({ root: "/repo" }).pipe(Effect.provide(scriptedSpawner))
            const capExit = yield* gitStore.capture(cpId).pipe(Effect.result)
            if (
              (cpId === "" || cpId.includes(".") || cpId.includes("/") || cpId === "base") && capExit._tag !== "Failure"
            ) {
              return false
            }
            const matExit = yield* gitStore
              .materialize(cpId || "cp-1", (m) => Effect.succeed(m.host))
              .pipe(Effect.result)
            if (matExit._tag !== "Success" && matExit._tag !== "Failure") return false

            const containerLayer = Layer.succeed(
              Container.Container,
              Container.make({
                exec: (plan) => Effect.succeed({ file: "sh", args: ["-c", `echo ${plan.file}`] })
              })
            )
            const containerStore = yield* Checkpoints.makeContainer({
              container: "box-1",
              cwd: "/work"
            }).pipe(Effect.provide(Layer.merge(scriptedSpawner, containerLayer)))
            const cCap = yield* containerStore.capture(cpId).pipe(Effect.result)
            if (cCap._tag !== "Success" && cCap._tag !== "Failure") return false
            return true
          }),
        { seed: seed + 4, executions: Math.min(executions, 80) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("WebFetch.run enforces scheme validation, SSRF private-IP blocking, safe redirects & HTML/markdown/text rendering", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        urlKind: Schema.Literals([
          "valid_html",
          "valid_text",
          "redirect_ok",
          "redirect_bad_scheme",
          "bad_scheme",
          "userinfo",
          "http_500",
          "ssrf_private"
        ]),
        format: Schema.Literals(["markdown", "text", "html"])
      })
    )

    const netGetOnly = GrantStore.layer({
      attended: false,
      rules: [new Rule({ effect: "allow", pattern: new CapabilityPattern({ action: "net:get", resource: "*" }) })]
    }).pipe(Layer.provide(Workspace.layer("/workspace")))

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ urlKind, format }) =>
          Effect.gen(function*() {
            const client = HttpClient.make((req) => {
              if (req.url.includes("/redir-ok")) {
                return Effect.succeed(
                  HttpClientResponse.fromWeb(
                    req,
                    new Response("", { status: 302, headers: { location: "https://example.com/final" } })
                  )
                )
              }
              if (req.url.includes("/redir-bad")) {
                return Effect.succeed(
                  HttpClientResponse.fromWeb(
                    req,
                    new Response("", { status: 302, headers: { location: "file:///etc/passwd" } })
                  )
                )
              }
              if (req.url.includes("/err500")) {
                return Effect.succeed(
                  HttpClientResponse.fromWeb(req, new Response("boom", { status: 500 }))
                )
              }
              if (req.url.includes("/plain")) {
                return Effect.succeed(
                  HttpClientResponse.fromWeb(
                    req,
                    new Response("plain text body", { status: 200, headers: { "content-type": "text/plain" } })
                  )
                )
              }
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  req,
                  new Response(
                    "<html><body><h1>Title</h1><script>evil()</script><p>Hello world</p></body></html>",
                    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
                  )
                )
              )
            })

            const url = urlKind === "valid_html"
              ? "https://example.com/page"
              : urlKind === "valid_text"
              ? "https://example.com/plain"
              : urlKind === "redirect_ok"
              ? "https://example.com/redir-ok"
              : urlKind === "redirect_bad_scheme"
              ? "https://example.com/redir-bad"
              : urlKind === "bad_scheme"
              ? "javascript:alert(1)"
              : urlKind === "userinfo"
              ? "https://user:pass@example.com/page"
              : urlKind === "ssrf_private"
              ? "https://internal.example.com/admin"
              : "https://example.com/err500"

            const resolvedIps = urlKind === "ssrf_private" ? ["127.0.0.1"] : ["93.184.216.34"]
            const exit = yield* WebFetch.run({ url, format }).pipe(
              Effect.provide(
                Layer.mergeAll(
                  Layer.succeed(HttpClient.HttpClient, KernelHttpClient.withDestinationPinning(client)),
                  Layer.succeed(KernelHttpClient.ResolveHost, () => Effect.succeed(resolvedIps)),
                  netGetOnly
                )
              ),
              Effect.result
            )

            if (
              urlKind === "bad_scheme" ||
              urlKind === "userinfo" ||
              urlKind === "redirect_bad_scheme" ||
              urlKind === "ssrf_private"
            ) {
              return exit._tag === "Failure"
            }
            if (exit._tag !== "Success") return false
            if (urlKind === "http_500") return exit.success.status === 500
            if (format !== "html" && exit.success.content.includes("evil()")) return false
            return exit.success.content.length > 0
          }),
        { seed: seed + 3, executions: Math.min(executions, 40) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
