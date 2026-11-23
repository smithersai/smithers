import * as NodePath from "@effect/platform-node/NodePath"
import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import { Fuzz, FuzzSimulation } from "@smthrs/fuzz"
import * as HostJj from "@smthrs/jj"
import * as JournalModule from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import {
  Arbitrary,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem as EffectFileSystem,
  Layer,
  Logger,
  Option,
  Path as EffectPath,
  PlatformError,
  Redacted,
  Result,
  Schema,
  Scope,
  Sink,
  Stream
} from "effect"
import * as ByteSize from "effect/ByteSize"
import { Base64 } from "effect/encoding"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpBody from "effect/http/HttpBody"
import * as EffectHttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as ChildProcess from "effect/process/ChildProcess"
import {
  ChildProcessSpawner as HostChildProcessSpawner,
  ExitCode,
  make as makeSpawner,
  makeHandle,
  ProcessId
} from "effect/process/ChildProcessSpawner"
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import * as CapabilitySet from "../src/CapabilitySet.ts"
import * as ChildProcessEnvironment from "../src/ChildProcessEnvironment.ts"
import * as ChildProcessSpawner from "../src/ChildProcessSpawner.ts"
import * as CommandLine from "../src/CommandLine.ts"
import * as ContainedSpawner from "../src/ContainedSpawner.ts"
import * as FileSystem from "../src/FileSystem.ts"
import * as GrantEvent from "../src/GrantEvent.ts"
import * as GrantStore from "../src/GrantStore.ts"
import * as HostServices from "../src/HostServices.ts"
import * as HttpClient from "../src/HttpClient.ts"
import { restrictsContent } from "../src/internal/restrictsContent.ts"
import * as Jj from "../src/Jj.ts"
import * as JournalGrantStore from "../src/JournalGrantStore.ts"
import * as KernelPath from "../src/Path.ts"
import * as ProcessConfinement from "../src/ProcessConfinement.ts"
import * as ProcessLedger from "../src/ProcessLedger.ts"
import * as Rooted from "../src/Rooted.ts"
import * as BatchContract from "../src/test/FileSystemBatchContract.ts"
import * as TestGrantStore from "../src/test/TestGrantStore.ts"
import * as Unreachable from "../src/Unreachable.ts"
import * as Workspace from "../src/Workspace.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "150"))
const pureExecutions = Math.max(20, Math.min(baseExecutions, 200))
const ioExecutions = Math.max(16, Math.min(Math.ceil(baseExecutions / 3), 55))
const simExecutions = Math.max(12, Math.min(Math.ceil(baseExecutions / 5), 35))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

const silentLogger = Logger.layer([])

const runFuzz = async <A, E>(
  arb: Parameters<typeof Fuzz.run<A, E>>[0],
  predicate: (value: A) => Effect.Effect<boolean, E, never>,
  options: { readonly seed: number; readonly executions: number; readonly execution?: Fuzz.Execution }
) => {
  const report = await Effect.runPromise(
    Fuzz.run(
      arb,
      (value) => predicate(value).pipe(Effect.provide(silentLogger)),
      options
    )
  )
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const makeFakeHandle = (pid = 100, overrides: Partial<Parameters<typeof makeHandle>[0]> = {}) =>
  makeHandle({
    pid: ProcessId(pid),
    exitCode: Effect.succeed(ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
    ...overrides
  })

describe("@smthrs/kernel security & command-line fuzz invariants", () => {
  it("ChildProcessEnvironment NEVER inherits credential-like ambient vars even if listed in names, returns null-proto, and respects undefined deletions", async () => {
    const secretPrefix = Schema.Literals(["OPENAI", "ANTHROPIC", "GITHUB", "AWS", "STRIPE", "CLOUDFLARE", "SMITHERS"])
    const secretSuffix = Schema.Literals(["_API_KEY", "_TOKEN", "_SECRET", "_PASSWORD", "_CREDENTIAL", "_PRIVATE_KEY"])
    const safeName = Schema.Literals(["PATH", "HOME", "USER", "LANG", "TERM", "TMPDIR", "SHELL"])
    const arb = Arbitrary.schema(
      Schema.Struct({
        secretPrefix,
        secretSuffix,
        secretVal: Schema.String.pipe(Schema.check(Schema.isMinLength(4), Schema.isMaxLength(32))),
        safeName,
        safeVal: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(32))),
        dropSafe: Schema.Boolean,
        extraName: Schema.Literals(["CUSTOM_VAR", "FOO_BAR"]),
        extraVal: Schema.String.pipe(Schema.check(Schema.isMaxLength(24)))
      })
    )
    await runFuzz(
      arb,
      ({ secretPrefix, secretSuffix, secretVal, safeName, safeVal, dropSafe, extraName, extraVal }) =>
        Effect.sync(() => {
          const secretKey = `${secretPrefix}${secretSuffix}`
          const ambient: Record<string, string> = {
            [secretKey]: secretVal,
            [safeName]: safeVal,
            UNLISTED_AMBIENT: "must-not-leak"
          }
          const declared: Record<string, string | undefined> = {
            [extraName]: extraVal,
            ...(dropSafe ? { [safeName]: undefined } : {})
          }
          const env = ChildProcessEnvironment.make(ambient, declared, [
            ...ChildProcessEnvironment.inheritedNames,
            secretKey
          ])
          if (Object.getPrototypeOf(env) !== null) return false
          if (secretKey in env) return false
          if ("UNLISTED_AMBIENT" in env) return false
          if (dropSafe && safeName in env) return false
          if (!dropSafe && env[safeName] !== safeVal) return false
          if (env[extraName] !== extraVal) return false
          return true
        }),
      { seed, executions: pureExecutions }
    )
  })

  it("CommandLine.quote handles arbitrary strings safely without throwing and preserves non-empty tokens", async () => {
    const arb = Arbitrary.schema(Schema.String.pipe(Schema.check(Schema.isMaxLength(128))))
    await runFuzz(
      arb,
      (token) =>
        Effect.sync(() => {
          const q = CommandLine.quote(token)
          if (typeof q !== "string" || q.length === 0) return false
          if (token === "" && q !== "''") return false
          return true
        }),
      { seed: seed + 1, executions: pureExecutions }
    )
  })

  it("CommandLine render, renderForExecution, resource, executable, stages, cwd, and env preserve security invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        cmd: Schema.Literals([
          "git",
          "curl",
          "FOO=bar 'my tool' --flag",
          "A=\"x y\" B=1 /usr/local/bin/tool arg",
          "$DYNAMIC_BIN --x",
          "echo hi 2>&1 >/dev/null",
          "echo hi; rm -rf /",
          "   ",
          "\"quoted tool\" arg"
        ]),
        arg: Schema.String.pipe(Schema.check(Schema.isMaxLength(32))),
        secret: Schema.String.pipe(Schema.check(Schema.isMinLength(5), Schema.isMaxLength(20))),
        useRedacted: Schema.Boolean,
        shellMode: Schema.Literals(["none", "false", "true", "custom"]),
        piped: Schema.Boolean,
        hasCwd: Schema.Boolean,
        cwdInside: Schema.Boolean,
        hasResolvedCwd: Schema.Boolean,
        envOverride: Schema.Literals(["none", "sameBootstrap", "diffBootstrap", "custom", "undef"]),
        keyMode: Schema.Literals(["none", "short", "long"])
      })
    )
    await runFuzz(
      arb,
      ({
        cmd,
        arg,
        secret,
        useRedacted,
        shellMode,
        piped,
        hasCwd,
        cwdInside,
        hasResolvedCwd,
        envOverride,
        keyMode
      }) =>
        Effect.sync(() => {
          const shell = shellMode === "none"
            ? undefined
            : shellMode === "false"
            ? false
            : shellMode === "true"
            ? true
            : "/bin/zsh"
          const ambient: Record<string, string> = { PATH: "/usr/bin", HOME: "/home/u" }
          const env: Record<string, string | undefined> | undefined = envOverride === "none"
            ? undefined
            : envOverride === "sameBootstrap"
            ? { PATH: "/usr/bin" }
            : envOverride === "diffBootstrap"
            ? { PATH: "/evil/bin" }
            : envOverride === "custom"
            ? { CUSTOM_SECRET: secret, PATH: "/usr/bin" }
            : { CUSTOM_SECRET: undefined }
          const cwd = hasCwd ? (cwdInside ? "/workspace/sub" : "/outside/dir") : undefined
          const args = useRedacted ? [arg, Redacted.make(secret)] : [arg]
          const stage1 = ChildProcess.make(cmd, args, {
            ...(shell === undefined ? {} : { shell }),
            ...(env === undefined ? {} : { env }),
            ...(cwd === undefined ? {} : { cwd })
          })
          const stage2 = ChildProcess.make("wc", ["-l"], { cwd: "/workspace/right" })
          const command: ChildProcess.Command = piped ? ChildProcess.pipeTo(stage1, stage2) : stage1

          const rendered = CommandLine.render(command)
          const forExec = CommandLine.renderForExecution(command)
          if (useRedacted && !rendered.includes("<redacted>")) return false
          const escapedSecret = secret.replaceAll("'", "'\\''")
          if (useRedacted && !forExec.includes(secret) && !forExec.includes(escapedSecret)) return false
          if (piped && !rendered.includes(" | ")) return false
          if (shellMode === "custom" && !rendered.startsWith("/bin/zsh -c ")) return false

          const stageList = CommandLine.stages(command)
          if (stageList.length !== (piped ? 2 : 1)) return false
          if (CommandLine.cwd(command) !== cwd) return false
          if (CommandLine.env(command) !== stage1.options.env) return false

          const execName = CommandLine.executable(command)
          if (piped && !execName.endsWith(" | wc")) return false
          if (!piped && (shellMode === "none" || shellMode === "false") && execName !== cmd) return false
          if (!piped && (shellMode === "true" || shellMode === "custom")) {
            if (cmd.startsWith("$") && execName !== "sh") return false
            if (cmd.trim() === "" && execName !== "sh") return false
            if (cmd.startsWith("FOO=bar") && execName !== "my tool") return false
          }

          const redactionKey = keyMode === "none"
            ? undefined
            : keyMode === "short"
            ? new Uint8Array([1, 2, 3, 4])
            : new Uint8Array(80).fill(7)
          const res = CommandLine.resource(stage1, {
            ambient,
            contains: (dir) => dir.startsWith("/workspace"),
            ...(hasResolvedCwd ? { resolvedCwd: cwdInside ? "/workspace/real" : "/outside/real" } : {}),
            ...(redactionKey === undefined ? {} : { redactionKey })
          })
          if (useRedacted && !/<redacted:[0-9a-f]{16}>/.test(res)) return false
          if (envOverride === "custom" && !res.includes("env CUSTOM_SECRET -- ")) return false
          if (envOverride === "custom" && res.includes(secret)) return false
          if (envOverride === "diffBootstrap" && !res.includes("env PATH -- ")) return false
          if (envOverride === "sameBootstrap" && res.includes("env PATH -- ")) return false
          if (hasCwd && !cwdInside && !res.startsWith("cwd ")) return false
          if (hasCwd && cwdInside && res.startsWith("cwd ")) return false
          if (shellMode === "true" && cmd.includes(";") && !res.includes("sh -c ")) return false
          const resDefault = CommandLine.resource(stage1)
          if (typeof resDefault !== "string" || resDefault.length === 0) return false
          return true
        }),
      { seed: seed + 2, executions: pureExecutions }
    )
  })

  it("Unreachable.classifyExit classifies outage signatures and ignores benign errors", async () => {
    const outages = [
      "curl: (6) Could not resolve host: api.example.com",
      "Failed to connect to host port 443",
      "Connection timed out after 5000ms",
      "Operation timed out",
      "Connection reset by peer",
      "Recv failure: Connection reset",
      "Network is unreachable",
      "Temporary failure in name resolution",
      "SSL_ERROR_SYSCALL",
      "fatal: The remote end hung up unexpectedly",
      "getaddrinfo EAI_AGAIN api.test",
      "getaddrinfo ENOTFOUND api.test",
      "HTTP/2 status: 503",
      "HTTP 429 Too Many Requests",
      "HTTP/1.1 error=502"
    ] as const
    const arb = Arbitrary.schema(
      Schema.Struct({
        isOutage: Schema.Boolean,
        idx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: outages.length - 1 }))),
        prefix: Schema.String.pipe(Schema.check(Schema.isMaxLength(20))),
        benign: Schema.Literals(["syntax error", "file not found", "HTTP 404 Not Found", "HTTP 400 Bad Request", "exit 1"])
      })
    )
    await runFuzz(
      arb,
      ({ isOutage, idx, prefix, benign }) =>
        Effect.sync(() => {
          const text = isOutage ? `${prefix} ${outages[idx]!}` : benign
          const classified = Unreachable.classifyExit(text)
          if (isOutage) {
            return classified instanceof Unreachable.Unreachable && classified.message === text
          }
          return classified === undefined
        }),
      { seed: seed + 3, executions: pureExecutions }
    )
  })
})

describe("@smthrs/kernel Path, Workspace, Rooted, TestGrantStore, and BatchContract fuzz invariants", () => {
  it("Rooted.path, Rooted.fileSystem, Rooted.command, Rooted.spawner, Rooted.layer, and KernelPath.layer resolve every relative path against root", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        rootSeg: Schema.Literals(["ws", "proj/a", "dir-1"]),
        rel: Schema.Literals(["a.txt", "sub/b.txt", "./c.txt", "nested/../d.txt"]),
        abs: Schema.Literals(["/abs/file.txt", "/other/dir"]),
        withTempDir: Schema.Boolean,
        withGlobRoot: Schema.Boolean,
        piped: Schema.Boolean,
        contained: Schema.Boolean
      })
    )
    await runFuzz(
      arb,
      ({ rootSeg, rel, abs, withTempDir, withGlobRoot, piped, contained }) =>
        Effect.gen(function*() {
          const root = `/roots/${rootSeg}`
          const observed: Array<string> = []
          const record = (p: string) => {
            observed.push(p)
            return Effect.void
          }
          const baseFs = EffectFileSystem.makeNoop({
            access: (p) => record(p),
            copy: (a, b) => record(`${a}->${b}`),
            copyFile: (a, b) => record(`${a}->${b}`),
            chmod: (p) => record(p),
            chown: (p) => record(p),
            glob: (_pat, opts) => Effect.sync(() => { observed.push(opts?.root ?? ""); return [] }),
            exists: (p) => Effect.sync(() => { observed.push(p); return true }),
            link: (a, b) => record(`${a}->${b}`),
            makeDirectory: (p) => record(p),
            makeTempDirectory: (o) => Effect.sync(() => { observed.push(o?.directory ?? "<sys>"); return "/tmp/d" }),
            makeTempDirectoryScoped: (o) => Effect.sync(() => { observed.push(o?.directory ?? "<sys>"); return "/tmp/d" }),
            makeTempFile: (o) => Effect.sync(() => { observed.push(o?.directory ?? "<sys>"); return "/tmp/f" }),
            makeTempFileScoped: (o) => Effect.sync(() => { observed.push(o?.directory ?? "<sys>"); return "/tmp/f" }),
            open: (p) => Effect.sync(() => { observed.push(p); return {} as EffectFileSystem.File }),
            readDirectory: (p) => Effect.sync(() => { observed.push(p); return [] }),
            readDirectoryEntries: (p) => Effect.sync(() => { observed.push(p); return [] }),
            readFile: (p) => Effect.sync(() => { observed.push(p); return new Uint8Array() }),
            readFileString: (p) => Effect.sync(() => { observed.push(p); return "" }),
            readLink: (p) => Effect.sync(() => { observed.push(p); return "target" }),
            realPath: (p) => Effect.sync(() => { observed.push(p); return p }),
            remove: (p) => record(p),
            rename: (a, b) => record(`${a}->${b}`),
            sink: (p) => { observed.push(p); return Sink.drain },
            stat: (p) => Effect.sync(() => { observed.push(p); return {} as EffectFileSystem.File.Info }),
            lstat: (p) => Effect.sync(() => { observed.push(p); return {} as EffectFileSystem.File.Info }),
            stream: (p) => { observed.push(p); return Stream.empty },
            symlink: (target, linkPath) => record(`sym:${target}->${linkPath}`),
            truncate: (p) => record(p),
            utimes: (p) => record(p),
            watch: (p) => { observed.push(p); return Stream.empty },
            writeFile: (p) => record(p),
            writeFileString: (p) => record(p)
          })
          const spawnedCwds: Array<string | undefined> = []
          const rawSpawner = makeSpawner((cmd) =>
            Effect.sync(() => {
              for (const s of CommandLine.stages(cmd)) spawnedCwds.push(s.options.cwd)
              return makeFakeHandle(42)
            })
          )
          const maybeContained = contained
            ? yield* HostChildProcessSpawner.pipe(
              Effect.provide(ContainedSpawner.layer({}, (c, sp) =>
                Effect.map(sp(c), (handle) => ({ handle, activate: Effect.void, settled: Effect.succeed(true) }))
              )),
              Effect.provideService(HostChildProcessSpawner, rawSpawner),
              Effect.provide(ProcessLedger.layerMemory({ hostId: "r", ownerPid: 1 }))
            )
            : rawSpawner

          const ok = yield* Effect.gen(function*() {
            const p = yield* EffectPath.Path
            const fs = yield* EffectFileSystem.FileSystem
            const sp = yield* HostChildProcessSpawner
            if (ContainedSpawner.isContained(sp) !== contained) return false
            if (p.resolve(rel) !== p.resolve(root, rel)) return false
            if (p.relative(rel, abs) !== p.relative(p.resolve(root, rel), abs)) return false
            const fileUrl = yield* p.toFileUrl(rel)
            if (!fileUrl.href.includes(rootSeg)) return false

            yield* fs.access(rel)
            yield* fs.copy(rel, abs)
            yield* fs.copyFile(rel, "dst.txt")
            yield* fs.chmod(rel, 0o644)
            yield* fs.chown(rel, 1, 1)
            yield* fs.glob("*.ts", withGlobRoot ? { root: "src" } : undefined)
            yield* fs.exists(rel)
            yield* fs.link(rel, "h.txt")
            yield* fs.makeDirectory("newdir")
            yield* fs.makeTempDirectory(withTempDir ? { directory: "tmp" } : undefined)
            yield* fs.makeTempDirectoryScoped(withTempDir ? { directory: "tmp" } : undefined)
            yield* fs.makeTempFile(withTempDir ? { directory: "tmp" } : undefined)
            yield* fs.makeTempFileScoped(withTempDir ? { directory: "tmp" } : undefined)
            yield* fs.open(rel)
            yield* fs.readDirectory(".")
            yield* fs.readDirectoryEntries(".")
            yield* fs.readFile(rel)
            yield* fs.readFileString(rel)
            yield* fs.readLink(rel)
            yield* fs.realPath(rel)
            yield* fs.remove(rel)
            yield* fs.rename(rel, "r.txt")
            const _sink = fs.sink(rel)
            void _sink
            yield* fs.stat(rel)
            yield* fs.lstat(rel)
            yield* Stream.runDrain(fs.stream(rel))
            yield* fs.symlink("../relative-target", rel)
            yield* fs.truncate(rel)
            yield* fs.utimes(rel, 0, 0)
            yield* Stream.runDrain(fs.watch(rel))
            yield* fs.writeFile(rel, new Uint8Array([1]))
            yield* fs.writeFileString(rel, "hi")

            const cmd = piped
              ? ChildProcess.pipeTo(ChildProcess.make("a"), ChildProcess.make("b", [], { cwd: "sub" }))
              : ChildProcess.make("a")
            yield* sp.spawn(cmd)

            if (!observed.some((entry) => entry === `sym:../relative-target->${p.resolve(root, rel)}`)) return false
            if (!spawnedCwds.every((c) => c !== undefined && c.startsWith(root))) return false
            return true
          }).pipe(
            Effect.provide(Rooted.layer(root)),
            Effect.provideService(EffectFileSystem.FileSystem, baseFs),
            Effect.provideService(HostChildProcessSpawner, maybeContained),
            Effect.provide(EffectPath.layer),
            Effect.scoped
          )

          const kpOk = yield* Effect.gen(function*() {
            const p = yield* KernelPath.Path
            return p.resolve(rel).startsWith(root)
          }).pipe(
            Effect.provide(KernelPath.layer),
            Effect.provide(Workspace.layer(root)),
            Effect.provide(EffectPath.layer)
          )
          const noopWs = yield* Workspace.Workspace.pipe(Effect.provide(Workspace.layerNoop))
          return ok && kpOk && noopWs.root === "."
        }),
      { seed: seed + 4, executions: ioExecutions }
    )
  })

  it("TestGrantStore layerAllow, layerDeny, and layerScripted enforce scripted replies and exhaustion", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        replies: Schema.Array(Schema.Literals(["once", "run", "remembered", "deny"])).pipe(
          Schema.check(Schema.isMaxLength(8))
        ),
        reason: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(20)))
      })
    )
    await runFuzz(
      arb,
      ({ replies, reason }) =>
        Effect.gen(function*() {
          const cap = Capability.make("fs:read", "/workspace/a.txt")
          yield* Effect.gen(function*() {
            const store = yield* GrantStore.GrantStore
            yield* store.check(cap)
            yield* store.reply("x", "once")
            yield* store.list
            yield* store.grantEnvelope({ planDigest: "p", patterns: [] })
          }).pipe(Effect.provide(TestGrantStore.layerAllow))

          const denyOk = yield* Effect.gen(function*() {
            const store = yield* GrantStore.GrantStore
            const err = yield* Effect.flip(store.check(cap))
            const rep = yield* Effect.flip(store.reply("x", "once"))
            const pending = yield* store.list
            yield* store.grantEnvelope({ planDigest: "p", patterns: [] })
            return err._tag === "@smthrs/capability/PermissionDenied" &&
              err.reason === reason &&
              rep.code === "request_not_found" &&
              pending.length === 0
          }).pipe(Effect.provide(TestGrantStore.layerDeny(reason)))
          if (!denyOk) return false

          const scriptOk = yield* Effect.gen(function*() {
            const store = yield* GrantStore.GrantStore
            for (const step of replies) {
              const res = yield* Effect.result(store.check(cap))
              if (step === "deny" && Result.isSuccess(res)) return false
              if (step !== "deny" && Result.isFailure(res)) return false
            }
            const exhausted = yield* Effect.flip(store.check(cap))
            const rep = yield* Effect.flip(store.reply("x", "once"))
            const pending = yield* store.list
            yield* store.grantEnvelope({ planDigest: "p", patterns: [] })
            return exhausted._tag === "@smthrs/capability/PermissionDenied" &&
              rep.code === "request_not_found" &&
              pending.length === 0
          }).pipe(Effect.provide(TestGrantStore.layerScripted(replies)))
          return scriptOk
        }),
      { seed: seed + 5, executions: pureExecutions }
    )
  })

  it("FileSystemBatchContract.check validates plain, non-batch atomic, and full batch hosts with and without identifyRoot", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals(["plain", "atomicNoBatch", "batchDefaultId", "batchCustomId"])
      })
    )
    const info = { type: "Directory", dev: 7n, ino: Option.some(9n) } as EffectFileSystem.File.Info
    await runFuzz(
      arb,
      ({ mode }) =>
        Effect.gen(function*() {
          const fs = EffectFileSystem.makeNoop({
            realPath: (p) => Effect.succeed(p),
            stat: () => Effect.succeed(info)
          })
          if (mode === "atomicNoBatch") {
            FileSystem.withAtomicFileSystem(fs, { execute: () => Effect.die("unused") })
          } else if (mode === "batchDefaultId" || mode === "batchCustomId") {
            const batchExec: FileSystem.AtomicFileSystem["execute"] = <R extends FileSystem.AtomicRequest>(request: R) => {
              if (request.operation !== "batch") return Effect.die("unexpected")
              const entries: Array<FileSystem.BatchEntry> = [
                {
                  index: 0,
                  path: "/workspace/source.txt",
                  result: Result.succeed({
                    operation: "digest",
                    digest: createHash("sha256").update("host-contract").digest("hex"),
                    sizeBytes: 13,
                    bytes: new TextEncoder().encode("host-contract")
                  })
                },
                {
                  index: 1,
                  path: "/workspace/source.txt",
                  result: Result.succeed({
                    operation: "stat",
                    info: { ...info, type: "File", size: ByteSize.bytes(13) }
                  })
                },
                {
                  index: 2,
                  path: "/workspace",
                  result: Result.succeed({ operation: "readDirectory", paths: ["source.txt"] })
                },
                {
                  index: 3,
                  path: "/workspace/*.txt",
                  result: Result.succeed({ operation: "glob", paths: ["/workspace/source.txt"] })
                },
                {
                  index: 4,
                  path: "/workspace/absent",
                  result: Result.fail(PlatformError.systemError({ _tag: "NotFound", module: "test", method: "digest" }))
                }
              ]
              entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.index - b.index)
              return Effect.succeed({ rootIdentity: "7:9", entries }) as unknown as Effect.Effect<
                FileSystem.AtomicResult<R>,
                PlatformError.PlatformError
              >
            }
            FileSystem.withAtomicFileSystem(fs, {
              batchLimits: { size: 128, response: 1024 },
              ...(mode === "batchCustomId" ? { identifyRoot: () => Effect.succeed("7:9") } : {}),
              execute: batchExec
            })
          }
          yield* BatchContract.check(fs, "/workspace").pipe(Effect.provide(EffectPath.layer))
          return true
        }),
      { seed: seed + 6, executions: 20 }
    )
  })
})

describe("@smthrs/kernel ProcessConfinement, restrictsContent & pattern validation fuzz invariants", () => {
  it("GrantStore.canonicalEnvelopePatterns and envelopeSignature are order- and duplicate-invariant; isValidGrantPattern & isValidEnvelopePattern enforce boundaries", async () => {
    const actionArb = Schema.Literals(["fs:read", "fs:write", "proc:spawn", "net:get", "net:post", "net:private", "*"])
    const resArb = Schema.Literals([
      "/workspace/a.txt",
      "/workspace/**",
      "/workspace/sub/**",
      "/outside/a.txt",
      "/outside/**",
      "**",
      "*",
      "rm *.tmp",
      "rm ?",
      "/workspace"
    ])
    const arb = Arbitrary.schema(
      Schema.Struct({
        patterns: Schema.Array(Schema.Struct({ action: actionArb, resource: resArb })).pipe(
          Schema.check(Schema.isMinLength(1), Schema.isMaxLength(6))
        ),
        capAction: Schema.Literals(["fs:read", "fs:write", "proc:spawn", "net:get"]),
        capRes: Schema.Literals(["/workspace/a.txt", "/workspace/sub/x.txt", "/outside/a.txt", "rm *.tmp", "/workspace"]),
        scope: Schema.Literals(["run", "remembered"])
      })
    )
    await runFuzz(
      arb,
      ({ patterns, capAction, capRes, scope }) =>
        Effect.sync(() => {
          const pats = patterns.map((p) => new Capability.CapabilityPattern(p))
          const reversed = [...pats].reverse()
          const duplicated = [...pats, ...pats]
          const c1 = GrantStore.canonicalEnvelopePatterns(pats)
          const c2 = GrantStore.canonicalEnvelopePatterns(reversed)
          const c3 = GrantStore.canonicalEnvelopePatterns(duplicated)
          if (c1.length !== c2.length || c1.length !== c3.length) return false
          const s1 = GrantStore.envelopeSignature("plan-1", scope, pats)
          const s2 = GrantStore.envelopeSignature("plan-1", scope, reversed)
          const s3 = GrantStore.envelopeSignature("plan-1", scope, duplicated)
          if (s1 !== s2 || s1 !== s3 || !/^sha256:[0-9a-f]{64}$/.test(s1)) return false

          // Explicitly cover valid non-fs:write grant pattern
          const readCap = Capability.make("fs:read", "/workspace/a.txt")
          const readPat = new Capability.CapabilityPattern({ action: "fs:read", resource: "/workspace/**" })
          if (!GrantStore.isValidGrantPattern(readPat, readCap, Capability.tierOf(readCap, { workspaceRoot: "/workspace" }), "/workspace")) {
            return false
          }

          const cap = Capability.make(capAction, capRes)
          const tier = Capability.tierOf(cap, { workspaceRoot: "/workspace" })
          const wrongTier = tier === "irreversible" ? "compensable" : "irreversible"
          for (const pat of pats) {
            if (GrantStore.isValidGrantPattern(pat, cap, wrongTier, "/workspace")) return false
            if (pat.action.includes("*") && GrantStore.isValidEnvelopePattern(pat, "/workspace")) return false
            if ((pat.resource.includes("*") || pat.resource.includes("?")) && pat.resource === cap.resource) {
              if (GrantStore.isValidGrantPattern(pat, cap, tier, "/workspace")) return false
            }
            if (capAction === "fs:write" && tier === "irreversible" && (pat.resource.includes("*") || pat.resource.includes("?"))) {
              if (GrantStore.isValidGrantPattern(pat, cap, tier, "/workspace")) return false
            }
            if (pat.action === "fs:write" && (pat.resource === "**" || pat.resource === "/outside/**")) {
              if (GrantStore.isValidEnvelopePattern(pat, "/workspace")) return false
            }
          }
          return true
        }),
      { seed: seed + 7, executions: pureExecutions }
    )
  })

  it("ProcessConfinement.profile and restrictsContent are sound across arbitrary policies, ceilings, and budget-exceeding wildcards", async () => {
    const ruleActionSchema = Schema.Literals(["*", "fs:*", "fs:read", "fs:write", "net:*", "net:get", "net:post", "net:private"])
    const ruleSchema = Schema.Struct({
      effect: Schema.Literals(["allow", "deny", "ask"]),
      action: ruleActionSchema,
      resource: Schema.Literals([
        "*",
        "**",
        "/workspace/**",
        "/workspace",
        "/workspace/src/**",
        "/workspace/src",
        "/workspace/src/nested/**",
        "/workspace/secrets/**",
        "/workspace/a*/**",
        "/outside/**",
        "relative/**",
        "/workspace/../workspace/x/**",
        "*a*b*c*d*e*f*g*h*i*j*k*l*m*n*o*p*"
      ])
    })
    const arb = Arbitrary.schema(
      Schema.Struct({
        configured: Schema.Array(ruleSchema).pipe(Schema.check(Schema.isMaxLength(5))),
        remembered: Schema.Array(ruleSchema).pipe(Schema.check(Schema.isMaxLength(3))),
        ceilingKind: Schema.Literals(["unbounded", "workspace", "networkAll", "empty", "star"]),
        trailingSep: Schema.Boolean,
        oversizedDir: Schema.Boolean,
        withRunRuleCeiling: Schema.Boolean
      })
    )
    await runFuzz(
      arb,
      ({ configured, remembered, ceilingKind, trailingSep, oversizedDir, withRunRuleCeiling }) =>
        Effect.gen(function*() {
          const toRule = (r: {
            readonly effect: "allow" | "deny" | "ask"
            readonly action: typeof ruleActionSchema.Type
            readonly resource: string
          }) =>
            new Permission.Rule({
              effect: r.effect,
              pattern: new Capability.CapabilityPattern({ action: r.action, resource: r.resource })
            })
          const cfgRules = configured.map(toRule)
          const remRules = remembered.filter((r) =>
            r.effect !== "allow" || GrantStore.isValidEnvelopePattern(
              new Capability.CapabilityPattern({ action: r.action, resource: r.resource }),
              "/workspace"
            )
          ).map(toRule)
          const store = yield* GrantStore.make({
            attended: false,
            rules: [cfgRules, remRules],
            ...(withRunRuleCeiling
              ? {
                runRules: [
                  {
                    rule: new Permission.Rule({
                      effect: "allow",
                      pattern: new Capability.CapabilityPattern({ action: "fs:read", resource: "/workspace/**" })
                    }),
                    ceiling: [[new Capability.CapabilityPattern({ action: "fs:read", resource: "/workspace/**" })]]
                  }
                ]
              }
              : {})
          })
          const applyCeiling = <A, E, R>(eff: Effect.Effect<A, E, R>) => {
            if (ceilingKind === "unbounded") return eff
            if (ceilingKind === "empty") return eff.pipe(CapabilitySet.attenuate([]))
            if (ceilingKind === "star") {
              return eff.pipe(
                CapabilitySet.attenuate([
                  new Capability.CapabilityPattern({ action: "*", resource: "*" }),
                  new Capability.CapabilityPattern({ action: "net:private", resource: "*" })
                ])
              )
            }
            if (ceilingKind === "workspace") {
              return eff.pipe(
                CapabilitySet.attenuate([
                  new Capability.CapabilityPattern({ action: "fs:read", resource: "/workspace/**" }),
                  new Capability.CapabilityPattern({ action: "fs:write", resource: "/workspace/**" }),
                  new Capability.CapabilityPattern({ action: "fs:write", resource: "/workspace" })
                ])
              )
            }
            return eff.pipe(
              CapabilitySet.attenuate([
                new Capability.CapabilityPattern({ action: "net:get", resource: "**" }),
                new Capability.CapabilityPattern({ action: "net:post", resource: "**" }),
                new Capability.CapabilityPattern({ action: "net:private", resource: "**" })
              ])
            )
          }
          const path = yield* EffectPath.Path
          const prof = yield* applyCeiling(ProcessConfinement.profile(store, "/workspace", path))
          const pol = yield* applyCeiling(store.policy)
          if (oversizedDir) {
            if (!restrictsContent(pol, "fs:read", `/${"x".repeat(Capability.maxResourceLength)}`)) return false
          }
          const dir = trailingSep ? "/workspace/secrets/" : "/workspace/secrets"
          const rcRead = restrictsContent(pol, "fs:read", dir)
          const rcWrite = restrictsContent(pol, "fs:write", dir)
          if (typeof rcRead !== "boolean" || typeof rcWrite !== "boolean") return false

          for (const rel of prof.reads) {
            const sample = rel === "." ? "/workspace/probe.txt" : `/workspace/${rel}/probe.txt`
            const res = yield* Effect.result(applyCeiling(store.check(Capability.make("fs:read", sample))))
            if (Result.isFailure(res)) return false
          }
          for (const rel of prof.writes) {
            const d = rel === "." ? "/workspace" : `/workspace/${rel}`
            const sample = `${d}/probe.txt`
            const r1 = yield* Effect.result(applyCeiling(store.check(Capability.make("fs:write", sample))))
            const r2 = yield* Effect.result(applyCeiling(store.check(Capability.make("fs:write", d))))
            const r3 = yield* Effect.result(applyCeiling(store.check(Capability.make("fs:read", sample))))
            if (Result.isFailure(r1) || Result.isFailure(r2) || Result.isFailure(r3)) return false
          }
          if (prof.network === "open") {
            for (const act of ["net:get", "net:post", "net:private"] as const) {
              const r = yield* Effect.result(applyCeiling(store.check(Capability.make(act, "example.com"))))
              if (Result.isFailure(r)) return false
            }
          }
          const noop = yield* ProcessConfinement.ProcessConfinement.pipe(Effect.provide(ProcessConfinement.layerNoop))
          const cmd = ChildProcess.make("echo")
          if ((yield* noop.confine(cmd, prof)) !== cmd) return false
          return true
        }).pipe(
          Effect.provide(EffectPath.layer),
          Effect.provide(Workspace.layer("/workspace")),
          Effect.scoped
        ),
      { seed: seed + 8, executions: pureExecutions }
    )
  })
})

describe("@smthrs/kernel GrantStore fuzz & simulation invariants", () => {
  it("GrantStore attended & unattended lifecycle, resolutions, patterns, ceilings, envelopes, and store closure", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        attended: Schema.Boolean,
        hasPlanDigest: Schema.Boolean,
        resolution: Schema.Literals(["once", "run", "remembered", "deny", "bogus"]),
        useExplicitPattern: Schema.Boolean,
        explicitWide: Schema.Boolean,
        envelopeScope: Schema.Literals(["run", "remembered", "empty"]),
        seedLegacySig: Schema.Boolean,
        persistFail: Schema.Boolean,
        cancelWaiterDuringPersist: Schema.Boolean,
        hasRunId: Schema.Boolean
      })
    )
    await runFuzz(
      arb,
      ({
        attended,
        hasPlanDigest,
        resolution,
        useExplicitPattern,
        explicitWide,
        envelopeScope,
        seedLegacySig,
        persistFail,
        cancelWaiterDuringPersist,
        hasRunId
      }) =>
        Effect.gen(function*() {
          const cap = Capability.make("fs:write", "/workspace/a.txt")
          const cap2 = Capability.make("fs:write", "/workspace/b.txt")
          const otherCap = Capability.make("net:get", "example.com")
          const narrowPat = new Capability.CapabilityPattern({ action: "fs:write", resource: "/workspace/**" })
          const widePat = new Capability.CapabilityPattern({ action: "fs:write", resource: "**" })
          const readPat = new Capability.CapabilityPattern({ action: "fs:read", resource: "/workspace/**" })
          const legacySig = JSON.stringify({
            planDigest: "plan-1",
            scope: "run",
            patterns: [Capability.format(readPat)]
          })

          const persistStarted = yield* Deferred.make<void>()
          const persistGate = yield* Deferred.make<void>()
          let persistCalls = 0
          let blockPersist = false
          const makeRes = yield* Effect.result(
            GrantStore.make({
              attended,
              ...(hasRunId ? { runId: "run-\uD83D\uDE00" } : {}),
              ...(hasPlanDigest ? { planDigest: "plan-1" } : {}),
              rules: [new Permission.Rule({ effect: "deny", pattern: new Capability.CapabilityPattern({ action: "fs:write", resource: "/workspace/denied.txt" }) })],
              runRules: [
                new Permission.Rule({ effect: "ask", pattern: new Capability.CapabilityPattern({ action: "fs:read", resource: "/workspace/masked.txt" }) }),
                {
                  rule: new Permission.Rule({ effect: "allow", pattern: new Capability.CapabilityPattern({ action: "fs:read", resource: "/workspace/seeded.txt" }) }),
                  ceiling: [[new Capability.CapabilityPattern({ action: "fs:read", resource: "/workspace/seeded.txt" })]]
                },
                new Permission.Rule({ effect: "allow", pattern: new Capability.CapabilityPattern({ action: "fs:read", resource: "/workspace/bare.txt" }) })
              ],
              envelopeSignatures: seedLegacySig ? [legacySig, "{bad-json", `{"planDigest":"p","scope":"run","patterns":["bad"]}`] : [],
              ...(envelopeScope === "empty"
                ? { envelope: { planDigest: "plan-1", patterns: [] } }
                : hasPlanDigest
                ? { envelope: { planDigest: "plan-1", patterns: [readPat], scope: envelopeScope } }
                : {}),
              persist: () =>
                Effect.gen(function*() {
                  persistCalls += 1
                  if (blockPersist) {
                    yield* Deferred.succeed(persistStarted, undefined)
                    yield* Deferred.await(persistGate)
                  }
                  if (persistFail) {
                    return yield* Effect.fail(new Permission.GrantStoreError({ code: "journal_failed", message: "disk full" }))
                  }
                })
            })
          )
          const constructionNeedsPersist = hasPlanDigest && envelopeScope !== "empty" && !(seedLegacySig && envelopeScope === "run")
          if (persistFail && constructionNeedsPersist) {
            return Result.isFailure(makeRes) && makeRes.failure.code === "journal_failed"
          }
          if (Result.isFailure(makeRes)) return false
          const store = makeRes.success

          yield* store.check(Capability.make("fs:read", "/workspace/seeded.txt"))
          yield* store.check(Capability.make("fs:read", "/workspace/bare.txt"))
          const deniedErr = yield* Effect.flip(store.check(Capability.make("fs:write", "/workspace/denied.txt")))
          if (deniedErr._tag !== "@smthrs/capability/PermissionDenied") return false
          const ceilingErr = yield* Effect.flip(
            store.check(Capability.make("fs:read", "/workspace/bare.txt")).pipe(CapabilitySet.attenuate([]))
          )
          if (ceilingErr._tag !== "@smthrs/capability/PermissionDenied") return false

          const pol = yield* store.policy
          if (pol.groups.length !== 4) return false

          if (!attended) {
            const metaObj: Record<string, unknown> = { nested: [1, true, null, "ok-\uD83D\uDE00", { k: 2 }], omitted: undefined }
            Object.defineProperty(metaObj, "hidden", { enumerable: false, value: 99 })
            const reqErr = yield* Effect.flip(store.check(cap, metaObj))
            if (reqErr._tag !== "@smthrs/capability/PermissionRequired") return false
          } else {
            const waiter = yield* store.check(cap, { tag: "fuzz" }).pipe(Effect.forkChild({ startImmediately: true }))
            // Park an uncovered sibling waiter to exercise resolveCovered non-matching branch
            const uncoveredWaiter = yield* store.check(otherCap).pipe(Effect.forkChild({ startImmediately: true }))
            yield* Effect.yieldNow
            const pending = yield* store.list
            if (pending.length !== 2) {
              yield* Fiber.interrupt(waiter)
              yield* Fiber.interrupt(uncoveredWaiter)
              return false
            }
            const reqId = pending.find((p) => p.capability.action === "fs:write")!.requestId
            const notFound = yield* Effect.flip(store.reply("missing-id", "once"))
            if (notFound.code !== "request_not_found") {
              yield* Fiber.interrupt(waiter)
              yield* Fiber.interrupt(uncoveredWaiter)
              return false
            }

            if (cancelWaiterDuringPersist) blockPersist = true
            const supplied = useExplicitPattern ? (explicitWide ? widePat : narrowPat) : undefined
            const replyFiber = yield* store.reply(reqId, resolution as GrantStore.Resolution, supplied).pipe(
              Effect.result,
              Effect.forkChild({ startImmediately: true })
            )
            if (cancelWaiterDuringPersist) {
              yield* Effect.yieldNow
              const started = yield* Deferred.isDone(persistStarted)
              if (started) {
                const raceErr = yield* Effect.flip(store.reply(reqId, "deny"))
                if (raceErr.code !== "request_not_found") {
                  yield* Deferred.succeed(persistGate, undefined)
                  yield* Fiber.interrupt(waiter)
                  yield* Fiber.interrupt(uncoveredWaiter)
                  return false
                }
                yield* Fiber.interrupt(waiter)
                yield* Deferred.succeed(persistGate, undefined)
              } else {
                yield* Deferred.succeed(persistGate, undefined)
              }
            }
            const replyRes = yield* Fiber.join(replyFiber)
            blockPersist = false

            if (resolution === "bogus") {
              if (Result.isSuccess(replyRes) || replyRes.failure.code !== "invalid_resolution") {
                yield* Fiber.interrupt(waiter)
                yield* Fiber.interrupt(uncoveredWaiter)
                return false
              }
              yield* Fiber.interrupt(waiter)
            } else if (resolution === "run" && !hasPlanDigest) {
              if (Result.isSuccess(replyRes) || replyRes.failure.code !== "invalid_resolution") {
                yield* Fiber.interrupt(waiter)
                yield* Fiber.interrupt(uncoveredWaiter)
                return false
              }
              yield* Fiber.interrupt(waiter)
            } else if ((resolution === "run" || resolution === "remembered") && useExplicitPattern && explicitWide) {
              if (Result.isSuccess(replyRes) || replyRes.failure.code !== "invalid_resolution") {
                yield* Fiber.interrupt(waiter)
                yield* Fiber.interrupt(uncoveredWaiter)
                return false
              }
              yield* Fiber.interrupt(waiter)
            } else if (persistFail) {
              if (Result.isSuccess(replyRes) || replyRes.failure.code !== "journal_failed") {
                yield* Fiber.interrupt(waiter)
                yield* Fiber.interrupt(uncoveredWaiter)
                return false
              }
              yield* Fiber.interrupt(waiter)
            } else if (cancelWaiterDuringPersist) {
              if ((resolution === "once" || resolution === "deny") && (Result.isSuccess(replyRes) || replyRes.failure.code !== "request_not_found")) {
                yield* Fiber.interrupt(uncoveredWaiter)
                return false
              }
              if ((resolution === "run" || resolution === "remembered") && Result.isFailure(replyRes)) {
                yield* Fiber.interrupt(uncoveredWaiter)
                return false
              }
            } else {
              if (Result.isFailure(replyRes)) {
                yield* Fiber.interrupt(uncoveredWaiter)
                return false
              }
              const waiterRes = yield* Effect.result(Fiber.join(waiter))
              if (resolution === "deny" && Result.isSuccess(waiterRes)) {
                yield* Fiber.interrupt(uncoveredWaiter)
                return false
              }
              if (resolution !== "deny" && Result.isFailure(waiterRes)) {
                yield* Fiber.interrupt(uncoveredWaiter)
                return false
              }
              if ((resolution === "run" || resolution === "remembered") && useExplicitPattern && !explicitWide) {
                yield* store.check(cap2)
              }
            }
            yield* Fiber.interrupt(uncoveredWaiter)
          }

          yield* store.grantEnvelope({ planDigest: "plan-1", patterns: [] })
          if (hasPlanDigest && !persistFail) {
            const p2 = new Capability.CapabilityPattern({ action: "fs:read", resource: "/workspace/env/**" })
            yield* store.grantEnvelope({ planDigest: "plan-1", patterns: [p2], scope: "run" })
            const beforeDup = persistCalls
            yield* store.grantEnvelope({ planDigest: "plan-1", patterns: [p2], scope: "run" })
            if (persistCalls !== beforeDup) return false
            const mismatch = yield* Effect.flip(store.grantEnvelope({ planDigest: "wrong", patterns: [p2] }))
            if (mismatch.code !== "invalid_resolution") return false
          }

          yield* GrantStore.emptyPolicy
          yield* GrantStore.makeNoop.policy
          yield* GrantStore.makeNoop.check(cap)
          yield* GrantStore.makeNoop.reply("x", "once")
          yield* GrantStore.makeNoop.list
          yield* GrantStore.makeNoop.grantEnvelope({ planDigest: "p", patterns: [] })
          yield* Effect.gen(function*() {
            const lStore = yield* GrantStore.GrantStore
            yield* lStore.list
          }).pipe(Effect.provide(GrantStore.layer({ attended: false })))
          return true
        }).pipe(Effect.provide(Workspace.layer("/workspace")), Effect.scoped),
      { seed: seed + 9, executions: ioExecutions }
    )
  })

  it("GrantStore validates metadata, identity, capacity limits, legacy signatures, wildcard resources, and closed-store races", async () => {
    const badMetaKind = Schema.Literals([
      "nan",
      "inf",
      "loneSurrogateVal",
      "loneSurrogateKey",
      "tooLongStr",
      "deep",
      "cycle",
      "sparseArray",
      "tooManyArrayMembers",
      "getter",
      "nonPlainProto",
      "tooManyMembers",
      "tooManyBytes",
      "symbol",
      "arrayRoot"
    ])
    const badMakeKind = Schema.Literals([
      "emptyRunId",
      "nullPlanDigest",
      "loneSurrogateRunId",
      "badRulesLen",
      "badNestedRulesLen",
      "badRunRulesLen",
      "badCombinedRulesLen",
      "badSignaturesLen",
      "badSignatureItem",
      "oversizedLegacySig",
      "badRememberedEnvelope",
      "badRunRuleEnvelope",
      "badEnvelopeNotArray",
      "badEnvelopeScope",
      "badEnvelopeMissingPlan",
      "badEnvelopeBadPlan",
      "badEnvelopeMismatch",
      "badEnvelopePattern",
      "badEnvelopeTooMany",
      "constructionEnvelopeOverRules",
      "constructionEnvelopeOverSigs"
    ])
    const arb = Arbitrary.schema(
      Schema.Struct({
        badMeta: badMetaKind,
        badMake: badMakeKind,
        capacityCase: Schema.Literals(["none", "replyRunFull", "replyRemFull", "envOverRules", "envOverSigs", "closeWhileWaiter", "closeDuringReplyPersist", "closeDuringEnvPersist"])
      })
    )
    await runFuzz(
      arb,
      ({ badMeta, badMake, capacityCase }) =>
        Effect.gen(function*() {
          const r = new Permission.Rule({ effect: "allow", pattern: new Capability.CapabilityPattern({ action: "fs:read", resource: "/workspace/**" }) })
          const badWriteRule = new Permission.Rule({ effect: "allow", pattern: new Capability.CapabilityPattern({ action: "fs:write", resource: "**" }) })
          const makeOpts: GrantStore.MakeOptions =
            badMake === "emptyRunId" ? { runId: "" }
            : badMake === "nullPlanDigest" ? { planDigest: "bad\0id" }
            : badMake === "loneSurrogateRunId" ? { runId: "a\uD800b" }
            : badMake === "badRulesLen" ? { rules: Array.from({ length: GrantStore.maximumRules + 1 }, () => r) }
            : badMake === "badNestedRulesLen" ? { rules: [Array.from({ length: 600 }, () => r), Array.from({ length: 500 }, () => r)] }
            : badMake === "badRunRulesLen" ? { runRules: Array.from({ length: GrantStore.maximumRules + 1 }, () => r) }
            : badMake === "badCombinedRulesLen" ? { rules: Array.from({ length: 600 }, () => r), runRules: Array.from({ length: 500 }, () => r) }
            : badMake === "badSignaturesLen" ? { envelopeSignatures: Array.from({ length: GrantStore.maximumRules + 1 }, (_, i) => `s${i}`) }
            : badMake === "badSignatureItem" ? { envelopeSignatures: [""] }
            : badMake === "oversizedLegacySig" ? { envelopeSignatures: [`{${"a".repeat(GrantStore.maximumEventBytes + 10)}`] }
            : badMake === "badRememberedEnvelope" ? { rules: [[], [badWriteRule]] }
            : badMake === "badRunRuleEnvelope" ? { runRules: [badWriteRule] }
            : badMake === "badEnvelopeNotArray" ? { planDigest: "p", envelope: { planDigest: "p", patterns: "nope" as unknown as ReadonlyArray<Capability.CapabilityPattern> } }
            : badMake === "badEnvelopeScope" ? { planDigest: "p", envelope: { planDigest: "p", patterns: [r.pattern], scope: "bad" as "run" } }
            : badMake === "badEnvelopeMissingPlan" ? { envelope: { planDigest: "p", patterns: [r.pattern] } }
            : badMake === "badEnvelopeBadPlan" ? { planDigest: "p", envelope: { planDigest: "", patterns: [r.pattern] } }
            : badMake === "badEnvelopeMismatch" ? { planDigest: "p1", envelope: { planDigest: "p2", patterns: [r.pattern] } }
            : badMake === "badEnvelopePattern" ? { planDigest: "p", envelope: { planDigest: "p", patterns: [badWriteRule.pattern] } }
            : badMake === "constructionEnvelopeOverRules" ? { planDigest: "p", rules: Array.from({ length: GrantStore.maximumRules }, () => r), envelope: { planDigest: "p", patterns: [r.pattern] } }
            : badMake === "constructionEnvelopeOverSigs" ? { planDigest: "p", envelopeSignatures: Array.from({ length: GrantStore.maximumRules }, (_, i) => `s-${i}`), envelope: { planDigest: "p", patterns: [r.pattern] } }
            : { planDigest: "p", envelope: { planDigest: "p", patterns: Array.from({ length: GrantStore.maximumEnvelopePatterns + 1 }, () => r.pattern) } }
          const makeErr = yield* Effect.flip(GrantStore.make(makeOpts))
          if (makeErr.code !== "invalid_resolution") return false

          const store = yield* GrantStore.make({ attended: true, planDigest: "p" })
          const buildBadMeta = (): Record<string, unknown> => {
            if (badMeta === "nan") return { a: Number.NaN }
            if (badMeta === "inf") return { a: Number.POSITIVE_INFINITY }
            if (badMeta === "loneSurrogateVal") return { a: "\uDC00" }
            if (badMeta === "loneSurrogateKey") return { ["\uD800"]: "x" }
            if (badMeta === "tooLongStr") return { a: "x".repeat(GrantStore.maximumMetadataBytes + 1) }
            if (badMeta === "deep") {
              let o: Record<string, unknown> = { leaf: 1 }
              for (let i = 0; i < GrantStore.maximumMetadataDepth + 2; i++) o = { n: o }
              return o
            }
            if (badMeta === "cycle") {
              const o: Record<string, unknown> = {}
              o.self = o
              return o
            }
            if (badMeta === "sparseArray") {
              const a: Array<unknown> = []
              a[2] = 1
              return { a }
            }
            if (badMeta === "tooManyArrayMembers") {
              return { a: Array.from({ length: GrantStore.maximumMetadataMembers + 1 }, () => 1) }
            }
            if (badMeta === "getter") {
              const o: Record<string, unknown> = {}
              Object.defineProperty(o, "g", { enumerable: true, get: () => 1 })
              return o
            }
            if (badMeta === "nonPlainProto") return { d: new Date() }
            if (badMeta === "tooManyMembers") {
              const o: Record<string, unknown> = {}
              for (let i = 0; i <= GrantStore.maximumMetadataMembers; i++) o[`k${i}`] = 1
              return o
            }
            if (badMeta === "tooManyBytes") {
              const chunk = "a".repeat(20_000)
              return { a: chunk, b: chunk, c: chunk, d: chunk }
            }
            if (badMeta === "symbol") return { s: Symbol("x") }
            return [] as unknown as Record<string, unknown>
          }
          const metaErr = yield* Effect.flip(store.check(Capability.make("fs:read", "/workspace/a"), buildBadMeta()))
          if (metaErr._tag !== "@smthrs/capability/GrantStoreError" || metaErr.code !== "invalid_resolution") return false

          // Capacity & close-during-persist cases
          if (capacityCase === "replyRunFull" || capacityCase === "replyRemFull" || capacityCase === "envOverRules") {
            const fullStore = yield* GrantStore.make({
              attended: true,
              planDigest: "p",
              rules: Array.from({ length: GrantStore.maximumRules }, () => r)
            })
            if (capacityCase === "envOverRules") {
              const err = yield* Effect.flip(fullStore.grantEnvelope({ planDigest: "p", patterns: [r.pattern] }))
              if (err.code !== "invalid_resolution") return false
            } else {
              const w = yield* fullStore.check(Capability.make("fs:write", "/workspace/a")).pipe(Effect.forkChild({ startImmediately: true }))
              yield* Effect.yieldNow
              const [req] = yield* fullStore.list
              const err = yield* Effect.flip(fullStore.reply(req!.requestId, capacityCase === "replyRunFull" ? "run" : "remembered"))
              yield* Fiber.interrupt(w)
              if (err.code !== "invalid_resolution") return false
            }
          } else if (capacityCase === "envOverSigs") {
            const fullSigStore = yield* GrantStore.make({
              attended: true,
              planDigest: "p",
              envelopeSignatures: Array.from({ length: GrantStore.maximumRules }, (_, i) => `s-${i}`)
            })
            const err = yield* Effect.flip(fullSigStore.grantEnvelope({ planDigest: "p", patterns: [r.pattern] }))
            if (err.code !== "invalid_resolution") return false
          } else if (capacityCase === "closeWhileWaiter") {
            const innerScope = yield* Scope.make()
            const s = yield* GrantStore.make({ attended: true, planDigest: "p" }).pipe(Scope.provide(innerScope))
            const w = yield* s.check(Capability.make("fs:write", "/workspace/x")).pipe(Effect.result, Effect.forkChild({ startImmediately: true }))
            yield* Effect.yieldNow
            yield* Scope.close(innerScope, Exit.void)
            const wr = yield* Fiber.join(w)
            if (Result.isSuccess(wr)) return false
          } else if (capacityCase === "closeDuringReplyPersist" || capacityCase === "closeDuringEnvPersist") {
            const entered = yield* Deferred.make<void>()
            const gate = yield* Deferred.make<void>()
            const innerScope = yield* Scope.make()
            const s = yield* GrantStore.make({
              attended: true,
              planDigest: "p",
              persist: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(gate)))
            }).pipe(Scope.provide(innerScope))
            if (capacityCase === "closeDuringReplyPersist") {
              const w = yield* s.check(Capability.make("fs:write", "/workspace/x")).pipe(Effect.result, Effect.forkChild({ startImmediately: true }))
              yield* Effect.yieldNow
              const [req] = yield* s.list
              const rf = yield* s.reply(req!.requestId, "once").pipe(Effect.result, Effect.forkChild({ startImmediately: true }))
              yield* Deferred.await(entered)
              yield* Scope.close(innerScope, Exit.void)
              yield* Deferred.succeed(gate, undefined)
              const rr = yield* Fiber.join(rf)
              yield* Fiber.join(w)
              if (Result.isSuccess(rr) || rr.failure.code !== "store_closed") return false
            } else {
              const ef = yield* s.grantEnvelope({ planDigest: "p", patterns: [r.pattern] }).pipe(Effect.result, Effect.forkChild({ startImmediately: true }))
              yield* Deferred.await(entered)
              yield* Scope.close(innerScope, Exit.void)
              yield* Deferred.succeed(gate, undefined)
              const er = yield* Fiber.join(ef)
              if (Result.isSuccess(er) || er.failure.code !== "store_closed") return false
            }
          }

          const wcCap = Capability.make("proc:spawn", "rm *.tmp")
          const f = yield* store.check(wcCap).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Effect.yieldNow
          const [req] = yield* store.list
          const wcErr = yield* Effect.flip(store.reply(req!.requestId, "remembered"))
          yield* Fiber.interrupt(f)
          if (wcErr.code !== "invalid_resolution") return false

          const scopedStore = yield* Effect.scoped(GrantStore.make({ attended: true, planDigest: "p" }))
          const e1 = yield* Effect.flip(scopedStore.check(Capability.make("fs:read", "/workspace/a")))
          const e2 = yield* Effect.flip(scopedStore.reply("p-1", "once"))
          const e3 = yield* Effect.flip(scopedStore.grantEnvelope({ planDigest: "p", patterns: [r.pattern] }))
          const e4 = yield* Effect.flip(scopedStore.policy)
          return e1._tag === "@smthrs/capability/GrantStoreError" && e1.code === "store_closed" &&
            e2.code === "store_closed" && e3.code === "store_closed" && e4.code === "store_closed"
        }).pipe(Effect.provide(Workspace.layer("/workspace")), Effect.scoped),
      { seed: seed + 10, executions: 65 }
    )
  })

  it("FuzzSimulation: concurrent GrantStore envelopes (Wait / interrupt retry / timeout) and parked waiters remain consistent", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals(["waitSuccess", "waitFail", "waitInterruptRetry", "persistTimeout"]),
        scope: Schema.Literals(["run", "remembered"])
      })
    )
    await runFuzz(
      arb,
      ({ mode, scope }) =>
        Effect.gen(function*() {
          let calls = 0
          const pat = new Capability.CapabilityPattern({ action: "fs:read", resource: "/workspace/sim/**" })
          const cap = Capability.make("fs:read", "/workspace/sim/a.txt")
          const started = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const store = yield* GrantStore.make({
            attended: true,
            runId: "sim-run",
            planDigest: "sim-plan",
            persist: () =>
              Effect.gen(function*() {
                const n = ++calls
                if (mode === "persistTimeout") {
                  return yield* Effect.sleep("40 seconds")
                }
                if (n === 1) {
                  yield* Deferred.succeed(started, undefined)
                  if (mode === "waitInterruptRetry") {
                    return yield* Effect.never
                  }
                  yield* Deferred.await(release)
                }
                if (mode === "waitFail") {
                  return yield* Effect.fail(new Permission.GrantStoreError({ code: "journal_failed", message: "boom" }))
                }
              })
          })

          if (mode === "persistTimeout") {
            const err = yield* Effect.flip(store.grantEnvelope({ planDigest: "sim-plan", patterns: [pat], scope }))
            return err.code === "journal_failed"
          }

          const waiter = yield* store.check(cap).pipe(Effect.forkChild)
          const f1 = yield* store.grantEnvelope({ planDigest: "sim-plan", patterns: [pat], scope }).pipe(Effect.forkChild)
          yield* Deferred.await(started)
          const f2 = yield* store.grantEnvelope({ planDigest: "sim-plan", patterns: [pat], scope }).pipe(Effect.forkChild)
          yield* Effect.sleep("5 millis")

          if (mode === "waitInterruptRetry") {
            yield* Fiber.interrupt(f1)
            yield* Fiber.join(f2)
            yield* Fiber.join(waiter)
            return calls === 2
          }

          yield* Deferred.succeed(release, undefined)
          const r1 = yield* Effect.result(Fiber.join(f1))
          const r2 = yield* Effect.result(Fiber.join(f2))
          if (mode === "waitFail") {
            yield* Fiber.interrupt(waiter)
            return Result.isFailure(r1) && Result.isFailure(r2) && calls === 1
          }
          yield* Fiber.join(waiter)
          return Result.isSuccess(r1) && Result.isSuccess(r2) && calls === 1
        }).pipe(Effect.provide(Workspace.layer("/workspace")), Effect.scoped),
      { seed: seed + 11, executions: simExecutions, execution: FuzzSimulation.execution() }
    )
  })
})

describe("@smthrs/kernel JournalGrantStore fuzz & simulation invariants", () => {
  it("JournalGrantStore persists and replays grants, ceilings, deduplicated rules, and envelopes faithfully across restarts", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        resolution: Schema.Literals(["once", "run", "remembered", "deny"]),
        envelopeScope: Schema.Literals(["none", "run", "remembered", "default"]),
        reopenSamePlan: Schema.Boolean,
        reopenSameWorkspace: Schema.Boolean,
        concurrentConstruct: Schema.Boolean
      })
    )
    await runFuzz(
      arb,
      ({ resolution, envelopeScope, reopenSamePlan, reopenSameWorkspace, concurrentConstruct }) =>
        Effect.gen(function*() {
          const cap = Capability.make("fs:write", "/workspace/f.txt")
          const otherCap = Capability.make("fs:write", "/workspace/g.txt")
          const pat = new Capability.CapabilityPattern({ action: "fs:write", resource: "/workspace/**" })
          const envPat = new Capability.CapabilityPattern({ action: "fs:read", resource: "/workspace/**" })
          const narrowCeil = new Capability.CapabilityPattern({ action: "fs:write", resource: "/workspace/f.txt" })

          const baseOpts = {
            runId: "r-\uD83D\uDE00",
            policyRunId: "p-1",
            sourceId: "kernel",
            planDigest: "plan-A",
            attended: true,
            ...(envelopeScope === "none"
              ? {}
              : envelopeScope === "default"
              ? { envelope: { patterns: [envPat] } }
              : { envelope: { patterns: [envPat, envPat], scope: envelopeScope } })
          }

          const store = concurrentConstruct && envelopeScope !== "none"
            ? (yield* Effect.all([
              JournalGrantStore.make(baseOpts),
              JournalGrantStore.make(baseOpts)
            ], { concurrency: "unbounded" }))[0]!
            : yield* JournalGrantStore.make(baseOpts)

          const waiter = yield* store.check(cap).pipe(
            CapabilitySet.attenuate([narrowCeil]),
            Effect.forkChild({ startImmediately: true })
          )
          yield* Effect.yieldNow
          const [req] = yield* store.list
          yield* store.reply(req!.requestId, resolution, pat)
          const waitRes = yield* Effect.result(Fiber.join(waiter))
          if (resolution === "deny" && Result.isSuccess(waitRes)) return false
          if (resolution !== "deny" && Result.isFailure(waitRes)) return false

          const reopenEff = Effect.gen(function*() {
            const reopened = yield* GrantStore.GrantStore
            const checkCap = yield* Effect.result(reopened.check(cap))
            const checkOther = yield* Effect.result(reopened.check(otherCap))
            if (resolution === "once" || resolution === "deny") {
              if (Result.isSuccess(checkCap)) return false
            } else if (resolution === "run") {
              if (reopenSamePlan) {
                if (Result.isFailure(checkCap) || Result.isSuccess(checkOther)) return false
              } else {
                if (Result.isSuccess(checkCap)) return false
              }
            } else if (resolution === "remembered") {
              if (reopenSameWorkspace) {
                if (Result.isFailure(checkCap) || Result.isFailure(checkOther)) return false
              } else {
                if (Result.isSuccess(checkCap)) return false
              }
            }
            return true
          }).pipe(
            Effect.provide(
              JournalGrantStore.layer({
                runId: "r-\uD83D\uDE00",
                policyRunId: "p-1",
                sourceId: "kernel",
                planDigest: reopenSamePlan ? "plan-A" : "plan-B",
                attended: false,
                rules: [[new Permission.Rule({ effect: "ask", pattern: envPat })]],
                ...(envelopeScope !== "none" ? { envelope: { patterns: [envPat], scope: envelopeScope === "remembered" ? "remembered" : "run" } } : {})
              })
            ),
            Effect.provide(Workspace.layer(reopenSameWorkspace ? "/workspace" : "/other-ws"))
          )
          const reopenRes = yield* Effect.result(reopenEff)
          if (resolution === "run" && reopenSamePlan && !reopenSameWorkspace) {
            return Result.isFailure(reopenRes) &&
              reopenRes.failure._tag === "@smthrs/capability/GrantStoreError" &&
              reopenRes.failure.code === "invalid_resolution"
          }
          return Result.isSuccess(reopenRes) && reopenRes.success
        }).pipe(
          Effect.provide(TestJournal.layer({ redact: (v) => v })),
          Effect.provide(Workspace.layer("/workspace")),
          Effect.scoped
        ),
      { seed: seed + 12, executions: ioExecutions }
    )
  })

  it("JournalGrantStore rejects invalid IDs, corrupt/mismatched/legacy/unsafe journal entries, capacity overflows, and stalled cursors", async () => {
    const faults = [
      "badRunId",
      "badPolicyRunId",
      "badSourceId",
      "badPlanDigest",
      "sameIds",
      "surrogateId",
      "legacyRunV1",
      "corruptPayload",
      "typeMismatch",
      "unsafeRemembered",
      "unsafeRememberedOtherRoot",
      "unsafeRememberedEnv",
      "runInPolicy",
      "runIdMismatch",
      "unsafeRunGrant",
      "unsafeRunEnv",
      "rememberedInRun",
      "emptyPagePolicy",
      "stalledSeqPolicy",
      "emptyPageRun",
      "stalledSeqRun",
      "journalReadFail",
      "journalWriteFail",
      "otherSourceIgnored",
      "unknownTypeIgnored",
      "duplicateRememberedDedup",
      "overMaxRules",
      "overMaxSigs"
    ] as const
    const arb = Arbitrary.schema(
      Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: faults.length - 1 })))
    )
    const validCap = Capability.make("fs:write", "/workspace/a.txt")
    const validPat = new Capability.CapabilityPattern({ action: "fs:write", resource: "/workspace/**" })
    const unsafePat = new Capability.CapabilityPattern({ action: "fs:write", resource: "**" })
    const encodeEv = (ev: GrantEvent.GrantEvent) => Result.getOrThrow(GrantEvent.encode(ev))

    await runFuzz(
      arb,
      (idx) =>
        Effect.gen(function*() {
          const fault = faults[idx]!
          const baseOpts = {
            runId: "r",
            policyRunId: "p",
            sourceId: "k",
            planDigest: "d",
            attended: false
          }
          if (fault === "badRunId" || fault === "badPolicyRunId" || fault === "badSourceId" || fault === "badPlanDigest" || fault === "sameIds" || fault === "surrogateId") {
            const opts =
              fault === "badRunId" ? { ...baseOpts, runId: "" }
              : fault === "badPolicyRunId" ? { ...baseOpts, policyRunId: "a\0b" }
              : fault === "badSourceId" ? { ...baseOpts, sourceId: "\uDC00" }
              : fault === "badPlanDigest" ? { ...baseOpts, planDigest: "x".repeat(GrantStore.maximumIdentityLength + 1) }
              : fault === "surrogateId" ? { ...baseOpts, runId: "a\uD800b" }
              : { ...baseOpts, policyRunId: "r" }
            const err = yield* Effect.flip(JournalGrantStore.make(opts).pipe(Effect.provide(TestJournal.layer())))
            return err._tag === "@smthrs/capability/GrantStoreError" && err.code === "invalid_resolution"
          }

          if (fault === "journalReadFail") {
            const err = yield* Effect.flip(JournalGrantStore.make(baseOpts).pipe(Effect.provide(JournalModule.layerNoop())))
            return err.code === "journal_failed"
          }

          if (fault === "journalWriteFail") {
            const journal = JournalModule.makeNoop({
              entries: () => Effect.succeed({ entries: [], hasMore: false })
            })
            const err = yield* Effect.flip(
              JournalGrantStore.make({ ...baseOpts, envelope: { patterns: [validPat], scope: "run" } }).pipe(
                Effect.provideService(JournalModule.Journal, journal)
              )
            )
            return err.code === "journal_failed"
          }

          if (fault === "emptyPagePolicy" || fault === "stalledSeqPolicy" || fault === "emptyPageRun" || fault === "stalledSeqRun") {
            const target = fault.endsWith("Policy") ? "p" : "r"
            const mkEntry = (seq: number) =>
              new JournalEvent.Entry({
                runId: target as JournalEvent.RunId,
                seq: seq as JournalEvent.Seq,
                eventId: `e-${seq}`,
                sourceId: "other" as JournalEvent.SourceId,
                sourceSeq: seq as JournalEvent.SourceSeq,
                emittedAtMs: 0,
                eventType: "other",
                payload: {},
                meta: undefined
              })
            const journal = JournalModule.makeNoop({
              entries: (o) => {
                if (o.runId !== target) return Effect.succeed({ entries: [], hasMore: false })
                if (fault.startsWith("emptyPage")) return Effect.succeed({ entries: [], hasMore: true })
                return Effect.succeed({ entries: [mkEntry(0)], hasMore: true })
              }
            })
            const err = yield* Effect.flip(
              JournalGrantStore.make(baseOpts).pipe(Effect.provideService(JournalModule.Journal, journal))
            )
            return err.code === "invalid_resolution"
          }

          if (fault === "overMaxSigs") {
            const sigEntries = Array.from({ length: GrantStore.maximumRules + 1 }, (_, i) =>
              new JournalEvent.Entry({
                runId: "p" as JournalEvent.RunId,
                seq: i as JournalEvent.Seq,
                eventId: `sig-${i}`,
                sourceId: "k" as JournalEvent.SourceId,
                sourceSeq: i as JournalEvent.SourceSeq,
                emittedAtMs: 0,
                eventType: "flows.kernel.grant.envelope.v1",
                payload: encodeEv(
                  new GrantEvent.EnvelopeGrant({
                    eventType: "flows.kernel.grant.envelope.v1",
                    runId: "r",
                    planDigest: `plan-${i}`,
                    patterns: [validPat],
                    scope: "remembered"
                  })
                ),
                meta: undefined
              })
            )
            const journal = JournalModule.makeNoop({
              entries: (o) => {
                if (o.runId !== "p") return Effect.succeed({ entries: [], hasMore: false })
                const start = o.after === undefined ? 0 : (o.after as number) + 1
                const slice = sigEntries.slice(start, start + 256)
                return Effect.succeed({ entries: slice, hasMore: start + slice.length < sigEntries.length })
              }
            })
            const err = yield* Effect.flip(
              JournalGrantStore.make(baseOpts).pipe(Effect.provideService(JournalModule.Journal, journal))
            )
            return err.code === "invalid_resolution"
          }

          return yield* Effect.gen(function*() {
            const j = yield* JournalModule.Journal
            const put = (run: string, eventType: string, payload: unknown, src = "k") =>
              j.emitDurableUnfenced(
                new JournalEvent.Input({
                  runId: run as JournalEvent.RunId,
                  sourceId: src as JournalEvent.SourceId,
                  eventType,
                  payload
                })
              )
            const remEv = (pat: Capability.CapabilityPattern, cap = validCap) =>
              new GrantEvent.RememberedGrant({
                eventType: "flows.kernel.grant.remembered.v1",
                requestId: "q",
                runId: "r",
                planDigest: "d",
                capability: cap,
                pattern: pat,
                scope: "remembered",
                tier: "compensable"
              })
            const runEv = (pat: Capability.CapabilityPattern, rId = "r") =>
              new GrantEvent.RunGrant({
                eventType: "flows.kernel.grant.run.v2",
                requestId: "q",
                runId: rId,
                planDigest: "d",
                capability: validCap,
                pattern: pat,
                ceiling: [],
                scope: "run",
                tier: "compensable"
              })
            const envEv = (scope: "run" | "remembered", pats: ReadonlyArray<Capability.CapabilityPattern>) =>
              new GrantEvent.EnvelopeGrant({
                eventType: "flows.kernel.grant.envelope.v1",
                runId: "r",
                planDigest: "d",
                patterns: pats,
                scope
              })

            if (fault === "duplicateRememberedDedup") {
              yield* put("p", "flows.kernel.grant.remembered.v1", encodeEv(remEv(validPat)))
              yield* put("p", "flows.kernel.grant.remembered.v1", encodeEv(remEv(validPat)))
              const s = yield* JournalGrantStore.make(baseOpts)
              yield* s.check(validCap)
              return true
            }
            if (fault === "overMaxRules") {
              yield* put("p", "flows.kernel.grant.remembered.v1", encodeEv(remEv(validPat)))
              const askRule = new Permission.Rule({ effect: "ask", pattern: validPat })
              const err = yield* Effect.flip(
                JournalGrantStore.make({
                  ...baseOpts,
                  rules: [Array.from({ length: GrantStore.maximumRules }, () => askRule)]
                })
              )
              return err.code === "invalid_resolution"
            }
            if (fault === "otherSourceIgnored") {
              yield* put("r", "flows.kernel.grant.run.v2", encodeEv(runEv(validPat)), "foreign")
              const s = yield* JournalGrantStore.make(baseOpts)
              const e = yield* Effect.flip(s.check(validCap))
              return e._tag === "@smthrs/capability/PermissionRequired"
            }
            if (fault === "unknownTypeIgnored") {
              yield* put("p", "flows.other.v1", { x: 1 })
              const s = yield* JournalGrantStore.make(baseOpts)
              const e = yield* Effect.flip(s.check(validCap))
              return e._tag === "@smthrs/capability/PermissionRequired"
            }

            if (fault === "legacyRunV1") yield* put("r", "flows.kernel.grant.run.v1", {})
            else if (fault === "corruptPayload") yield* put("p", "flows.kernel.grant.remembered.v1", { bad: true })
            else if (fault === "typeMismatch") yield* put("p", "flows.kernel.grant.remembered.v1", encodeEv(envEv("remembered", [validPat])))
            else if (fault === "unsafeRemembered") yield* put("p", "flows.kernel.grant.remembered.v1", encodeEv(remEv(unsafePat)))
            else if (fault === "unsafeRememberedOtherRoot") {
              yield* put(
                "p",
                "flows.kernel.grant.remembered.v1",
                encodeEv(remEv(new Capability.CapabilityPattern({ action: "fs:write", resource: "/other/b/**" }), Capability.make("fs:write", "/other/a/x.txt")))
              )
            } else if (fault === "unsafeRememberedEnv") yield* put("p", "flows.kernel.grant.envelope.v1", encodeEv(envEv("remembered", [unsafePat])))
            else if (fault === "runInPolicy") yield* put("p", "flows.kernel.grant.run.v2", encodeEv(runEv(validPat)))
            else if (fault === "runIdMismatch") yield* put("r", "flows.kernel.grant.run.v2", encodeEv(runEv(validPat, "other-run")))
            else if (fault === "unsafeRunGrant") yield* put("r", "flows.kernel.grant.run.v2", encodeEv(runEv(unsafePat)))
            else if (fault === "unsafeRunEnv") yield* put("r", "flows.kernel.grant.envelope.v1", encodeEv(envEv("run", [unsafePat])))
            else if (fault === "rememberedInRun") yield* put("r", "flows.kernel.grant.remembered.v1", encodeEv(remEv(validPat)))

            const err = yield* Effect.flip(JournalGrantStore.make(baseOpts))
            return err.code === "invalid_resolution"
          }).pipe(Effect.provide(TestJournal.layer()))
        }).pipe(Effect.provide(Workspace.layer("/workspace")), Effect.scoped),
      { seed: seed + 13, executions: 100 }
    )
  })
})

describe("@smthrs/kernel Jj decorator fuzz invariants", () => {
  it("Jj.layer checks capabilities before delegating, forwards missing optional methods, handles ill-formed UTF-16, and detects symlink swaps", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        withOptional: Schema.Boolean,
        allowed: Schema.Boolean,
        swapDuringAdd: Schema.Boolean,
        msgKind: Schema.Literals(["undef", "short", "long", "digestForm", "loneSurrogateLong"])
      })
    )
    await runFuzz(
      arb,
      ({ withOptional, allowed, swapDuringAdd, msgKind }) =>
        Effect.gen(function*() {
          const log: Array<string> = []
          let destTarget = "/workspace/wt"
          const fakeFs = EffectFileSystem.makeNoop({
            realPath: (p) => Effect.sync(() => p === "/workspace/wt-link" ? destTarget : p)
          })
          const baseImpl = {
            status: () => Effect.sync(() => { log.push("call:status"); return "ok" }),
            diff: () => Effect.sync(() => { log.push("call:diff"); return "diff" }),
            snapshot: () => Effect.sync(() => { log.push("call:snapshot"); return { commitId: "c", changeId: "ch" } }),
            restore: () => Effect.sync(() => { log.push("call:restore") }),
            workspaceAdd: () => Effect.sync(() => { log.push("call:workspaceAdd") }),
            workspaceForget: () => Effect.sync(() => { log.push("call:workspaceForget") }),
            ...(withOptional
              ? {
                root: () => Effect.sync(() => { log.push("call:root"); return "/workspace" }),
                revert: () => Effect.sync(() => { log.push("call:revert"); return { reverted: [] } }),
                opRestore: () => Effect.sync(() => { log.push("call:opRestore") })
              }
              : {})
          }
          const host = HostJj.make(baseImpl)
          const store = GrantStore.GrantStore.of({
            policy: GrantStore.emptyPolicy,
            check: (cap) =>
              Effect.suspend(() => {
                log.push(`check:${cap.action}`)
                if (swapDuringAdd && cap.action === "fs:write") destTarget = "/outside/evil"
                return allowed
                  ? Effect.void
                  : Effect.fail(Permission.permissionDenied(cap, "nope"))
              }),
            reply: () => Effect.void,
            list: Effect.succeed([]),
            grantEnvelope: () => Effect.void
          })

          return yield* Effect.gen(function*() {
            const jj = yield* Jj.Jj
            if (withOptional !== (jj.root !== undefined)) return false
            if (withOptional !== (jj.revert !== undefined)) return false
            if (withOptional !== (jj.opRestore !== undefined)) return false

            const msg = msgKind === "undef"
              ? undefined
              : msgKind === "short"
              ? "checkpoint"
              : msgKind === "long"
              ? `${"a".repeat(3899)}\uD83D\uDE00${"b".repeat(300)}`
              : msgKind === "loneSurrogateLong"
              ? "\uD800".repeat(4100)
              : `fake… sha256:${"0".repeat(64)}`

            const r1 = yield* Effect.result(jj.status())
            const r2 = yield* Effect.result(jj.diff("a", "b"))
            const r3 = yield* Effect.result(jj.snapshot(msg))
            const r4 = yield* Effect.result(jj.restore("rev1"))
            const r5 = yield* Effect.result(jj.workspaceAdd("lane", "/workspace/wt-link"))
            const r6 = yield* Effect.result(jj.workspaceForget("lane"))

            if (msgKind === "loneSurrogateLong" && Result.isSuccess(r3)) return false
            if (!allowed) {
              if ([r1, r2, r3, r4, r5, r6].some((r) => r._tag === "Success")) return false
              if (log.some((e) => e.startsWith("call:"))) return false
            } else {
              if ([r1, r2, r4, r6].some((r) => r._tag === "Failure")) return false
              if (msgKind !== "loneSurrogateLong" && Result.isFailure(r3)) return false
              if (swapDuringAdd && Result.isSuccess(r5)) return false
              if (!swapDuringAdd && Result.isFailure(r5)) return false
            }

            if (withOptional) {
              const r7 = yield* Effect.result(jj.root!("/workspace/sub"))
              const r8 = yield* Effect.result(jj.revert!("rev1"))
              const r9 = yield* Effect.result(jj.opRestore!("op1"))
              if (allowed && [r7, r8, r9].some((r) => r._tag === "Failure")) return false
              if (!allowed && [r7, r8, r9].some((r) => r._tag === "Success")) return false
            }
            return true
          }).pipe(
            Effect.provide(Jj.layer),
            Effect.provideService(HostJj.Jj, host),
            Effect.provideService(EffectFileSystem.FileSystem, fakeFs),
            Effect.provide(EffectPath.layer),
            Effect.provide(Workspace.layer("/workspace")),
            Effect.provideService(GrantStore.GrantStore, store)
          )
        }),
      { seed: seed + 14, executions: ioExecutions }
    )
  })
})

describe("@smthrs/kernel HttpClient fuzz invariants", () => {
  it("HttpClient enforces URL normalization, scheme separation, model calls, redirects, preflight admissions, body snapshots, and destination pinning", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        method: Schema.Literals(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"]),
        scheme: Schema.Literals(["https:", "http:", "ftp:"]),
        trailingDot: Schema.Boolean,
        port: Schema.Literals(["", ":8443"]),
        modelCall: Schema.Boolean,
        redirectMode: Schema.Literals(["none", "followAllowed", "followDenied", "manual"]),
        usePreflight: Schema.Boolean,
        preflightDenied: Schema.Boolean,
        bodyKind: Schema.Literals(["empty", "rawBytes", "rawBuf", "rawParams", "rawBlob", "rawNull", "rawStr", "rawNum", "rawBool", "rawInvalid", "uint8", "formData", "stream"]),
        pinned: Schema.Boolean
      })
    )
    await runFuzz(
      arb,
      ({ method, scheme, trailingDot, port, modelCall, redirectMode, usePreflight, preflightDenied, bodyKind, pinned }) =>
        Effect.gen(function*() {
          const checks: Array<Capability.Capability> = []
          const calls: Array<string> = []
          const store = GrantStore.GrantStore.of({
            policy: GrantStore.emptyPolicy,
            check: (cap) =>
              Effect.suspend(() => {
                checks.push(cap)
                if (usePreflight && preflightDenied) {
                  return Effect.fail(Permission.permissionDenied(cap, "preflight denied"))
                }
                if (redirectMode === "followDenied" && cap.resource.includes("second.test")) {
                  return Effect.fail(Permission.permissionDenied(cap, "second hop denied"))
                }
                return Effect.void
              }),
            reply: () => Effect.void,
            list: Effect.succeed([]),
            grantEnvelope: () => Effect.void
          })
          const baseClient = EffectHttpClient.make((request) =>
            Effect.sync(() => {
              calls.push(request.url)
              if (redirectMode !== "none" && request.url.toLowerCase().includes("first.test")) {
                return { status: 302, headers: { location: "https://second.test/next" }, request } as unknown as HttpClientResponse.HttpClientResponse
              }
              return { status: 200, headers: {}, request } as unknown as HttpClientResponse.HttpClientResponse
            })
          )
          const rawClient = pinned ? HttpClient.withDestinationPinning(baseClient) : baseClient

          const hostName = trailingDot ? "First.Test." : "First.Test"
          const url = `${scheme}//${hostName}${port}/v1`
          let req = HttpClientRequest.make(method)(url).pipe(
            HttpClientRequest.setUrlParam("q", "1"),
            HttpClientRequest.setHash("top")
          )
          const mkBody = (): HttpBody.HttpBody => {
            if (bodyKind === "empty") return HttpBody.empty
            if (bodyKind === "rawBytes") return HttpBody.raw(new Uint8Array([1, 2]))
            if (bodyKind === "rawBuf") return HttpBody.raw(new Uint8Array([3, 4]).buffer)
            if (bodyKind === "rawParams") return HttpBody.raw(new URLSearchParams({ a: "1" }))
            if (bodyKind === "rawBlob") return HttpBody.raw(new Blob(["hi"]))
            if (bodyKind === "rawNull") return HttpBody.raw(null)
            if (bodyKind === "rawStr") return HttpBody.raw("hello")
            if (bodyKind === "rawNum") return HttpBody.raw(42)
            if (bodyKind === "rawBool") return HttpBody.raw(true)
            if (bodyKind === "rawInvalid") return HttpBody.raw({ bad: true })
            if (bodyKind === "uint8") return HttpBody.uint8Array(new Uint8Array([5]), "application/octet-stream")
            if (bodyKind === "formData") {
              const fd = new FormData()
              fd.append("k", "v")
              return HttpBody.formData(fd)
            }
            return HttpBody.stream(Stream.succeed(new Uint8Array([9])), "application/octet-stream", 1)
          }
          if (method !== "GET" && method !== "HEAD") {
            req = HttpClientRequest.setBody(req, mkBody())
          }

          return yield* Effect.gen(function*() {
            const client = yield* EffectHttpClient.HttpClient
            if (HttpClient.supportsDestinationPinning(client) !== pinned) return false

            const execOnce = client.execute(req).pipe(
              redirectMode === "manual"
                ? Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" })
                : (e) => e
            )
            const eff = usePreflight
              ? HttpClient.authorizePreflight(req, execOnce.pipe(Effect.andThen(execOnce)))
              : execOnce
            const wrapped = modelCall ? eff.pipe(HttpClient.withModelCall("m/1")) : eff
            const res = yield* Effect.result(wrapped)

            if (usePreflight && preflightDenied) {
              return Result.isFailure(res) && Option.isSome(HttpClient.fromHttpClientError(res.failure)) && calls.length === 0
            }

            const invalidBody = method !== "GET" && method !== "HEAD" && bodyKind === "rawInvalid"
            if (invalidBody) {
              return Result.isFailure(res) && Option.isNone(HttpClient.fromHttpClientError(res.failure))
            }

            const expectedAction = modelCall ? "model:call" : (method === "GET" || method === "HEAD") ? "net:get" : "net:post"
            const expectedHost = `first.test${port}`
            const expectedBase = scheme === "https:" ? expectedHost : `${scheme}//${expectedHost}`
            const expectedRes = modelCall ? `${expectedBase}/m/1` : expectedBase
            if (checks[0]?.action !== expectedAction || checks[0]?.resource !== expectedRes) return false

            if (redirectMode === "followDenied") {
              if (Result.isSuccess(res)) return false
              const perm = HttpClient.fromHttpClientError(res.failure)
              return Option.isSome(perm) && perm.value.code === "permission_denied"
            }
            if (Result.isFailure(res)) return false
            if (redirectMode === "manual" && res.success.status !== 302) return false
            if (redirectMode === "followAllowed" && !calls.includes("https://second.test/next")) return false
            if (usePreflight && redirectMode === "none" && checks.length !== 2) return false
            return true
          }).pipe(
            Effect.provide(HttpClient.layer),
            Effect.provideService(EffectHttpClient.HttpClient, rawClient),
            Effect.provideService(GrantStore.GrantStore, store)
          )
        }),
      { seed: seed + 15, executions: 70 }
    )
  })

  it("HttpClient rejects invalid/oversized URLs, provides makeNoop/layerNoop/isUnavailable, and defaults ResolveHost to ResolveHostUnavailable", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        badUrl: Schema.Literals(["/relative", "not a url", `https://${"a".repeat(4100)}`, "x".repeat(4100)]),
        hostname: Schema.Literals(["example.com", "api.internal", "localhost"])
      })
    )
    await runFuzz(
      arb,
      ({ badUrl, hostname }) =>
        Effect.gen(function*() {
          const raw = EffectHttpClient.make(() => Effect.die("never called"))
          const err = yield* Effect.gen(function*() {
            const client = yield* EffectHttpClient.HttpClient
            return yield* Effect.flip(client.get(badUrl))
          }).pipe(
            Effect.provide(HttpClient.layer),
            Effect.provideService(EffectHttpClient.HttpClient, raw),
            Effect.provide(GrantStore.layerNoop)
          )
          if (Option.isNone(HttpClient.fromHttpClientError(err))) return false

          const noopErr = yield* Effect.gen(function*() {
            const client = yield* EffectHttpClient.HttpClient
            return yield* Effect.flip(client.get("https://example.test"))
          }).pipe(Effect.provide(HttpClient.layerNoop()))
          if (!HttpClient.isUnavailable(noopErr)) return false
          if (HttpClient.isUnavailable(err)) return false

          const resolveErr = yield* Effect.withFiber((fiber) => fiber.getRef(HttpClient.ResolveHost)(hostname)).pipe(
            Effect.flip
          )
          if (!(resolveErr instanceof HttpClient.ResolveHostUnavailable)) return false
          const dest = yield* Effect.withFiber((fiber) => Effect.succeed(fiber.getRef(HttpClient.Destination)))
          return dest === undefined
        }),
      { seed: seed + 16, executions: 30 }
    )
  })
})

describe("@smthrs/kernel ProcessLedger, ContainedSpawner, Pipeline & ChildProcessSpawner fuzz invariants", () => {
  it("ProcessLedger state machine matches reference model across record/release/reaped/skipped, snapshots, and multi-incarnation replay", async () => {
    const opSchema = Schema.Struct({
      op: Schema.Literals(["record", "release", "reaped", "skipped"]),
      pid: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 5 }))),
      detached: Schema.Boolean,
      explicitTime: Schema.Boolean
    })
    const arb = Arbitrary.schema(Schema.Array(opSchema).pipe(Schema.check(Schema.isMaxLength(20))))
    await runFuzz(
      arb,
      (ops) =>
        Effect.gen(function*() {
          const writer = yield* ProcessLedger.make({ hostId: "h-fuzz", ownerPid: 100 })
          const sameOwner = yield* ProcessLedger.make({ hostId: "h-fuzz", ownerPid: 100 })
          const reader = yield* ProcessLedger.make({ hostId: "h-fuzz", ownerPid: 200 })
          const history: Array<ProcessLedger.ProcessRecord> = []
          const expected = new Map<string, ProcessLedger.ProcessRecord>()
          for (let i = 0; i < ops.length; i++) {
            const step = ops[i]!
            if (step.op === "record") {
              const rec = yield* writer.record({
                pid: step.pid,
                pgid: step.detached ? step.pid : null,
                commandDigest: "tool",
                ...(step.explicitTime ? { startedAtMs: 1000 + i } : {})
              })
              history.push(rec)
              expected.set(`${rec.pid}:${rec.startedAtMs}`, rec)
            } else if (history.length > 0) {
              const target = history[step.pid % history.length]!
              if (step.op === "skipped") yield* writer.skipped(target, "mismatch")
              else if (step.op === "reaped") yield* writer.reaped(target)
              else yield* writer.release(target)
              expected.delete(`${target.pid}:${target.startedAtMs}`)
            }
          }
          // Same process incarnation + same ownerPid must see 0 orphans
          if ((yield* sameOwner.orphans).length !== 0) return false
          const orphans = yield* reader.orphans
          if (orphans.length !== expected.size) return false
          const orphans2 = yield* reader.orphans
          if (orphans2.length !== expected.size) return false

          const layerLive = yield* Effect.gen(function*() {
            const l = yield* ProcessLedger.ProcessLedger
            yield* l.record({ pid: 99, pgid: 99, commandDigest: "x" })
            return yield* l.live
          }).pipe(Effect.provide(ProcessLedger.layer({ hostId: "h-layer", ownerPid: 5 })))
          const memLive = yield* Effect.gen(function*() {
            const l = yield* ProcessLedger.ProcessLedger
            const r = yield* l.record({ pid: 88, pgid: null, commandDigest: "y" })
            yield* l.reaped(r)
            yield* l.skipped(r, "r")
            yield* l.release(r)
            return (yield* l.live).length === 0 && (yield* l.orphans).length === 0
          }).pipe(Effect.provide(ProcessLedger.layerMemory({ hostId: "h-mem", ownerPid: 6 })))
          return layerLive.length === 1 && memLive
        }).pipe(Effect.provide(TestJournal.layer()), Effect.scoped),
      { seed: seed + 17, executions: ioExecutions }
    )
  })

  it("ProcessLedger handles corrupt/invalid snapshots, concurrent newer snapshots, malformed entries, periodic checkpoints, cursor stalls, and journal failures", async () => {
    const faults = [
      "invalidSnapProducer",
      "invalidSnapPayload",
      "invalidSnapCursor",
      "malformedEntry",
      "otherSourceEntry",
      "unknownEventType",
      "emptyPageStart",
      "emptyPageAfter",
      "cursorStalled",
      "unreadableJournal",
      "snapshotWriteFail",
      "concurrentNewerSnapshot",
      "periodicCheckpoint",
      "periodicCheckpointReadFail",
      "appendFailDropsLive"
    ] as const
    const arb = Arbitrary.schema(
      Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: faults.length - 1 })))
    )
    const snapType = "flows.host.process-snapshot.v1"
    const mkRow = (seq: number, eventType: string, payload: unknown, src: string = ProcessLedger.sourceId) =>
      new JournalEvent.Entry({
        runId: ProcessLedger.hostRunId("h-fault"),
        seq: seq as JournalEvent.Seq,
        eventId: `e-${seq}`,
        sourceId: src as JournalEvent.SourceId,
        sourceSeq: seq as JournalEvent.SourceSeq,
        emittedAtMs: 0,
        eventType,
        payload,
        meta: {}
      })
    const sampleRec = { pid: 7, pgid: 7, hostId: "h-fault", ownerPid: 1, startedAtMs: 0, commandDigest: "sleep" }

    await runFuzz(
      arb,
      (idx) =>
        Effect.gen(function*() {
          const fault = faults[idx]!
          if (fault === "unreadableJournal" || fault === "appendFailDropsLive") {
            const ledger = yield* ProcessLedger.make({ hostId: "h-fault", ownerPid: 1 }).pipe(
              Effect.provide(JournalModule.layerNoop())
            )
            if (fault === "appendFailDropsLive") {
              const e = yield* Effect.flip(ledger.record({ pid: 7, pgid: 7, commandDigest: "x" }))
              return e._tag === "@smthrs/journal/JournalError" && (yield* ledger.live).length === 0
            }
            const err = yield* Effect.flip(ledger.orphans)
            return err.code === "journal_unreadable"
          }

          if (fault === "emptyPageStart" || fault === "emptyPageAfter" || fault === "cursorStalled") {
            let calls = 0
            const journal = JournalModule.makeNoop({
              entries: (o) => {
                if (o.eventTypes?.includes(snapType)) return Effect.succeed({ entries: [], hasMore: false })
                calls += 1
                if (fault === "emptyPageStart") return Effect.succeed({ entries: [], hasMore: true })
                if (fault === "emptyPageAfter") {
                  return calls === 1
                    ? Effect.succeed({ entries: [mkRow(0, ProcessLedger.SpawnedEventType, sampleRec)], hasMore: true })
                    : Effect.succeed({ entries: [], hasMore: true })
                }
                return Effect.succeed({ entries: [mkRow(0, ProcessLedger.SpawnedEventType, sampleRec)], hasMore: true })
              }
            })
            const ledger = yield* ProcessLedger.make({ hostId: "h-fault", ownerPid: 2 }).pipe(
              Effect.provideService(JournalModule.Journal, journal)
            )
            const err = yield* Effect.flip(ledger.orphans)
            return err.code === "cursor_stalled"
          }

          return yield* Effect.gen(function*() {
            const j = yield* JournalModule.Journal
            const w = yield* ProcessLedger.make({ hostId: "h-fault", ownerPid: 1 })

            if (fault === "periodicCheckpoint" || fault === "periodicCheckpointReadFail") {
              const targetJournal = fault === "periodicCheckpointReadFail"
                ? JournalModule.make({ ...j, entries: JournalModule.makeNoop().entries })
                : j
              const pw = yield* ProcessLedger.make({ hostId: "h-fault", ownerPid: 1 }).pipe(
                Effect.provideService(JournalModule.Journal, targetJournal)
              )
              for (let p = 1; p <= 129; p++) {
                const rec = yield* pw.record({ pid: p, pgid: p, commandDigest: "t", startedAtMs: p })
                yield* pw.release(rec)
              }
              const left = yield* pw.record({ pid: 999, pgid: 999, commandDigest: "keep", startedAtMs: 999 })
              const succ = yield* ProcessLedger.make({ hostId: "h-fault", ownerPid: 2 })
              const orphs = yield* succ.orphans
              return orphs.length === 1 && orphs[0]!.pid === left.pid
            }

            const abandoned = yield* w.record({ pid: 55, pgid: 55, commandDigest: "s", startedAtMs: 10 })
            if (fault === "concurrentNewerSnapshot") {
              const newer = yield* ProcessLedger.make({ hostId: "h-fault", ownerPid: 2 })
              let interleaved = false
              const concJournal = JournalModule.make({
                ...j,
                entries: (o) =>
                  j.entries(o).pipe(
                    Effect.tap(() =>
                      Effect.gen(function*() {
                        if (interleaved || o.eventTypes?.includes(snapType)) return
                        interleaved = true
                        yield* w.record({ pid: 56, pgid: 56, commandDigest: "s2", startedAtMs: 11 })
                        yield* newer.orphans.pipe(Effect.orDie)
                      })
                    )
                  )
              })
              const stale = yield* ProcessLedger.make({ hostId: "h-fault", ownerPid: 3 }).pipe(
                Effect.provideService(JournalModule.Journal, concJournal)
              )
              const staleOrphs = yield* stale.orphans
              return interleaved && staleOrphs.length === 1
            }

            if (fault === "snapshotWriteFail") {
              const faulted = JournalModule.make({
                ...j,
                emitDurableUnfenced: (input) =>
                  input.eventType === snapType
                    ? JournalModule.makeNoop().emitDurableUnfenced(input)
                    : j.emitDurableUnfenced(input)
              })
              const s = yield* ProcessLedger.make({ hostId: "h-fault", ownerPid: 2 }).pipe(
                Effect.provideService(JournalModule.Journal, faulted)
              )
              return (yield* s.orphans).length === 1
            }

            if (fault === "invalidSnapProducer" || fault === "invalidSnapPayload" || fault === "invalidSnapCursor") {
              yield* j.emitDurableUnfenced(
                new JournalEvent.Input({
                  runId: ProcessLedger.hostRunId("h-fault"),
                  sourceId: (fault === "invalidSnapProducer" ? "other" : ProcessLedger.sourceId) as JournalEvent.SourceId,
                  eventType: snapType,
                  payload: fault === "invalidSnapPayload" ? {} : { through: fault === "invalidSnapCursor" ? 999 : 0, records: [] }
                })
              )
            } else if (fault === "malformedEntry") {
              yield* j.emitDurableUnfenced(
                new JournalEvent.Input({
                  runId: ProcessLedger.hostRunId("h-fault"),
                  sourceId: ProcessLedger.sourceId as JournalEvent.SourceId,
                  eventType: ProcessLedger.SpawnedEventType,
                  payload: { bad: true }
                })
              )
            } else if (fault === "otherSourceEntry") {
              yield* j.emitDurableUnfenced(
                new JournalEvent.Input({
                  runId: ProcessLedger.hostRunId("h-fault"),
                  sourceId: "forged" as JournalEvent.SourceId,
                  eventType: ProcessLedger.SpawnedEventType,
                  payload: sampleRec
                })
              )
            } else if (fault === "unknownEventType") {
              yield* j.emitDurableUnfenced(
                new JournalEvent.Input({
                  runId: ProcessLedger.hostRunId("h-fault"),
                  sourceId: ProcessLedger.sourceId as JournalEvent.SourceId,
                  eventType: "flows.host.unknown.v1",
                  payload: sampleRec
                })
              )
            }
            const s = yield* ProcessLedger.make({ hostId: "h-fault", ownerPid: 2 })
            const orphs = yield* s.orphans
            return orphs.length === 1 && orphs[0]!.pid === abandoned.pid
          }).pipe(Effect.provide(TestJournal.layer()))
        }).pipe(Effect.scoped),
      { seed: seed + 18, executions: 35 }
    )
  })

  it("ContainedSpawner & Pipeline wire pipes, stdin/fd configs, kill/unref, lifecycle settled/failures, and ledger retries", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        from: Schema.Literals(["undef", "stdout", "stderr", "all", "fd5"]),
        to: Schema.Literals(["undef", "stdin", "fd7", "fd7duplex"]),
        rightStdin: Schema.Literals(["none", "obj", "stream"]),
        nestedRight: Schema.Boolean,
        withLifecycle: Schema.Boolean,
        verified: Schema.Boolean,
        fault: Schema.Literals(["none", "recordFail", "activateFail", "releaseFail", "killRightFail", "killLeftFail"]),
        platform: Schema.Literals(["linux", "win32"]),
        detached: Schema.Boolean
      })
    )
    await runFuzz(
      arb,
      ({ from, to, rightStdin, nestedRight, withLifecycle, verified, fault, platform, detached }) =>
        Effect.gen(function*() {
          const events: Array<string> = []
          let nextPid = 500
          const host = Layer.succeed(HostChildProcessSpawner)(
            makeSpawner((cmd) =>
              Effect.gen(function*() {
                const name = cmd._tag === "StandardCommand" ? cmd.command : "pipe"
                const pid = nextPid++
                yield* Effect.addFinalizer(() => Effect.sync(() => { events.push(`fin:${name}`) }))
                const killErr = PlatformError.systemError({ _tag: "Unknown", module: "ChildProcess", method: "kill", description: name })
                return makeFakeHandle(pid, {
                  kill: () =>
                    Effect.suspend(() => {
                      events.push(`kill:${name}`)
                      if ((fault === "killRightFail" && name === "right") || (fault === "killLeftFail" && name === "left")) {
                        return Effect.fail(killErr)
                      }
                      return Effect.void
                    }),
                  stdout: Stream.make(new TextEncoder().encode(`out:${name}`)),
                  stderr: Stream.make(new TextEncoder().encode(`err:${name}`)),
                  all: Stream.make(new TextEncoder().encode(`all:${name}`)),
                  getOutputFd: (fd) => Stream.make(new TextEncoder().encode(`fd${fd}:${name}`)),
                  unref: Effect.sync(() => {
                    events.push(`unref:${name}`)
                    return Effect.sync(() => { events.push(`reref:${name}`) })
                  })
                })
              })
            )
          )

          const baseLedger = fault === "recordFail"
            ? yield* ProcessLedger.make({ hostId: "c", ownerPid: 1 }).pipe(Effect.provide(JournalModule.layerNoop()))
            : yield* ProcessLedger.makeMemory({ hostId: "c", ownerPid: 1 })
          const ledger = fault === "releaseFail"
            ? ProcessLedger.ProcessLedger.of({
              ...baseLedger,
              release: () => Effect.fail(new JournalModule.JournalError({ code: "journal_closed", message: "closed" }))
            })
            : baseLedger

          const lifecycle: ContainedSpawner.Lifecycle | undefined = withLifecycle
            ? (cmd, sp) =>
              Effect.gen(function*() {
                const handle = yield* sp(cmd)
                return {
                  handle,
                  activate: fault === "activateFail"
                    ? Effect.fail(PlatformError.systemError({ _tag: "NotFound", module: "ChildProcess", method: "spawn", description: "missing" }))
                    : Effect.void,
                  settled: Effect.succeed(verified)
                }
              })
            : undefined

          const cLeft = ChildProcess.make("left", [], { detached })
          const cRightBase = ChildProcess.make("right", [], {
            detached,
            ...(rightStdin === "obj"
              ? { stdin: { stream: "pipe" as const, endOnDone: false } }
              : rightStdin === "stream"
              ? { stdin: Stream.empty }
              : {}),
            ...(to === "fd7duplex" ? { additionalFds: { fd7: { type: "duplex" as const } } } : {})
          })
          const cRight: ChildProcess.Command = nestedRight
            ? ChildProcess.pipeTo(cRightBase, ChildProcess.make("tail", [], { detached }))
            : cRightBase
          const piped = ChildProcess.pipeTo(cLeft, cRight, {
            ...(from === "undef" ? {} : { from: from as ChildProcess.PipeFromOption }),
            ...(to === "undef" ? {} : { to: (to === "fd7duplex" ? "fd7" : to) as ChildProcess.PipeToOption })
          })
          // Exercise withContainment on PipedCommand directly
          const wrappedPipe = ContainedSpawner.withContainment(piped, { graceMs: 50 })
          if (wrappedPipe._tag !== "PipedCommand") return false
          const g = ContainedSpawner.groupOf(piped, 77, platform)
          if (platform === "win32" && g !== null) return false
          if (platform === "linux" && detached && g !== 77) return false
          if (platform === "linux" && !detached && g !== null) return false

          const res = yield* Effect.gen(function*() {
            const sp = yield* HostChildProcessSpawner
            if (ContainedSpawner.isContained(sp) !== withLifecycle) return false
            const handleRes = yield* Effect.result(sp.spawn(piped))
            if (fault === "recordFail" || (withLifecycle && fault === "activateFail")) {
              return Result.isFailure(handleRes)
            }
            if (Result.isFailure(handleRes)) return false
            const handle = handleRes.success
            const reref = yield* handle.unref
            yield* reref
            const kRes = yield* Effect.result(handle.kill())
            if (fault === "killRightFail" || fault === "killLeftFail") return Result.isFailure(kRes)
            return Result.isSuccess(kRes)
          }).pipe(
            Effect.provide(ContainedSpawner.layer({ graceMs: 50, platform }, lifecycle)),
            Effect.provide(host),
            Effect.provideService(ProcessLedger.ProcessLedger, ledger),
            Effect.scoped
          )
          if (!res) return false
          if (withLifecycle && !verified && fault === "none") {
            if ((yield* ledger.live).length === 0) return false
          }
          return true
        }),
      { seed: seed + 19, executions: ioExecutions }
    )
  })

  it("ChildProcessSpawner enforces grants, cwd realPath/TOCTOU, confinement, win32 PATH, redacted args, and pipelines", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        platform: Schema.Literals(["linux", "win32"]),
        extendEnv: Schema.Boolean,
        envMode: Schema.Literals(["none", "empty", "custom", "many"]),
        redactedWithShell: Schema.Boolean,
        withConfinement: Schema.Boolean,
        policyFail: Schema.Boolean,
        swapCwdDuringCheck: Schema.Boolean,
        withFs: Schema.Boolean,
        piped: Schema.Boolean,
        longArg: Schema.Boolean
      })
    )
    await runFuzz(
      arb,
      ({ platform, extendEnv, envMode, redactedWithShell, withConfinement, policyFail, swapCwdDuringCheck, withFs, piped, longArg }) =>
        Effect.gen(function*() {
          let cwdTarget = "/workspace/sub"
          const fakeFs = EffectFileSystem.makeNoop({
            realPath: (p) => Effect.sync(() => p === "/workspace/link" ? cwdTarget : p)
          })
          const spawned: Array<ChildProcess.Command> = []
          const rawSpawner = makeSpawner((cmd) =>
            Effect.sync(() => {
              spawned.push(cmd)
              return makeFakeHandle(11)
            })
          )
          const store = GrantStore.GrantStore.of({
            policy: policyFail
              ? Effect.fail(new Permission.GrantStoreError({ code: "store_closed", message: "closed" }))
              : GrantStore.emptyPolicy,
            check: () =>
              Effect.sync(() => {
                if (swapCwdDuringCheck && withFs) cwdTarget = "/outside/moved"
              }),
            reply: () => Effect.void,
            list: Effect.succeed([]),
            grantEnvelope: () => Effect.void
          })

          const spawnerLayer = ChildProcessSpawner.layerWith({ platform }).pipe(
            withConfinement ? Layer.provide(ProcessConfinement.layerNoop) : (l) => l,
            Layer.provide(Workspace.layer("/workspace")),
            Layer.provide(EffectPath.layer),
            withFs ? Layer.provide(Layer.succeed(EffectFileSystem.FileSystem, fakeFs)) : (l) => l,
            Layer.provide(Layer.succeed(HostChildProcessSpawner, rawSpawner)),
            Layer.provide(Layer.succeed(GrantStore.GrantStore, store))
          )

          const envObj: Record<string, string | undefined> | undefined =
            envMode === "none" ? undefined
            : envMode === "empty" ? { UNSET: undefined }
            : envMode === "custom" ? { CUSTOM: "val" }
            : Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`V_${i}`, "1"]))

          const args = redactedWithShell
            ? [Redacted.make("secret")]
            : longArg
            ? ["x".repeat(4200)]
            : ["ok"]
          const s1 = ChildProcess.make("echo", args, {
            cwd: "link",
            extendEnv,
            ...(envObj === undefined ? {} : { env: envObj }),
            ...(redactedWithShell ? { shell: true } : {}),
            stdin: { stream: "pipe", endOnDone: true, encoding: "utf8" },
            stdout: "pipe",
            additionalFds: {
              fd3: { type: "input", stream: Stream.empty },
              fd4: { type: "output" },
              fd5: { type: "duplex", stream: Stream.empty }
            }
          })
          const cmd: ChildProcess.Command = piped
            ? ChildProcess.pipeTo(s1, ChildProcess.make("cat", [], { extendEnv }), { from: "stdout", to: "stdin" })
            : s1

          const outcome = yield* Effect.gen(function*() {
            const sp = yield* HostChildProcessSpawner
            return yield* Effect.result(sp.spawn(cmd))
          }).pipe(Effect.provide(spawnerLayer), Effect.scoped)

          if (redactedWithShell) {
            return Result.isFailure(outcome) && outcome.failure.reason._tag === "InvalidData"
          }
          if (swapCwdDuringCheck && withFs) {
            return Result.isFailure(outcome) && outcome.failure.reason._tag === "PermissionDenied"
          }
          if (!withConfinement) {
            return Result.isFailure(outcome) && outcome.failure.reason._tag === "NotFound"
          }
          if (policyFail) {
            return Result.isFailure(outcome) && outcome.failure.reason._tag === "PermissionDenied"
          }
          if (Result.isFailure(outcome)) return false
          if (Object.keys(ChildProcessSpawner.ambientEnvironment({})).length !== 0) return false
          const noopErr = yield* Effect.gen(function*() {
            const sp = yield* HostChildProcessSpawner
            return yield* Effect.flip(sp.spawn(ChildProcess.make("x")))
          }).pipe(Effect.provide(ChildProcessSpawner.layerNoop()), Effect.scoped)
          return noopErr.reason._tag === "NotFound"
        }),
      { seed: seed + 20, executions: ioExecutions }
    )
  })

  it("ChildProcessSpawner rejects every adversarial or malformed command snapshot shape before checking grants", async () => {
    const shapes = [
      "badTag",
      "getterCmd",
      "badArgs",
      "badOpts",
      "badEnvGetter",
      "badEnvVal",
      "badStreamGetter",
      "badStreamEndOnDoneGetter",
      "badFdNull",
      "badFdType",
      "badFdStreamGetter",
      "badFdSinkGetter",
      "badPipeNull",
      "badPipeOptsNull",
      "badPipeFromGetter"
    ] as const
    const arb = Arbitrary.schema(
      Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: shapes.length - 1 })))
    )
    await runFuzz(
      arb,
      (idx) =>
        Effect.gen(function*() {
          const badShape = shapes[idx]!
          const buildBad = (): ChildProcess.Command => {
            if (badShape === "badTag") return { _tag: "Bogus" } as unknown as ChildProcess.Command
            if (badShape === "getterCmd") {
              const o: Record<string, unknown> = { _tag: "StandardCommand", args: [], options: {} }
              Object.defineProperty(o, "command", { enumerable: true, get: () => "echo" })
              return o as unknown as ChildProcess.Command
            }
            if (badShape === "badArgs") return { _tag: "StandardCommand", command: "echo", args: [123], options: {} } as unknown as ChildProcess.Command
            if (badShape === "badOpts") return { _tag: "StandardCommand", command: "echo", args: [], options: null } as unknown as ChildProcess.Command
            if (badShape === "badEnvGetter") {
              const e: Record<string, unknown> = {}
              Object.defineProperty(e, "HIDDEN", { enumerable: false, value: "ignored" })
              Object.defineProperty(e, "X", { enumerable: true, get: () => "1" })
              return ChildProcess.make("echo", [], { env: e as Record<string, string> })
            }
            if (badShape === "badEnvVal") {
              return ChildProcess.make("echo", [], { env: { X: 123 as unknown as string } })
            }
            if (badShape === "badStreamGetter") {
              const s: Record<string, unknown> = {}
              Object.defineProperty(s, "stream", { enumerable: true, get: () => "pipe" })
              return ChildProcess.make("echo", [], { stdin: s as never })
            }
            if (badShape === "badStreamEndOnDoneGetter") {
              const s: Record<string, unknown> = { stream: "pipe" }
              Object.defineProperty(s, "endOnDone", { enumerable: true, get: () => true })
              return ChildProcess.make("echo", [], { stdin: s as never })
            }
            if (badShape === "badFdNull") {
              const fds: Record<string, unknown> = {}
              Object.defineProperty(fds, "fd2", { enumerable: false, value: null })
              fds.fd3 = null
              return ChildProcess.make("echo", [], { additionalFds: fds as never })
            }
            if (badShape === "badFdType") {
              return ChildProcess.make("echo", [], { additionalFds: { fd3: { type: "invalid" } as never } })
            }
            if (badShape === "badFdStreamGetter") {
              const fd: Record<string, unknown> = { type: "input" }
              Object.defineProperty(fd, "stream", { enumerable: true, get: () => Stream.empty })
              return ChildProcess.make("echo", [], { additionalFds: { fd3: fd as never } })
            }
            if (badShape === "badFdSinkGetter") {
              const fd: Record<string, unknown> = { type: "output" }
              Object.defineProperty(fd, "sink", { enumerable: true, get: () => Sink.drain })
              return ChildProcess.make("echo", [], { additionalFds: { fd3: fd as never } })
            }
            if (badShape === "badPipeNull") {
              return { _tag: "PipedCommand", left: null, right: null, options: {} } as unknown as ChildProcess.Command
            }
            if (badShape === "badPipeOptsNull") {
              return { _tag: "PipedCommand", left: ChildProcess.make("a"), right: ChildProcess.make("b"), options: null } as unknown as ChildProcess.Command
            }
            const opts: Record<string, unknown> = {}
            Object.defineProperty(opts, "from", { enumerable: true, get: () => "stdout" })
            return { _tag: "PipedCommand", left: ChildProcess.make("a"), right: ChildProcess.make("b"), options: opts } as unknown as ChildProcess.Command
          }

          const spawnerLayer = ChildProcessSpawner.layer.pipe(
            Layer.provide(ProcessConfinement.layerNoop),
            Layer.provide(Workspace.layer("/workspace")),
            Layer.provide(EffectPath.layer),
            Layer.provide(ChildProcessSpawner.layerNoop()),
            Layer.provide(GrantStore.layerNoop)
          )
          const err = yield* Effect.gen(function*() {
            const sp = yield* HostChildProcessSpawner
            return yield* Effect.flip(sp.spawn(buildBad()))
          }).pipe(Effect.provide(spawnerLayer), Effect.scoped)
          return err.reason._tag === "InvalidData"
        }),
      { seed: seed + 24, executions: 50 }
    )
  })
})

describe("@smthrs/kernel FileSystem & HostServices fuzz invariants", () => {
  it("FileSystem isolated host guards all operations, open file descriptors, temp paths, directoryContent, and rejects double isolation / unsupported ops", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        openFlag: Schema.Literals(["r", "w", "r+", "w+", "a", "a+", "wx", "wx+", "ax", "ax+"]),
        inoMode: Schema.Literals(["match", "swap", "missing", "becameDir", "none"]),
        explicitTempDir: Schema.Boolean,
        restrictDir: Schema.Boolean,
        allowGrants: Schema.Boolean,
        statErrOnDir: Schema.Literals(["none", "notFound", "otherErr"])
      })
    )
    await runFuzz(
      arb,
      ({ openFlag, inoMode, explicitTempDir, restrictDir, allowGrants, statErrOnDir }) =>
        Effect.gen(function*() {
          let currentIno: Option.Option<number> = inoMode === "none" ? Option.none() : Option.some(10)
          let handleType: "File" | "Directory" = "File"
          const mkInfo = (type: "File" | "Directory", ino: Option.Option<number> = currentIno) =>
            ({ type, dev: 1n, ino, nlink: Option.some(1n) }) as unknown as EffectFileSystem.File.Info
          const fakeFile: EffectFileSystem.File = {
            [EffectFileSystem.FileTypeId]: EffectFileSystem.FileTypeId,
            stat: Effect.sync(() => mkInfo("File", inoMode === "none" ? Option.none() : Option.some(10))),
            seek: () => Effect.succeed(0n),
            sync: Effect.void,
            read: () => Effect.succeed(0),
            readAlloc: () => Effect.succeed(Option.none()),
            truncate: () => Effect.void,
            write: () => Effect.succeed(0),
            writeAll: () => Effect.void
          }
          const raw = EffectFileSystem.makeNoop({
            access: () => Effect.void,
            copy: () => Effect.void,
            copyFile: () => Effect.void,
            chmod: () => Effect.void,
            chown: () => Effect.void,
            glob: () => Effect.succeed(["/workspace/a.txt"]),
            exists: () => Effect.succeed(true),
            link: () => Effect.void,
            makeDirectory: () => Effect.void,
            makeTempDirectory: () => Effect.succeed("/workspace/tmpd"),
            makeTempDirectoryScoped: () => Effect.succeed("/workspace/tmpd"),
            makeTempFile: () => Effect.succeed("/workspace/tmpf"),
            makeTempFileScoped: () => Effect.succeed("/workspace/tmpf"),
            open: () => Effect.succeed(fakeFile),
            readDirectory: () => Effect.succeed(["a.txt"]),
            readDirectoryEntries: () => Effect.succeed([{ name: "a.txt", type: "File" }]),
            readFile: () => Effect.succeed(new Uint8Array([1, 2])),
            readFileString: () => Effect.succeed("hi"),
            readLink: () => Effect.succeed("target"),
            realPath: (p) => Effect.succeed(p),
            remove: () => Effect.void,
            rename: () => Effect.void,
            sink: () => Sink.drain,
            stat: (p) =>
              Effect.suspend(() => {
                if (p.endsWith("/dir") && statErrOnDir !== "none") {
                  return Effect.fail(
                    PlatformError.systemError({
                      _tag: statErrOnDir === "notFound" ? "NotFound" : "PermissionDenied",
                      module: "fs",
                      method: "stat"
                    })
                  )
                }
                if (inoMode === "missing" && p.endsWith("/handle.txt") && currentIno._tag === "None") {
                  return Effect.fail(PlatformError.systemError({ _tag: "NotFound", module: "fs", method: "stat" }))
                }
                if (p.endsWith("/handle.txt")) return Effect.succeed(mkInfo(handleType))
                return Effect.succeed(mkInfo(p.endsWith("/dir") ? "Directory" : "File"))
              }),
            lstat: () => Effect.succeed(mkInfo("File")),
            stream: () => Stream.succeed(new Uint8Array([1])),
            symlink: () => Effect.void,
            truncate: () => Effect.void,
            utimes: () => Effect.void,
            watch: () => Stream.empty,
            writeFile: () => Effect.void,
            writeFileString: () => Effect.void
          })
          const isolated = FileSystem.withIsolatedFileSystem(raw)
          // Exercise isolated passthrough in FileSystem.confined + direct writeFile execute
          const confinedIso = yield* FileSystem.confined(isolated, "").pipe(Effect.provide(EffectPath.layer))
          if (confinedIso !== isolated) return false
          yield* isolated[FileSystem.AtomicFileSystemTypeId].execute({
            operation: "writeFile",
            path: "/workspace/a.txt",
            data: Base64.encode(new Uint8Array([1, 2]))
          })

          let threwDouble = false
          try {
            FileSystem.withIsolatedFileSystem(isolated)
          } catch (e) {
            threwDouble = e instanceof FileSystem.FileSystemFault && e.code === "executor_already_present"
          }
          if (!threwDouble) return false

          const dieExit1 = yield* Effect.exit(isolated[FileSystem.AtomicFileSystemTypeId].execute({ operation: "resolve", path: "/workspace/a" }))
          const dieExit2 = yield* Effect.exit(isolated[FileSystem.AtomicFileSystemTypeId].execute({ operation: "batch", requests: [] }))
          const dieExit3 = yield* Effect.exit(isolated[FileSystem.AtomicFileSystemTypeId].execute({ operation: "bogus" } as never))
          if (!Exit.isFailure(dieExit1) || !Exit.isFailure(dieExit2) || !Exit.isFailure(dieExit3)) return false

          const rules = allowGrants
            ? [
              new Permission.Rule({ effect: "allow", pattern: new Capability.CapabilityPattern({ action: "*", resource: "**" }) }),
              ...(restrictDir
                ? [
                  new Permission.Rule({ effect: "deny", pattern: new Capability.CapabilityPattern({ action: "fs:write", resource: "/workspace/dir/secret/**" }) }),
                  new Permission.Rule({ effect: "deny", pattern: new Capability.CapabilityPattern({ action: "fs:read", resource: "/workspace/dir/secret/**" }) })
                ]
                : [])
            ]
            : [new Permission.Rule({ effect: "deny", pattern: new Capability.CapabilityPattern({ action: "*", resource: "**" }) })]

          const store = yield* GrantStore.make({ attended: false, rules })

          return yield* Effect.gen(function*() {
            const fs = yield* EffectFileSystem.FileSystem
            const tempOpts = explicitTempDir ? { directory: "tmp" } : undefined

            // Test snapshotOptions non-enumerable & getter rejection
            const optsNonEnum: { recursive?: boolean } = { recursive: true }
            Object.defineProperty(optsNonEnum, "hidden", { enumerable: false, value: 1 })
            yield* Effect.result(fs.makeDirectory("sub", optsNonEnum))
            const getterOpts = {} as { recursive?: boolean }
            Object.defineProperty(getterOpts, "recursive", { enumerable: true, get: () => true })
            const getterExit = yield* Effect.exit(fs.makeDirectory("sub", getterOpts))
            if (!Exit.isFailure(getterExit)) return false

            const rAccess = yield* Effect.result(fs.access("a.txt"))
            const rCopy = yield* Effect.result(fs.copy("dir", "dir2"))
            const rCopyFile = yield* Effect.result(fs.copyFile("a.txt", "b.txt"))
            const rChmod = yield* Effect.result(fs.chmod("a.txt", 0o600))
            const rChown = yield* Effect.result(fs.chown("a.txt", 1, 2))
            const rLink = yield* Effect.result(fs.link("a.txt", "l.txt"))
            const rMkdir = yield* Effect.result(fs.makeDirectory("sub", { recursive: true }))
            const rTmpD = yield* Effect.result(fs.makeTempDirectory(tempOpts))
            const rTmpDS = yield* Effect.result(fs.makeTempDirectoryScoped(tempOpts))
            const rTmpF = yield* Effect.result(fs.makeTempFile(tempOpts))
            const rTmpFS = yield* Effect.result(fs.makeTempFileScoped(tempOpts))
            const rReadDir = yield* Effect.result(fs.readDirectory("dir"))
            const rReadDirE = yield* Effect.result(fs.readDirectoryEntries("dir"))
            const rReadFile = yield* Effect.result(fs.readFile("a.txt"))
            const rReadStr = yield* Effect.result(fs.readFileString("a.txt"))
            const rReadLink = yield* Effect.result(fs.readLink("a.txt"))
            const rRealPath = yield* Effect.result(fs.realPath("a.txt"))
            const rRemove = yield* Effect.result(fs.remove("dir", { recursive: true }))
            const rRemoveNonRec = yield* Effect.result(fs.remove("a.txt"))
            const rRename = yield* Effect.result(fs.rename("dir", "dir3"))
            const rRenameFile = yield* Effect.result(fs.rename("a.txt", "b.txt"))
            const rStat = yield* Effect.result(fs.stat("a.txt"))
            const rLstat = yield* Effect.result(fs.lstat("a.txt"))
            const rSymlink = yield* Effect.result(fs.symlink("target", "sym"))
            const rTruncate = yield* Effect.result(fs.truncate("a.txt", 0))
            const rUtimes = yield* Effect.result(fs.utimes("a.txt", 0, 0))
            const rWrite = yield* Effect.result(fs.writeFile("a.txt", new Uint8Array([1, 2])))
            const rWriteStr = yield* Effect.result(fs.writeFileString("a.txt", "hi"))
            const rGlob = yield* Effect.result(fs.glob("*.txt", { exclude: ["x"] }))
            const rExists = yield* Effect.result(fs.exists("a.txt"))
            const rWatch = yield* Effect.result(Stream.runDrain(fs.watch("a.txt")))
            const rStream = yield* Effect.result(Stream.runDrain(fs.stream("a.txt")))
            const rSink = yield* Effect.result(Stream.run(Stream.make(new Uint8Array([1])), fs.sink("a.txt")))

            if (!allowGrants) {
              const all = [rAccess, rCopy, rCopyFile, rChmod, rChown, rLink, rMkdir, rTmpD, rTmpDS, rTmpF, rTmpFS, rReadDir, rReadDirE, rReadFile, rReadStr, rReadLink, rRealPath, rRemove, rRemoveNonRec, rRename, rRenameFile, rStat, rLstat, rSymlink, rTruncate, rUtimes, rWrite, rWriteStr, rGlob, rExists, rWatch, rStream, rSink]
              return all.every((r) => r._tag === "Failure")
            }

            const treatedAsDir = statErrOnDir !== "notFound"
            if (restrictDir && treatedAsDir) {
              if (Result.isSuccess(rCopy) || Result.isSuccess(rRemove) || Result.isSuccess(rRename)) return false
            } else {
              if (Result.isFailure(rCopy) || Result.isFailure(rRemove) || Result.isFailure(rRename)) return false
            }

            const opened = yield* fs.open("handle.txt", { flag: openFlag })
            if (inoMode === "swap") currentIno = Option.some(99)
            else if (inoMode === "missing") currentIno = Option.none()
            else if (inoMode === "becameDir") handleType = "Directory"
            const hStat = yield* Effect.result(opened.stat)
            yield* opened.seek(0n, "start")
            const hSync = yield* Effect.result(opened.sync)
            const hRead = yield* Effect.result(opened.read(new Uint8Array(4)))
            const hReadAlloc = yield* Effect.result(opened.readAlloc(4))
            const hTrunc = yield* Effect.result(opened.truncate(0))
            const hWrite = yield* Effect.result(opened.write(new Uint8Array([1])))
            const hWriteAll = yield* Effect.result(opened.writeAll(new Uint8Array([1])))
            if (inoMode === "swap" || inoMode === "missing" || inoMode === "becameDir") {
              return [hStat, hSync, hRead, hReadAlloc, hTrunc, hWrite, hWriteAll].every((r) => r._tag === "Failure")
            }
            return [hStat, hSync, hRead, hReadAlloc, hTrunc, hWrite, hWriteAll].every((r) => r._tag === "Success")
          }).pipe(
            Effect.provide(FileSystem.layer),
            Effect.provideService(EffectFileSystem.FileSystem, isolated),
            Effect.provide(EffectPath.layer),
            Effect.provide(Workspace.layer("/workspace")),
            Effect.provideService(GrantStore.GrantStore, store)
          )
        }).pipe(Effect.provide(Workspace.layer("/workspace")), Effect.scoped),
      { seed: seed + 21, executions: ioExecutions }
    )
  })

  it("FileSystem atomic/noFollowAuthorization, confined, canonicalResource, hard links, glob authorization, and batching preserve confinement invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        noFollow: Schema.Boolean,
        windows: Schema.Boolean,
        resolveCase: Schema.Literals(["ok", "symlinkInside", "symlinkEscape", "symlinkLoop", "outsideBoundary", "resolveErr", "toctouSwap"]),
        hardLinked: Schema.Boolean,
        globPattern: Schema.Literals(["src/a.txt", "src/*.txt", "src/@(a|b).txt", "secrets/*.txt"]),
        batchFault: Schema.Literals(["none", "empty", "tooLarge", "rootChanged", "missingIdentity", "resolveMismatch", "allDenied", "defaultIdentifyRoot"])
      })
    )
    await runFuzz(
      arb,
      ({ noFollow, windows, resolveCase, hardLinked, globPattern, batchFault }) =>
        Effect.gen(function*() {
          const root = windows ? "C:\\workspace" : "/workspace"
          const sep = windows ? "\\" : "/"
          const boundaryRoot = windows ? "C:\\realws" : "/realws"
          const joinP = (...parts: ReadonlyArray<string>) => parts.join(sep)
          let rootId = "7:9"
          let swapped = false
          const resolveFn = (p: string): Effect.Effect<FileSystem.Resolution, PlatformError.PlatformError> =>
            Effect.suspend((): Effect.Effect<FileSystem.Resolution, PlatformError.PlatformError> => {
              if (resolveCase === "resolveErr") {
                return Effect.fail(PlatformError.systemError({ _tag: "PermissionDenied", module: "fs", method: "resolve", description: "cannot inspect" }))
              }
              if (resolveCase === "outsideBoundary") {
                return Effect.succeed({ path: windows ? "D:\\other\\x" : "/other/x", target: null })
              }
              if (resolveCase === "symlinkLoop") {
                return Effect.succeed({ path: p, target: p })
              }
              if (resolveCase === "symlinkEscape") {
                return Effect.succeed({ path: p, target: windows ? "D:\\escaped\\x" : "/escaped/x" })
              }
              if (resolveCase === "symlinkInside" && p.endsWith("a.txt")) {
                return Effect.succeed({ path: p, target: "b.txt" })
              }
              if (resolveCase === "toctouSwap" && swapped) {
                return Effect.succeed({ path: `${p}.moved`, target: null })
              }
              return Effect.succeed({ path: p, target: null })
            })

          const dirInfo = {
            type: "Directory",
            dev: 7n,
            ino: batchFault === "missingIdentity" ? Option.none() : Option.some(9n),
            nlink: Option.some(1n)
          } as unknown as EffectFileSystem.File.Info
          const fileInfo = {
            type: "File",
            dev: 7n,
            ino: Option.some(10n),
            nlink: Option.some(hardLinked ? 2n : 1n)
          } as unknown as EffectFileSystem.File.Info

          const plainFs = EffectFileSystem.makeNoop({
            realPath: (p) =>
              Effect.suspend(() => {
                if (p === root) return Effect.succeed(boundaryRoot)
                if (resolveCase === "symlinkLoop") return Effect.fail(PlatformError.systemError({ _tag: "NotFound", module: "fs", method: "realPath" }))
                if (resolveCase === "toctouSwap" && swapped) return Effect.succeed(`${p}.moved`)
                if (p.includes("missing") || p === "/" || p === "C:\\") {
                  return Effect.fail(PlatformError.systemError({ _tag: "NotFound", module: "fs", method: "realPath" }))
                }
                return Effect.succeed(p.startsWith(root) ? `${boundaryRoot}${p.slice(root.length)}` : p)
              }),
            readLink: (p) =>
              Effect.suspend(() =>
                resolveCase === "symlinkLoop"
                  ? Effect.succeed(p)
                  : p.includes("missing-link")
                  ? Effect.succeed("target.txt")
                  : Effect.fail(PlatformError.systemError({ _tag: "NotFound", module: "fs", method: "readLink" }))
              ),
            stat: (p) => Effect.sync(() => p === root || p === boundaryRoot ? dirInfo : fileInfo)
          })

          // Plain host refuses FileSystem.layer operations and FileSystem.confined
          const plainCheck = yield* Effect.gen(function*() {
            const fs = yield* EffectFileSystem.FileSystem
            const r1 = yield* Effect.result(fs.readFile("a.txt"))
            const r2 = yield* Effect.result(fs.makeTempFile())
            const r2b = yield* Effect.result(fs.makeTempFileScoped({ directory: "tmp" }))
            const r2c = yield* Effect.result(fs.makeTempDirectory())
            const r2d = yield* Effect.result(fs.makeTempDirectoryScoped({ directory: "tmp" }))
            const r3 = yield* Effect.result(fs.open("a.txt"))
            const r4 = yield* Effect.result(Stream.runDrain(fs.watch("a.txt")))
            const r5 = yield* Effect.result(Stream.runDrain(fs.stream("a.txt")))
            const r6 = yield* Effect.result(Stream.run(Stream.empty, fs.sink("a.txt")))
            return [r1, r2, r2b, r2c, r2d, r3, r4, r5, r6].every((r) => r._tag === "Failure")
          }).pipe(
            Effect.provide(FileSystem.layer),
            Effect.provideService(EffectFileSystem.FileSystem, plainFs),
            Effect.provide(windows ? NodePath.layerWin32 : EffectPath.layer),
            Effect.provide(Workspace.layer(root)),
            Effect.provide(GrantStore.layerNoop),
            Effect.scoped
          )
          if (!plainCheck) return false
          if (FileSystem.isConfinable(plainFs)) return false
          const plainConfinedErr = yield* Effect.flip(
            FileSystem.confined(plainFs, root).pipe(Effect.provide(windows ? NodePath.layerWin32 : EffectPath.layer))
          )
          if (plainConfinedErr.reason._tag !== "PermissionDenied") return false
          const plainReqErr = yield* Effect.flip(FileSystem.requireConfinable(plainFs, root))
          if (plainReqErr.reason._tag !== "PermissionDenied") return false
          // Exercise canonicalResource root-parent failure
          const canonRootFail = yield* Effect.result(
            FileSystem.canonicalResource(
              plainFs,
              yield* EffectPath.Path.pipe(Effect.provide(windows ? NodePath.layerWin32 : EffectPath.layer)),
              root,
              windows ? "C:\\missing-abs\\x" : "/missing-abs/x"
            )
          )
          if (Result.isSuccess(canonRootFail)) return false

          const atomicHost = FileSystem.withAtomicFileSystem({ ...plainFs }, {
            ...(noFollow ? { noFollowAuthorization: true as const } : {}),
            ...(batchFault === "missingIdentity" || batchFault === "defaultIdentifyRoot"
              ? {}
              : { identifyRoot: () => Effect.sync(() => rootId) }),
            contentLimit: 4,
            batchLimits: { size: 4, response: 1024 },
            execute: <R extends FileSystem.AtomicRequest>(request: R): Effect.Effect<FileSystem.AtomicResult<R>, PlatformError.PlatformError> => {
              if (request.operation === "resolve") {
                return resolveFn(request.path) as unknown as Effect.Effect<FileSystem.AtomicResult<R>, PlatformError.PlatformError>
              }
              if (request.operation === "batch") {
                return Effect.map(
                  Effect.forEach(request.requests, (member, index) => {
                    if (member.operation === "resolve") {
                      return Effect.map(
                        Effect.result(resolveFn(member.path)),
                        (res) => ({
                          index,
                          path: member.path,
                          result: batchFault === "resolveMismatch"
                            ? Result.succeed({ operation: "stat" as const, info: fileInfo })
                            : Result.map(res, (resolution) => ({ operation: "resolve" as const, resolution }))
                        })
                      )
                    }
                    if (batchFault === "resolveMismatch") {
                      return Effect.succeed({
                        index,
                        path: member.path,
                        result: Result.succeed({ operation: "resolve" as const, resolution: { path: member.path, target: null } })
                      })
                    }
                    return Effect.succeed({
                      index,
                      path: member.path,
                      result: Result.succeed({ operation: "stat" as const, info: fileInfo })
                    })
                  }),
                  (entries) => ({ rootIdentity: rootId, entries })
                ) as unknown as Effect.Effect<FileSystem.AtomicResult<R>, PlatformError.PlatformError>
              }
              const answers: Partial<Record<FileSystem.AtomicRequest["operation"], unknown>> = {
                exists: true,
                readFile: new Uint8Array([1]),
                readFileString: "ok",
                readDirectory: ["a.txt"],
                stat: fileInfo,
                realPath: boundaryRoot,
                readLink: "b",
                glob: [joinP(root, "src", "a.txt")]
              }
              return Effect.succeed(answers[request.operation]) as unknown as Effect.Effect<FileSystem.AtomicResult<R>, PlatformError.PlatformError>
            }
          })

          if (batchFault !== "missingIdentity") {
            const confinedView = yield* FileSystem.confined(atomicHost, root).pipe(
              Effect.provide(windows ? NodePath.layerWin32 : EffectPath.layer)
            )
            if (!FileSystem.isConfinable(confinedView)) return false
            if (FileSystem.confinedRoot(confinedView) !== root) return false
            yield* FileSystem.requireConfinable(confinedView, root)
            const sameView = yield* FileSystem.confined(confinedView, root).pipe(
              Effect.provide(windows ? NodePath.layerWin32 : EffectPath.layer)
            )
            if (sameView !== confinedView) return false
            const bigErr = yield* Effect.flip(confinedView.writeFile("a.txt", new Uint8Array(10)))
            if (bigErr.reason._tag !== "BadArgument") return false
            yield* confinedView.writeFile("a.txt", new Uint8Array([1, 2]))
            yield* confinedView.writeFileString("a.txt", "hi")
            yield* confinedView.readFile("a.txt")
            yield* confinedView.readFileString("a.txt")
            yield* confinedView.exists("a.txt")
            yield* confinedView.readDirectory(".")
            yield* confinedView.readDirectoryEntries(".")
            yield* confinedView.stat("a.txt")
            yield* confinedView.lstat("a.txt")
            yield* confinedView.chmod("a.txt", 0o644)
            yield* confinedView.chown("a.txt", 1, 1)
            yield* confinedView.makeDirectory("sub")
            yield* confinedView.remove("a.txt")
            yield* confinedView.rename("a.txt", "b.txt")
            yield* confinedView.readLink("a.txt")
            yield* confinedView.realPath("a.txt")
            yield* confinedView.glob("*.txt")
            yield* confinedView.glob("*.txt", { root: "src", exclude: ["x"] })
            // Refused non-atomic operations in confined view
            const refused = [
              yield* Effect.result(confinedView.access("a.txt")),
              yield* Effect.result(confinedView.copy("a.txt", "b.txt")),
              yield* Effect.result(confinedView.copyFile("a.txt", "b.txt")),
              yield* Effect.result(confinedView.link("a.txt", "b.txt")),
              yield* Effect.result(confinedView.makeTempDirectory()),
              yield* Effect.result(confinedView.makeTempDirectoryScoped()),
              yield* Effect.result(confinedView.makeTempFile()),
              yield* Effect.result(confinedView.makeTempFileScoped()),
              yield* Effect.result(confinedView.open("a.txt")),
              yield* Effect.result(confinedView.symlink("a.txt", "b.txt")),
              yield* Effect.result(confinedView.truncate("a.txt")),
              yield* Effect.result(confinedView.utimes("a.txt", 0, 0)),
              yield* Effect.result(Stream.runDrain(confinedView.watch("a.txt")))
            ]
            if (!refused.every((r) => r._tag === "Failure")) return false
          } else {
            const confErr = yield* Effect.flip(
              FileSystem.confined(atomicHost, root).pipe(Effect.provide(windows ? NodePath.layerWin32 : EffectPath.layer))
            )
            if (confErr.reason._tag !== "PermissionDenied") return false
          }

          const secretsDeny = new Permission.Rule({
            effect: "deny",
            pattern: new Capability.CapabilityPattern({ action: "fs:read", resource: `${joinP(root, "secrets")}${sep}**` })
          })
          const baseStore = yield* GrantStore.make({
            attended: false,
            rules: [
              new Permission.Rule({ effect: "allow", pattern: new Capability.CapabilityPattern({ action: "*", resource: "**" }) }),
              secretsDeny
            ]
          }).pipe(Effect.provide(Workspace.layer(root)))

          const trackingStore = GrantStore.GrantStore.of({
            ...baseStore,
            check: (cap, meta) =>
              Effect.suspend(() => {
                if (batchFault === "allDenied") {
                  return Effect.fail(Permission.permissionDenied(cap, "all denied"))
                }
                if (resolveCase === "toctouSwap") swapped = true
                return baseStore.check(cap, meta)
              })
          })

          return yield* Effect.gen(function*() {
            const fs = yield* EffectFileSystem.FileSystem
            const over = yield* Effect.flip(fs.writeFile("a.txt", new Uint8Array(10)))
            if (over.reason._tag !== "BadArgument") return false
            // Small writeFile through non-isolated atomic executor
            swapped = false
            yield* Effect.result(fs.writeFile("src/a.txt", new Uint8Array([1, 2])))
            yield* Effect.result(fs.lstat("src/a.txt"))

            swapped = false
            const readRes = yield* Effect.result(fs.readFile("src/a.txt"))
            const shouldFailRead = batchFault === "allDenied" ||
              (noFollow && ["symlinkEscape", "symlinkLoop", "outsideBoundary", "resolveErr", "toctouSwap"].includes(resolveCase)) ||
              (!noFollow && (hardLinked || resolveCase === "symlinkLoop" || resolveCase === "toctouSwap"))
            if (shouldFailRead && Result.isSuccess(readRes)) return false
            if (!shouldFailRead && Result.isFailure(readRes)) return false

            swapped = false
            const globRes = yield* Effect.result(fs.glob(globPattern))
            yield* Effect.result(fs.glob("*.txt", { root: "src" }))
            if (globPattern.startsWith("secrets/") && Result.isSuccess(globRes)) return false

            const batcher = FileSystem.batch(fs)
            if (batcher === undefined) return false
            swapped = false
            if (batchFault === "empty") {
              const e = yield* Effect.flip(batcher.execute([]))
              return e.reason._tag === "BadArgument"
            }
            if (batchFault === "tooLarge") {
              const e = yield* Effect.flip(
                batcher.execute(Array.from({ length: 5 }, () => ({ operation: "stat" as const, path: "a.txt" })))
              )
              return e.reason._tag === "BadArgument"
            }
            if (batchFault === "missingIdentity") {
              const e = yield* Effect.flip(batcher.execute([{ operation: "stat", path: "a.txt" }]))
              return e.reason._tag === "PermissionDenied"
            }
            if (batchFault === "rootChanged") {
              rootId = "7:999"
              const e = yield* Effect.flip(batcher.execute([{ operation: "stat", path: "a.txt" }]))
              return e.reason._tag === "Busy"
            }
            const outsidePath = windows ? "D:\\outside\\x.txt" : "/outside/x.txt"
            const batchOut = yield* batcher.execute([
              { operation: "stat", path: "src/a.txt" },
              { operation: "glob", path: globPattern, root },
              { operation: "stat", path: "missing/missing-link" },
              { operation: "stat", path: outsidePath }
            ])
            return batchOut.entries.length === 4
          }).pipe(
            Effect.provide(FileSystem.layer),
            Effect.provideService(EffectFileSystem.FileSystem, atomicHost),
            Effect.provide(windows ? NodePath.layerWin32 : EffectPath.layer),
            Effect.provide(Workspace.layer(root)),
            Effect.provideService(GrantStore.GrantStore, trackingStore)
          )
        }).pipe(Effect.scoped),
      { seed: seed + 22, executions: 65 }
    )
  })

  it("HostServices.layer composes all five closed host slots in place", async () => {
    const arb = Arbitrary.schema(Schema.Struct({ allowed: Schema.Boolean }))
    await runFuzz(
      arb,
      ({ allowed }) =>
        Effect.gen(function*() {
          const fs = FileSystem.withIsolatedFileSystem(
            EffectFileSystem.makeNoop({
              realPath: (p) => Effect.succeed(p),
              stat: () => Effect.succeed({ type: "File", dev: 1n, ino: Option.some(1n), nlink: Option.some(1n) } as unknown as EffectFileSystem.File.Info),
              exists: () => Effect.succeed(true)
            })
          )
          const rawHttp = EffectHttpClient.make((request) =>
            Effect.succeed({ status: 200, headers: {}, request } as unknown as HttpClientResponse.HttpClientResponse)
          )
          const rawSpawner = makeSpawner(() => Effect.succeed(makeFakeHandle(1)))
          const rawJj = HostJj.makeNoop({ status: () => Effect.succeed("clean") })
          const grantLayer = allowed ? TestGrantStore.layerAllow : TestGrantStore.layerDeny("blocked")

          return yield* Effect.gen(function*() {
            const p = yield* EffectPath.Path
            const gfs = yield* EffectFileSystem.FileSystem
            const gsp = yield* HostChildProcessSpawner
            const gjj = yield* HostJj.Jj
            const ghttp = yield* EffectHttpClient.HttpClient
            if (p.resolve("a.txt") !== "/workspace/a.txt") return false
            const r1 = yield* Effect.result(gfs.exists("a.txt"))
            const r2 = yield* Effect.result(gsp.spawn(ChildProcess.make("echo")))
            const r3 = yield* Effect.result(gjj.status())
            const r4 = yield* Effect.result(ghttp.get("https://example.test"))
            if (allowed) return [r1, r2, r3, r4].every((r) => r._tag === "Success")
            return [r1, r2, r3, r4].every((r) => r._tag === "Failure")
          }).pipe(
            Effect.provide(HostServices.layer),
            Effect.provideService(EffectFileSystem.FileSystem, fs),
            Effect.provideService(EffectHttpClient.HttpClient, rawHttp),
            Effect.provideService(HostChildProcessSpawner, rawSpawner),
            Effect.provideService(HostJj.Jj, rawJj),
            Effect.provide(ProcessConfinement.layerNoop),
            Effect.provide(EffectPath.layer),
            Effect.provide(Workspace.layer("/workspace")),
            Effect.provide(grantLayer),
            Effect.scoped
          )
        }),
      { seed: seed + 23, executions: 20 }
    )
  })
})
