import { NodeChildProcessSpawner, NodeFileSystem } from "@effect/platform-node"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, Layer, Logger, Path, PlatformError, Schema, Sink, Stream } from "effect"
import * as ChildProcess from "effect/process/ChildProcess"
import {
  ChildProcessSpawner,
  ExitCode,
  make as makeSpawner,
  makeHandle,
  ProcessId
} from "effect/process/ChildProcessSpawner"
import * as Redacted from "effect/Redacted"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as ContainerSandbox from "../src/ContainerSandbox/index.ts"
import * as DaytonaSandbox from "../src/DaytonaSandbox/index.ts"
import type { Sdk as DaytonaSdk } from "../src/DaytonaSandbox/Sdk.ts"
import { Sandbox } from "../src/index.ts"
import { machineName } from "../src/internal/machineName.ts"
import * as KubernetesSandbox from "../src/KubernetesSandbox/index.ts"
import * as VercelSandbox from "../src/VercelSandbox/index.ts"
import type { Sdk as VercelSdk } from "../src/VercelSandbox/Sdk.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "60"))
const ioExecutions = Math.max(8, Math.min(baseExecutions, 16))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")
const silentLogger = Logger.layer([])

const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-cloud-sb-fuzz-")))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const platformLayer = Layer.provideMerge(
  NodeChildProcessSpawner.layer,
  Layer.merge(NodeFileSystem.layer, Path.layer)
)
const localSpawner = Effect.runSync(
  Effect.gen(function*() {
    return yield* ChildProcessSpawner
  }).pipe(Effect.provide(platformLayer))
)

let seq = 0
const freshDir = (prefix: string) => {
  const dir = join(root, `${prefix}-${++seq}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const plainWord = (word: unknown): string =>
  typeof word === "string"
    ? word
    : Redacted.isRedacted(word)
    ? String(Redacted.value(word))
    : String(word)

const runLocalSh = (command: string, cwd: string, env?: Readonly<Record<string, string>>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function*() {
        const child = yield* localSpawner.spawn(
          ChildProcess.make("sh", ["-c", command], { cwd, env: { ...env }, extendEnv: true })
        )
        const [stdout, stderr, exitCode] = yield* Effect.all([
          Stream.mkString(Stream.decodeText(child.stdout)),
          Stream.mkString(Stream.decodeText(child.stderr)),
          child.exitCode
        ], { concurrency: "unbounded" })
        return { stdout, stderr, exitCode }
      })
    )
  )

const runLocalExec = (
  file: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env?: Readonly<Record<string, string>>
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function*() {
        const child = yield* localSpawner.spawn(
          ChildProcess.make(file, [...args], { cwd, env: { ...env }, extendEnv: true })
        )
        const [stdout, stderr, exitCode] = yield* Effect.all([
          Stream.mkString(Stream.decodeText(child.stdout)),
          Stream.mkString(Stream.decodeText(child.stderr)),
          child.exitCode
        ], { concurrency: "unbounded" })
        return { stdout, stderr, exitCode }
      })
    )
  )

describe("@smthrs/sandbox VercelSandbox, DaytonaSandbox, ContainerSandbox & KubernetesSandbox fuzz", () => {
  it("VercelSandbox.make exercises create, resume, network policies, resource limits, stdin staging, files, extendTimeout & faults", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        network: Schema.Literals(["none", "open", "allow"]),
        withLimits: Schema.Boolean,
        resumeExisting: Schema.Boolean,
        textReads: Schema.Boolean,
        withStdin: Schema.Boolean,
        fault: Schema.Literals(["none", "acquire", "update", "run", "read", "write", "stop", "vcpu-mismatch"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (tc) =>
          Effect.scoped(
            Effect.gen(function*() {
              const home = freshDir("vercel")
              const machines = new Map<string, { name: string; vcpus: number; expiresAt: number }>()
              const resolvePath = (p: string) => (isAbsolute(p) ? p : join(home, p))

              const sdk: VercelSdk = {
                Sandbox: {
                  getOrCreate: async (input) => {
                    if (tc.fault === "acquire") throw new Error("vercel acquire failed")
                    let m = machines.get(input.name)
                    if (m === undefined) {
                      m = {
                        name: input.name,
                        vcpus: tc.fault === "vcpu-mismatch" ? 8 : (input.resources?.vcpus ?? 2),
                        expiresAt: Date.now() + (input.timeout ?? 60_000)
                      }
                      machines.set(input.name, m)
                    }
                    return {
                      name: m.name,
                      vcpus: m.vcpus,
                      expiresAt: new Date(m.expiresAt),
                      runCommand: async (params) => {
                        if (tc.fault === "run") throw new Error("runCommand failed")
                        const cwd = params.cwd ? resolvePath(params.cwd) : home
                        mkdirSync(cwd, { recursive: true })
                        const res = await runLocalExec(params.cmd, params.args ?? [], cwd, params.env)
                        return {
                          exitCode: res.exitCode,
                          stdout: async () => res.stdout,
                          stderr: async () => res.stderr
                        }
                      },
                      readFile: async ({ path }) => {
                        if (tc.fault === "read") throw new Error("readFile failed")
                        const full = resolvePath(path)
                        if (!existsSync(full)) return null
                        const bytes = readFileSync(full)
                        return (async function*() {
                          yield tc.textReads ? decoder.decode(bytes) : new Uint8Array(bytes)
                        })()
                      },
                      writeFiles: async (files) => {
                        if (tc.fault === "write") throw new Error("writeFiles failed")
                        for (const f of files) {
                          const full = resolvePath(f.path)
                          mkdirSync(dirname(full), { recursive: true })
                          writeFileSync(full, f.content)
                        }
                      },
                      extendTimeout: async (ms) => {
                        m!.expiresAt = Date.now() + ms
                      },
                      update: async () => {
                        if (tc.fault === "update") throw new Error("update failed")
                      },
                      stop: async () => {
                        if (tc.fault === "stop") throw new Error("stop failed")
                      }
                    }
                  }
                }
              }

              const network = tc.network === "none"
                ? ("none" as const)
                : tc.network === "open"
                ? ("open" as const)
                : { allow: ["api.example.test"] }

              const provider = VercelSandbox.make({
                sdk,
                token: "v-tok",
                teamId: "v-team",
                projectId: "v-proj",
                workdir: home,
                network,
                ...(tc.withLimits ? { limits: { cpus: 2, memoryMib: 4096, timeoutSecs: 120 } } : { timeoutMs: 60_000 })
              })

              const sessionKey = `vc-${seq}`
              if (tc.resumeExisting) {
                const mname = machineName("smthrs-", sessionKey)
                machines.set(mname, {
                  name: mname,
                  vcpus: tc.fault === "vcpu-mismatch" ? 8 : 2,
                  expiresAt: Date.now() + 30_000
                })
              }

              const acqExit = yield* provider.acquire(sessionKey).pipe(Effect.exit)
              if (
                tc.fault === "acquire" || tc.fault === "update" || tc.fault === "run" ||
                (tc.fault === "vcpu-mismatch" && tc.withLimits)
              ) {
                expect(Exit.isFailure(acqExit)).toBe(true)
                return true
              }
              expect(Exit.isSuccess(acqExit)).toBe(true)
              if (Exit.isFailure(acqExit)) return false
              const session = acqExit.value

              // Write & read file
              const filePath = `${home}/vc.txt`
              const writeExit = yield* session.writeFile(filePath, encoder.encode("vercel-ok")).pipe(Effect.exit)
              if (tc.fault === "write") {
                expect(Exit.isFailure(writeExit)).toBe(true)
              } else {
                expect(Exit.isSuccess(writeExit)).toBe(true)
                const readExit = yield* session.readFile(filePath).pipe(Effect.exit)
                if (tc.fault === "read") {
                  expect(Exit.isFailure(readExit)).toBe(true)
                } else {
                  expect(Exit.isSuccess(readExit)).toBe(true)
                  if (Exit.isSuccess(readExit)) expect(decoder.decode(readExit.value)).toBe("vercel-ok")
                }
                const missingExit = yield* session.readFile(`${home}/absent.txt`).pipe(Effect.exit)
                expect(Exit.isFailure(missingExit)).toBe(true)
              }

              // Spawn command with/without stdin
              const cmd = tc.withStdin ? "cat" : "echo vc-run"
              const spawnExit = yield* session.spawn(cmd, {
                ...(tc.withStdin ? { stdin: encoder.encode("from-stdin") } : {}),
                env: { FOO: "bar" }
              }).pipe(Effect.exit)
              if (tc.fault === "write" && tc.withStdin) {
                expect(Exit.isFailure(spawnExit)).toBe(true)
              } else if (Exit.isSuccess(spawnExit)) {
                const out = yield* Stream.mkString(Stream.decodeText(spawnExit.value.stdout))
                const code = yield* spawnExit.value.exitCode
                expect(code).toBe(0)
                expect(out).toContain(tc.withStdin ? "from-stdin" : "vc-run")
              }
              return true
            })
          ).pipe(Effect.provide(silentLogger)),
        { seed, executions: ioExecutions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
  })

  it("DaytonaSandbox.make exercises create, get, start, network settings, ttl, stdin staging, files, delete & faults", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        network: Schema.Literals(["none", "open", "allow"]),
        preexisting: Schema.Boolean,
        withLimits: Schema.Boolean,
        withStdin: Schema.Boolean,
        fault: Schema.Literals(["none", "get", "create", "network", "execute", "upload", "download", "delete"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (tc) =>
          Effect.scoped(
            Effect.gen(function*() {
              const work = freshDir("daytona")
              const machines = new Map<string, { id: string; name: string; dir: string }>()

              const mkInstance = (m: { id: string; name: string; dir: string }) => ({
                id: m.id,
                name: m.name,
                createdAt: new Date().toISOString(),
                autoDestroyAt: new Date(Date.now() + 600_000).toISOString(),
                getWorkDir: async () => m.dir,
                updateNetworkSettings: async () => {
                  if (tc.fault === "network") throw new Error("network update failed")
                },
                setTtl: async () => {},
                fs: {
                  downloadFile: async (remotePath: string) => {
                    if (tc.fault === "download") throw new Error("download failed")
                    if (!existsSync(remotePath)) {
                      throw Object.assign(new Error("not found"), { statusCode: 404 })
                    }
                    return new Uint8Array(readFileSync(remotePath))
                  },
                  uploadFileStream: async (source: Uint8Array, remotePath: string) => {
                    if (tc.fault === "upload") throw new Error("upload failed")
                    mkdirSync(dirname(remotePath), { recursive: true })
                    writeFileSync(remotePath, source)
                  }
                },
                process: {
                  executeCommand: async (command: string, cwd?: string, env?: Record<string, string>) => {
                    if (tc.fault === "execute") throw new Error("exec failed")
                    const dir = cwd ?? m.dir
                    mkdirSync(dir, { recursive: true })
                    const res = await runLocalSh(command, dir, env)
                    return { exitCode: res.exitCode, result: res.stdout + res.stderr }
                  }
                }
              })

              const sdk: DaytonaSdk = {
                get: async (nameOrId) => {
                  if (tc.fault === "get") throw new Error("get failed")
                  const found = machines.get(nameOrId)
                  if (found === undefined) {
                    throw Object.assign(new Error("sandbox not found"), { statusCode: 404 })
                  }
                  return mkInstance(found)
                },
                create: async (params) => {
                  if (tc.fault === "create") throw new Error("create failed")
                  const name = params?.name ?? `dt-${++seq}`
                  const m = { id: `id-${++seq}`, name, dir: work }
                  machines.set(name, m)
                  machines.set(m.id, m)
                  return mkInstance(m)
                },
                start: async () => {},
                delete: async () => {
                  if (tc.fault === "delete") throw new Error("delete failed")
                }
              }

              const network = tc.network === "none"
                ? ("none" as const)
                : tc.network === "open"
                ? ("open" as const)
                : { allow: ["registry.npmjs.org"] }

              const provider = DaytonaSandbox.make({
                sdk,
                network,
                workdir: work,
                ...(tc.withLimits ? { limits: { timeoutSecs: 120 } } : {})
              })

              const sessionKey = `dt-${seq}`
              if (tc.preexisting) {
                const name = machineName("smthrs-", sessionKey)
                const m = { id: `pre-${seq}`, name, dir: work }
                machines.set(name, m)
              }

              const acqExit = yield* provider.acquire(sessionKey).pipe(Effect.exit)
              if (
                tc.fault === "get" || (tc.fault === "create" && !tc.preexisting) ||
                (tc.fault === "network" && tc.preexisting)
              ) {
                expect(Exit.isFailure(acqExit)).toBe(true)
                return true
              }
              expect(Exit.isSuccess(acqExit)).toBe(true)
              if (Exit.isFailure(acqExit)) return false
              const session = acqExit.value

              const filePath = `${work}/dt.txt`
              const wExit = yield* session.writeFile(filePath, encoder.encode("daytona-ok")).pipe(Effect.exit)
              if (tc.fault === "upload") {
                expect(Exit.isFailure(wExit)).toBe(true)
              } else {
                expect(Exit.isSuccess(wExit)).toBe(true)
                const rExit = yield* session.readFile(filePath).pipe(Effect.exit)
                if (tc.fault === "download") {
                  expect(Exit.isFailure(rExit)).toBe(true)
                } else if (Exit.isSuccess(rExit)) {
                  expect(decoder.decode(rExit.value)).toBe("daytona-ok")
                }
                expect(Exit.isFailure(yield* session.readFile(`${work}/no-file.txt`).pipe(Effect.exit))).toBe(true)
              }

              const cmd = tc.withStdin ? "cat" : "echo dt-run"
              const spExit = yield* session.spawn(cmd, {
                ...(tc.withStdin ? { stdin: encoder.encode("dt-stdin") } : {}),
                env: { BAR: "baz" }
              }).pipe(Effect.exit)
              if (tc.fault === "execute" || (tc.fault === "upload" && tc.withStdin)) {
                expect(Exit.isFailure(spExit)).toBe(true)
              } else if (Exit.isSuccess(spExit)) {
                const out = yield* Stream.mkString(Stream.decodeText(spExit.value.stdout))
                const code = yield* spExit.value.exitCode
                expect(code).toBe(0)
                expect(out).toContain(tc.withStdin ? "dt-stdin" : "dt-run")
              }
              return true
            })
          ).pipe(Effect.provide(silentLogger)),
        { seed: seed + 1, executions: ioExecutions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
  })

  it("ContainerSandbox.existing & ContainerSandbox.make exercise container lifecycle, linuxFileSystem, exec, stdin, limits & faults", async () => {
    // 1. ContainerSandbox.existing over real local /bin/sh -> exercises existing.ts + linuxFileSystem.ts!
    const existDir = freshDir("container-existing")
    const existSession = ContainerSandbox.existing({
      container: "c-fuzz-1",
      workdir: existDir,
      spawner: localSpawner,
      hostEnvironment: process.env,
      transport: {
        exec: ({ file, args, cwd }) =>
          Effect.succeed({
            file: "/bin/sh",
            args: ["-c", "cd \"$1\" && shift && exec \"$@\"", "_", cwd ?? existDir, file, ...args]
          })
      }
    })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const fs = Sandbox.fileSystem(existSession)
          yield* fs.makeDirectory("nested", { recursive: true })
          yield* fs.writeFileString("nested/f.txt", "container-linux-fs")
          expect(yield* fs.readFileString("nested/f.txt")).toBe("container-linux-fs")
          const st = yield* fs.stat("nested/f.txt")
          expect(st.type).toBe("File")
          yield* fs.chmod("nested/f.txt", 0o600)
          const symExit = yield* fs.symlink("f.txt", "nested/sym.txt").pipe(Effect.exit)
          if (Exit.isSuccess(symExit)) expect(yield* fs.readLink("nested/sym.txt")).toBe("f.txt")
          expect(yield* fs.readDirectory("nested")).toContain("f.txt")
          yield* fs.rename("nested/f.txt", "nested/f2.txt")
          // Read directory as file -> refusal
          expect(Exit.isFailure(yield* fs.readFile("nested").pipe(Effect.exit))).toBe(true)
          // Read missing -> NotFound
          expect(Exit.isFailure(yield* fs.readFile("nested/missing").pipe(Effect.exit))).toBe(true)
          // Unreadable file -> permission refusal
          const roPath = join(existDir, "nested", "unreadable.txt")
          writeFileSync(roPath, "secret")
          chmodSync(roPath, 0o000)
          yield* fs.readFile("nested/unreadable.txt").pipe(Effect.exit)
          chmodSync(roPath, 0o644)
          yield* fs.remove("nested", { recursive: true, force: true })

          const child = yield* existSession.spawn("cat", {
            stdin: encoder.encode("hello-existing"),
            env: { MY_VAR: "123" }
          })
          expect(yield* Stream.mkString(Stream.decodeText(child.stdout))).toBe("hello-existing")
          expect(yield* child.exitCode).toBe(0)
        })
      ).pipe(Effect.provide(silentLogger))
    )

    // 2. ContainerSandbox.make with injected docker-like spawner backed by real /bin/sh
    const arb = Arbitrary.schema(
      Schema.Struct({
        network: Schema.Literals(["none", "open"]),
        withLimits: Schema.Boolean,
        conflictOnCreate: Schema.Boolean,
        failStart: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (tc) =>
          Effect.scoped(
            Effect.gen(function*() {
              const work = freshDir("container-make")
              const pidDir = join(work, ".pids")
              mkdirSync(pidDir, { recursive: true })
              const containers = new Map<string, { inspect: Record<string, unknown> }>()

              const canned = (opts: { stdout?: string; stderr?: string; exitCode?: number }) =>
                makeHandle({
                  pid: ProcessId(1),
                  exitCode: Effect.succeed(ExitCode(opts.exitCode ?? 0)),
                  isRunning: Effect.succeed(false),
                  kill: () => Effect.void,
                  stdin: Sink.drain,
                  stdout: opts.stdout ? Stream.make(encoder.encode(opts.stdout)) : Stream.empty,
                  stderr: opts.stderr ? Stream.make(encoder.encode(opts.stderr)) : Stream.empty,
                  all: Stream.empty,
                  getInputFd: () => Sink.drain,
                  getOutputFd: () => Stream.empty,
                  unref: Effect.succeed(Effect.void)
                })

              const spawner = makeSpawner((command: ChildProcess.Command) =>
                Effect.gen(function*() {
                  if (command._tag !== "StandardCommand") {
                    return yield* Effect.fail(
                      PlatformError.badArgument({ module: "ChildProcess", method: "spawn", description: "bad" })
                    )
                  }
                  const args = command.args.map(plainWord)
                  if (args[0] === "create") {
                    const name = args[args.indexOf("--name") + 1]!
                    if (tc.conflictOnCreate && !containers.has(name)) {
                      containers.set(name, {
                        inspect: {
                          Config: { Image: "alpine:3", WorkingDir: work, Labels: {} },
                          HostConfig: { NetworkMode: tc.network === "none" ? "none" : "bridge", Privileged: false }
                        }
                      })
                      return canned({
                        exitCode: 125,
                        stderr: `Error response from daemon: Conflict. The container name "/${name}" is already in use`
                      })
                    }
                    const labels: Record<string, string> = {}
                    for (let i = 0; i < args.length; i++) {
                      if (args[i] === "--label" && args[i + 1]) {
                        const [k, ...rest] = args[i + 1]!.split("=")
                        labels[k!] = rest.join("=")
                      }
                    }
                    containers.set(name, {
                      inspect: {
                        Config: { Image: args.at(-3), WorkingDir: args[args.indexOf("--workdir") + 1], Labels: labels },
                        HostConfig: { NetworkMode: args[args.indexOf("--network") + 1], Privileged: false }
                      }
                    })
                    return canned({ stdout: "cid123456\n" })
                  }
                  if (args[0] === "start") {
                    if (tc.failStart) return canned({ exitCode: 1, stderr: "cannot start" })
                    return canned({ stdout: "cid123456\n" })
                  }
                  if (args[0] === "container" && args[1] === "inspect") {
                    const name = args[2]!
                    const found = containers.get(name)
                    return found
                      ? canned({ stdout: JSON.stringify([found.inspect]) })
                      : canned({ exitCode: 1, stderr: `No such container: ${name}` })
                  }
                  if (args[0] === "rm") {
                    const name = args.at(-1)!
                    containers.delete(name)
                    return canned({})
                  }
                  if (args[0] === "exec") {
                    const shIdx = args.indexOf("-c")
                    const script = (shIdx >= 0 ? args[shIdx + 1]! : "true").replaceAll("/tmp/.smthrs-sbx", pidDir)
                    return yield* localSpawner.spawn(
                      ChildProcess.make("/bin/sh", ["-c", script], {
                        cwd: work,
                        stdin: command.options.stdin
                      })
                    )
                  }
                  return canned({})
                })
              )

              const provider = ContainerSandbox.make({
                spawner,
                image: "alpine:3",
                workdir: work,
                network: tc.network,
                ...(tc.withLimits ? { limits: { cpus: 1, memoryMib: 512, timeoutSecs: 60 } } : {})
              })

              const acqExit = yield* provider.acquire(`cs-${seq}`).pipe(Effect.exit)
              if (tc.failStart || tc.conflictOnCreate) {
                expect(Exit.isFailure(acqExit)).toBe(true)
                return true
              }
              expect(Exit.isSuccess(acqExit)).toBe(true)
              if (Exit.isFailure(acqExit)) return false
              const session = acqExit.value

              yield* session.writeFile(`${work}/c.txt`, encoder.encode("container-ok"))
              expect(decoder.decode(yield* session.readFile(`${work}/c.txt`))).toBe("container-ok")
              const child = yield* session.spawn("echo container-exec", {})
              expect(yield* Stream.mkString(Stream.decodeText(child.stdout))).toContain("container-exec")
              expect(yield* child.exitCode).toBe(0)
              return true
            })
          ).pipe(Effect.provide(silentLogger)),
        { seed: seed + 2, executions: ioExecutions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
  })

  it("KubernetesSandbox.make exercises kubectl pod creation, wait, exec, files, limits, labels & faults", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        withLimits: Schema.Boolean,
        withNamespace: Schema.Boolean,
        alreadyExists: Schema.Boolean,
        failWait: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (tc) =>
          Effect.scoped(
            Effect.gen(function*() {
              const work = freshDir("k8s")
              const pidDir = join(work, ".pids")
              mkdirSync(pidDir, { recursive: true })
              const pods = new Map<string, Record<string, unknown>>()

              const canned = (opts: { stdout?: string; stderr?: string; exitCode?: number }) =>
                makeHandle({
                  pid: ProcessId(1),
                  exitCode: Effect.succeed(ExitCode(opts.exitCode ?? 0)),
                  isRunning: Effect.succeed(false),
                  kill: () => Effect.void,
                  stdin: Sink.drain,
                  stdout: opts.stdout ? Stream.make(encoder.encode(opts.stdout)) : Stream.empty,
                  stderr: opts.stderr ? Stream.make(encoder.encode(opts.stderr)) : Stream.empty,
                  all: Stream.empty,
                  getInputFd: () => Sink.drain,
                  getOutputFd: () => Stream.empty,
                  unref: Effect.succeed(Effect.void)
                })

              const spawner = makeSpawner((command: ChildProcess.Command) =>
                Effect.gen(function*() {
                  if (command._tag !== "StandardCommand") {
                    return yield* Effect.fail(
                      PlatformError.badArgument({ module: "ChildProcess", method: "spawn", description: "bad" })
                    )
                  }
                  const input = Stream.isStream(command.options.stdin)
                    ? yield* Stream.runFold(
                      command.options.stdin as Stream.Stream<Uint8Array>,
                      () => "",
                      (acc, chunk) => acc + decoder.decode(chunk)
                    )
                    : ""
                  const args = [...command.args.map(plainWord)]
                  while (["--context", "--namespace", "--kubeconfig"].includes(args[0] ?? "")) {
                    args.splice(0, 2)
                  }
                  if (args[0] === "run" && args.includes("--dry-run=client")) {
                    const name = args[1]!
                    const labels = Object.fromEntries(
                      (args[args.indexOf("--labels") + 1] ?? "").split(",").filter(Boolean).map((l) => l.split("="))
                    )
                    return canned({
                      stdout: JSON.stringify({
                        apiVersion: "v1",
                        kind: "Pod",
                        metadata: { name, labels },
                        spec: { containers: [{ name, image: args[args.indexOf("--image") + 1] }] }
                      })
                    })
                  }
                  if (args[0] === "run" || args[0] === "create") {
                    const manifest = args[0] === "create" ? JSON.parse(input) : undefined
                    const name = manifest?.metadata?.name ?? args[1]!
                    if (tc.alreadyExists && !pods.has(name)) {
                      pods.set(name, {
                        metadata: { name, uid: "uid-old", labels: {} },
                        spec: { containers: [{ name, image: "other:1" }] },
                        status: { phase: "Running" }
                      })
                      return canned({
                        exitCode: 1,
                        stderr: `Error from server (AlreadyExists): pods "${name}" already exists`
                      })
                    }
                    pods.set(name, {
                      ...(manifest ??
                        { metadata: { name, labels: {} }, spec: { containers: [{ name, image: "alpine:3" }] } }),
                      status: { phase: "Running" }
                    })
                    return canned({ stdout: `pod/${name} created\n` })
                  }
                  if (args[0] === "wait") {
                    if (tc.failWait) return canned({ exitCode: 1, stderr: "timed out waiting for pod" })
                    return canned({ stdout: "pod condition met\n" })
                  }
                  if (args[0] === "get") {
                    const name = args[2]!
                    const found = pods.get(name)
                    return found
                      ? canned({ stdout: JSON.stringify(found) })
                      : args.includes("--ignore-not-found")
                      ? canned({})
                      : canned({ exitCode: 1, stderr: `Error from server (NotFound): pods "${name}" not found` })
                  }
                  if (args[0] === "delete") {
                    const name = args[2]!
                    pods.delete(name)
                    return canned({ stdout: `pod "${name}" deleted\n` })
                  }
                  if (args[0] === "exec") {
                    const shIdx = args.indexOf("-c")
                    const script = (shIdx >= 0 ? args[shIdx + 1]! : "true").replaceAll("/tmp/.smthrs-sbx", pidDir)
                    return yield* localSpawner.spawn(
                      ChildProcess.make("/bin/sh", ["-c", script], {
                        cwd: work,
                        stdin: input.length > 0 ? Stream.make(encoder.encode(input)) : undefined
                      })
                    )
                  }
                  return canned({})
                })
              )

              const provider = KubernetesSandbox.make({
                spawner,
                image: "alpine:3",
                workdir: work,
                ...(tc.withNamespace ? { namespace: "fuzz-ns", labels: { team: "qa" } } : {}),
                ...(tc.withLimits ? { limits: { cpus: 1, memoryMib: 256, timeoutSecs: 60 } } : {})
              })

              const acqExit = yield* provider.acquire(`k8s-${seq}`).pipe(Effect.exit)
              if (tc.failWait || tc.alreadyExists) {
                expect(Exit.isFailure(acqExit)).toBe(true)
                return true
              }
              expect(Exit.isSuccess(acqExit)).toBe(true)
              if (Exit.isFailure(acqExit)) return false
              const session = acqExit.value

              yield* session.writeFile(`${work}/k.txt`, encoder.encode("k8s-ok"))
              expect(decoder.decode(yield* session.readFile(`${work}/k.txt`))).toBe("k8s-ok")
              const child = yield* session.spawn("echo k8s-exec", {})
              expect(yield* Stream.mkString(Stream.decodeText(child.stdout))).toContain("k8s-exec")
              expect(yield* child.exitCode).toBe(0)
              return true
            })
          ).pipe(Effect.provide(silentLogger)),
        { seed: seed + 3, executions: ioExecutions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
  })
})
