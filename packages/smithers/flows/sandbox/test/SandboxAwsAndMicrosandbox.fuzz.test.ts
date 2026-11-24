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
import { spawn as nodeSpawn } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as AwsSandbox from "../src/AwsSandbox/index.ts"
import * as MicrosandboxSandbox from "../src/MicrosandboxSandbox/index.ts"
import { holderLabel, ownerLabel, providerLabel, providerName } from "../src/MicrosandboxSandbox/labels.ts"
import type { Sdk as MsbSdk } from "../src/MicrosandboxSandbox/Sdk.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "60"))
const ioExecutions = Math.max(8, Math.min(baseExecutions, 14))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")
const silentLogger = Logger.layer([])

const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-aws-msb-fuzz-")))
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

describe("@smthrs/sandbox AwsSandbox & MicrosandboxSandbox (make, process, snapshots, reap) fuzz", () => {
  it("AwsSandbox.make exercises taskDefinition/image registration, describe state transitions, ECS Exec framing, files, stdin & faults", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals(["taskDef", "image-limits"]),
        describePath: Schema.Literals(["ready", "pending-then-ready", "stopped", "no-agents-then-ready"]),
        withStreaming: Schema.Boolean,
        withStdin: Schema.Boolean,
        fault: Schema.Literals(["none", "run-fault", "run-no-task", "describe-fault", "stop-fault", "register-fault"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (tc) =>
          Effect.scoped(
            Effect.gen(function*() {
              const work = freshDir("aws")
              const pidDir = join(work, ".pids")
              mkdirSync(pidDir, { recursive: true })

              let taskNum = 0
              let describeCount = 0
              const tasks = new Map<string, { arn: string; startedBy: string; taskDefinition: string }>()

              const sdk: AwsSandbox.Sdk = {
                registerTaskDefinition: async (input) => {
                  if (tc.fault === "register-fault") throw new Error("register failed")
                  return {
                    taskDefinition: {
                      taskDefinitionArn: `arn:aws:ecs:us-east-1:123:task-definition/${input.family}:${++taskNum}`
                    }
                  }
                },
                deregisterTaskDefinition: async () => ({}),
                runTask: async (input) => {
                  if (tc.fault === "run-fault") throw new Error("runTask failed")
                  if (tc.fault === "run-no-task") return { failures: [{ reason: "CAPACITY" }] }
                  const arn = `arn:aws:ecs:us-east-1:123:task/cl/t-${++taskNum}`
                  tasks.set(arn, { arn, startedBy: input.startedBy, taskDefinition: input.taskDefinition })
                  return { tasks: [{ taskArn: arn, lastStatus: "PROVISIONING" }] }
                },
                describeTasks: async (input) => {
                  if (tc.fault === "describe-fault") throw new Error("describe failed")
                  describeCount += 1
                  const arn = input.tasks[0]!
                  const container = tc.mode === "image-limits" ? "sandbox" : "main"
                  if (tc.describePath === "stopped") {
                    return {
                      tasks: [{
                        taskArn: arn,
                        lastStatus: "STOPPED",
                        desiredStatus: "STOPPED",
                        enableExecuteCommand: true
                      }]
                    }
                  }
                  if (tc.describePath === "pending-then-ready" && describeCount === 1) {
                    return {
                      tasks: [{
                        taskArn: arn,
                        lastStatus: "PENDING",
                        desiredStatus: "RUNNING",
                        enableExecuteCommand: false
                      }]
                    }
                  }
                  if (tc.describePath === "no-agents-then-ready" && describeCount === 1) {
                    return {
                      tasks: [{
                        taskArn: arn,
                        lastStatus: "RUNNING",
                        desiredStatus: "RUNNING",
                        enableExecuteCommand: true,
                        containers: [{ name: container }]
                      }]
                    }
                  }
                  return {
                    tasks: [{
                      taskArn: arn,
                      lastStatus: "RUNNING",
                      desiredStatus: "RUNNING",
                      enableExecuteCommand: true,
                      containers: [{
                        name: container,
                        managedAgents: [{ name: "ExecuteCommandAgent", lastStatus: "RUNNING" }]
                      }]
                    }]
                  }
                },
                listTasks: async () => ({ taskArns: [...tasks.keys()] }),
                listTaskDefinitions: async () => ({ taskDefinitionArns: [] }),
                stopTask: async (input) => {
                  if (tc.fault === "stop-fault") throw new Error("stop failed")
                  tasks.delete(input.task)
                  return {}
                }
              }

              // Fake AWS CLI + session-manager-plugin spawner wrapping real /bin/sh with SSM banner & footer
              const makeSsmSpawner = () =>
                makeSpawner((command: ChildProcess.Command) =>
                  Effect.gen(function*() {
                    if (command._tag !== "StandardCommand") {
                      return yield* Effect.fail(
                        PlatformError.badArgument({ module: "ChildProcess", method: "spawn", description: "bad" })
                      )
                    }
                    const args = command.args.map(plainWord)
                    const cmdIdx = args.indexOf("--command")
                    const rawCmd = cmdIdx >= 0 ? args[cmdIdx + 1]! : "true"
                    const remapped = rawCmd.replaceAll("/tmp/.smthrs-sbx", pidDir)
                    const child = yield* localSpawner.spawn(
                      ChildProcess.make("/bin/sh", ["-c", remapped], {
                        cwd: work,
                        stdin: command.options.stdin
                      })
                    )
                    const [out, err] = yield* Effect.all([
                      Stream.mkString(Stream.decodeText(child.stdout)),
                      Stream.mkString(Stream.decodeText(child.stderr)),
                      child.exitCode
                    ], { concurrency: "unbounded" })
                    const framed =
                      `\nThe Session Manager plugin was installed successfully. Use the AWS CLI to start a session.\n\n` +
                      `Starting session with SessionId: ecs-execute-command-fuzz\n` +
                      `${(out + err).replaceAll("\n", "\r\n")}` +
                      `\nExiting session with sessionId: ecs-execute-command-fuzz.\n`
                    return makeHandle({
                      pid: ProcessId(10),
                      exitCode: Effect.succeed(ExitCode(0)),
                      isRunning: Effect.succeed(false),
                      kill: () => Effect.void,
                      stdin: Sink.drain,
                      stdout: Stream.make(encoder.encode(framed)),
                      stderr: Stream.empty,
                      all: Stream.empty,
                      getInputFd: () => Sink.drain,
                      getOutputFd: () => Stream.empty,
                      unref: Effect.succeed(Effect.void)
                    })
                  })
                )

              const ssmSpawner = makeSsmSpawner()
              const common = {
                sdk,
                region: "us-east-1",
                cluster: "fuzz-cluster",
                subnets: ["subnet-1"],
                workdir: work,
                pollInterval: "1 millis" as const,
                exec: {
                  spawner: ssmSpawner,
                  ...(tc.withStreaming ? { streamingSpawner: ssmSpawner, chunkBytes: 256 } : {})
                }
              }

              const provider = tc.mode === "taskDef"
                ? AwsSandbox.make({ ...common, taskDefinition: "fuzz-td:1", container: "main" })
                : AwsSandbox.make({
                  ...common,
                  image: "alpine:3",
                  taskRoleArn: "arn:aws:iam::123:role/task",
                  executionRoleArn: "arn:aws:iam::123:role/exec",
                  limits: { cpus: 1, memoryMib: 2048, timeoutSecs: 120 }
                })

              const acqExit = yield* provider.acquire(`aws-${seq}`).pipe(Effect.exit)
              const expectAcqFail = tc.fault === "run-fault" ||
                tc.fault === "run-no-task" ||
                tc.fault === "describe-fault" ||
                (tc.fault === "register-fault" && tc.mode === "image-limits") ||
                tc.describePath === "stopped"
              if (expectAcqFail) {
                expect(Exit.isFailure(acqExit)).toBe(true)
                return true
              }
              expect(Exit.isSuccess(acqExit)).toBe(true)
              if (Exit.isFailure(acqExit)) return false
              const session = acqExit.value

              // Write & read file
              const filePath = `${work}/aws.txt`
              const writeExit = yield* session.writeFile(filePath, encoder.encode("aws-payload-data")).pipe(Effect.exit)
              if (!tc.withStreaming) {
                expect(Exit.isFailure(writeExit)).toBe(true)
              } else {
                expect(Exit.isSuccess(writeExit)).toBe(true)
                const readBytes = yield* session.readFile(filePath)
                expect(decoder.decode(readBytes)).toBe("aws-payload-data")
              }

              // Spawn command
              const cmd = tc.withStdin ? "cat" : "echo aws-exec-ok"
              const spExit = yield* session.spawn(cmd, {
                ...(tc.withStdin ? { stdin: encoder.encode("aws-stdin-text") } : {})
              }).pipe(Effect.exit)
              if (tc.withStdin && !tc.withStreaming) {
                expect(Exit.isFailure(spExit)).toBe(true)
              } else if (Exit.isSuccess(spExit)) {
                const out = yield* Stream.mkString(Stream.decodeText(spExit.value.stdout))
                const code = yield* spExit.value.exitCode
                expect(code).toBe(0)
                expect(out).toContain(tc.withStdin ? "aws-stdin-text" : "aws-exec-ok")
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

  it("MicrosandboxSandbox.make, microsandboxProcess, snapshots & reap exercise full microVM lifecycle, snapshots & GC", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        network: Schema.Literals(["none", "open", "allow"]),
        persistence: Schema.Literals(["ephemeral", "sticky"]),
        backend: Schema.Literals(["local", "cloud"]),
        withLimits: Schema.Boolean,
        withStdin: Schema.Boolean,
        loseStream: Schema.Boolean,
        nonZeroExit: Schema.Boolean
      })
    )

    const makeFakeMsb = (baseDir: string, defaultBackend: "local" | "cloud", loseOnEcho: boolean) => {
      type ExecEvent = NonNullable<
        Awaited<
          ReturnType<
            Awaited<
              ReturnType<Awaited<ReturnType<ReturnType<MsbSdk["Sandbox"]["builder"]>["create"]>>["execStreamWith"]>
            >["recv"]
          >
        >
      >
      interface MachineState {
        name: string
        dir: string
        labels: Record<string, string>
        status: string
        backendKind: "local" | "cloud"
      }
      const machines = new Map<string, MachineState>()
      const snapshots = new Map<string, { name: string; createdAt: Date }>()

      const resolveIn = (m: MachineState, p: string) => {
        if (p.startsWith(m.dir)) return p
        return isAbsolute(p) ? join(m.dir, p.slice(1)) : join(m.dir, p)
      }

      const makeSandboxObj = (m: MachineState) => ({
        name: m.name,
        backendKind: m.backendKind,
        fs: () => ({
          read: async (path: string) => {
            const full = resolveIn(m, path)
            if (!existsSync(full)) {
              throw Object.assign(new Error("sandbox fs error: open: No such file or directory (os error 2)"), {
                code: "sandboxFsOps"
              })
            }
            return new Uint8Array(readFileSync(full))
          },
          write: async (path: string, data: Uint8Array | string) => {
            const full = resolveIn(m, path)
            mkdirSync(dirname(full), { recursive: true })
            writeFileSync(full, data)
          },
          mkdir: async (path: string) => {
            mkdirSync(resolveIn(m, path), { recursive: true })
          },
          remove: async (path: string) => {
            rmSync(resolveIn(m, path), { recursive: true, force: true })
          },
          list: async (path: string) => {
            const full = resolveIn(m, path)
            return readdirSync(full).map((entry) => {
              const st = statSync(join(full, entry))
              return { path: entry, kind: st.isDirectory() ? "dir" : "file", size: st.size }
            })
          },
          stat: async (path: string) => {
            const full = resolveIn(m, path)
            const st = statSync(full)
            return { kind: st.isDirectory() ? "dir" : "file", size: st.size, mode: st.mode }
          },
          exists: async (path: string) => existsSync(resolveIn(m, path))
        }),
        execStreamWith: async (command: string, configure: (b: any) => any) => {
          let cmdArgs: Array<string> = []
          let cmdCwd = m.dir
          let cmdEnv: Record<string, string> = {}
          let cmdStdin: Uint8Array | undefined
          const builder = {
            args(a: Array<string>) {
              cmdArgs = a
              return this
            },
            cwd(c: string) {
              cmdCwd = resolveIn(m, c)
              return this
            },
            envs(v: Record<string, string>) {
              cmdEnv = { ...cmdEnv, ...v }
              return this
            },
            stdinBytes(d: Uint8Array) {
              cmdStdin = d
              return this
            }
          }
          configure(builder)
          mkdirSync(cmdCwd, { recursive: true })

          const events: Array<ExecEvent | null> = []
          const waiters: Array<(v: ExecEvent | null) => void> = []
          let closed = false
          const push = (ev: ExecEvent | null) => {
            if (closed) return
            if (ev === null) closed = true
            const w = waiters.shift()
            if (w) w(ev)
            else events.push(ev)
          }

          const child = nodeSpawn(command, cmdArgs, {
            cwd: cmdCwd,
            env: { ...process.env, ...cmdEnv },
            stdio: ["pipe", "pipe", "pipe"]
          })
          push({ kind: "started", pid: child.pid ?? 1 })
          const joined = [command, ...cmdArgs].join(" ")
          if (loseOnEcho && joined.includes("LOSE_ME")) {
            child.kill("SIGKILL")
            push(null)
          } else {
            child.stdin.on("error", () => {})
            if (cmdStdin !== undefined) child.stdin.end(cmdStdin)
            else child.stdin.end()
            child.stdout.on("data", (chunk: Buffer) => {
              push({ kind: "stdout", data: new Uint8Array(chunk) })
            })
            child.stderr.on("data", (chunk: Buffer) => {
              push({ kind: "stderr", data: new Uint8Array(chunk) })
            })
            child.on("close", (code) => {
              push({ kind: "exited", code: code ?? 1 })
              push(null)
            })
          }

          return {
            recv: async () => {
              if (events.length > 0) return events.shift()!
              if (closed) return null
              return await new Promise<ExecEvent | null>((resolve) => {
                waiters.push(resolve)
              })
            },
            signal: async (sig: number) => {
              try {
                child.kill(sig)
              } catch {}
            },
            kill: async () => {
              try {
                child.kill("SIGKILL")
              } catch {}
            }
          }
        },
        destroy: async () => {
          m.status = "stopped"
          machines.delete(m.name)
        }
      })

      const makeHandleObj = (m: MachineState): any => ({
        name: m.name,
        get status() {
          return m.status
        },
        get configJson() {
          return JSON.stringify({ labels: m.labels })
        },
        stop: async () => {
          m.status = "stopped"
        },
        snapshot: async (snapName: string) => {
          snapshots.set(snapName, { name: snapName, createdAt: new Date() })
        },
        connect: async () => makeSandboxObj(m),
        start: async () => {
          m.status = "running"
          return makeSandboxObj(m)
        },
        startDetached: async () => {
          m.status = "running"
          return makeSandboxObj(m)
        },
        refresh: async () => makeHandleObj(m),
        modify: async ({ labels }: { labels: Record<string, string> }) => {
          m.labels = { ...m.labels, ...labels }
          return { applied: true }
        },
        destroy: async () => {
          m.status = "stopped"
          machines.delete(m.name)
        }
      })

      const sdk: MsbSdk = {
        defaultBackendKind: () => defaultBackend,
        setDefaultBackend: () => {},
        Sandbox: {
          builder: (name: string) => {
            let labels: Record<string, string> = {}
            const b: any = {
              image() {
                return b
              },
              fromSnapshot() {
                return b
              },
              rootDisk() {
                return b
              },
              network(fn: (nb: any) => any) {
                fn({
                  policy() {
                    return this
                  }
                })
                return b
              },
              cpus() {
                return b
              },
              maxCpus() {
                return b
              },
              memory() {
                return b
              },
              maxMemory() {
                return b
              },
              security() {
                return b
              },
              pullPolicy() {
                return b
              },
              labels(l: Record<string, string>) {
                labels = { ...labels, ...l }
                return b
              },
              maxDuration() {
                return b
              },
              idleTimeout() {
                return b
              },
              ephemeral() {
                return b
              },
              detached() {
                return b
              },
              disableNetwork() {
                return b
              },
              create: async () => {
                const dir = join(baseDir, name)
                mkdirSync(dir, { recursive: true })
                const m: MachineState = { name, dir, labels, status: "running", backendKind: defaultBackend }
                machines.set(name, m)
                return makeSandboxObj(m)
              }
            }
            return b
          },
          get: async (name: string) => {
            const found = machines.get(name)
            if (!found) throw Object.assign(new Error(`SandboxNotFound: ${name}`), { code: "SandboxNotFound" })
            return makeHandleObj(found)
          },
          listWith: async (configure) => {
            const filterLabels: Record<string, string> = {}
            const lb: any = {
              label(k: string, v: string) {
                filterLabels[k] = v
                return lb
              },
              cursor() {
                return lb
              }
            }
            configure(lb)
            const matched = [...machines.values()]
              .filter((m) => Object.entries(filterLabels).every(([k, v]) => m.labels[k] === v))
              .map(makeHandleObj)
            return { sandboxes: matched }
          }
        },
        Snapshot: {
          get: async (name: string) => {
            const found = snapshots.get(name)
            if (!found) throw new Error(`[SnapshotNotFound] ${name}`)
            return found
          },
          list: async () => [...snapshots.values()],
          remove: async (name: string) => {
            snapshots.delete(name)
          }
        }
      }

      return { sdk, machines, snapshots }
    }

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (tc) =>
          Effect.scoped(
            Effect.gen(function*() {
              const baseDir = freshDir("msb")
              const { sdk } = makeFakeMsb(baseDir, tc.backend, tc.loseStream)
              const network = tc.network === "none"
                ? ("none" as const)
                : tc.network === "open"
                ? ("open" as const)
                : { allow: ["example.test"] }

              const provider = MicrosandboxSandbox.make({
                sdk,
                owner: "fuzz-owner",
                holder: "holder-1",
                collector: { collect: Effect.void },
                persistence: tc.persistence,
                network,
                ...(tc.withLimits ? { limits: { cpus: 2, memoryMib: 512, timeoutSecs: 120 } } : {})
              })

              const acqExit = yield* provider.acquire(`msb-${seq}`).pipe(Effect.exit)
              if (tc.backend === "cloud") {
                expect(Exit.isFailure(acqExit)).toBe(true)
                return true
              }
              expect(Exit.isSuccess(acqExit)).toBe(true)
              if (Exit.isFailure(acqExit)) return false
              const session = acqExit.value

              // File write & read
              const fPath = `${session.workdir}/m.txt`
              yield* session.writeFile(fPath, encoder.encode("msb-content"))
              expect(decoder.decode(yield* session.readFile(fPath))).toBe("msb-content")
              expect(Exit.isFailure(yield* session.readFile(`${session.workdir}/missing.txt`).pipe(Effect.exit))).toBe(
                true
              )

              // Spawn command
              const cmd = tc.loseStream
                ? "echo LOSE_ME"
                : tc.nonZeroExit
                ? "echo err >&2; exit 4"
                : tc.withStdin
                ? "cat"
                : "echo msb-ok"
              const child = yield* session.spawn(cmd, {
                ...(tc.withStdin ? { stdin: encoder.encode("msb-in") } : {}),
                env: { MSB_VAR: "1" }
              })
              const outExit = yield* Effect.all([
                Stream.mkString(Stream.decodeText(child.stdout)),
                Stream.mkString(Stream.decodeText(child.stderr)),
                child.exitCode
              ], { concurrency: "unbounded" }).pipe(Effect.exit)
              if (tc.loseStream) {
                expect(Exit.isFailure(outExit)).toBe(true)
              } else {
                expect(Exit.isSuccess(outExit)).toBe(true)
                if (Exit.isSuccess(outExit)) {
                  const [out, err, code] = outExit.value
                  if (tc.nonZeroExit) {
                    expect(code).toBe(4)
                    expect(err).toContain("err")
                  } else {
                    expect(code).toBe(0)
                    expect(out).toContain(tc.withStdin ? "msb-in" : "msb-ok")
                  }
                }
              }
              return true
            })
          ).pipe(Effect.provide(silentLogger)),
        { seed: seed + 1, executions: ioExecutions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)

    // Exercise MicrosandboxSandbox snapshots & reap directly!
    await Effect.runPromise(
      Effect.gen(function*() {
        const snapDir = freshDir("msb-snap")
        const { sdk, machines } = makeFakeMsb(snapDir, "local", false)

        // snapshotName / snapshotFamily edge cases
        expect(MicrosandboxSandbox.snapshotName("fam", "v1")).toBe("fam.v1")
        expect(MicrosandboxSandbox.snapshotName("", "v1")).toBeUndefined()
        expect(MicrosandboxSandbox.snapshotName("fam", "a.b")).toBeUndefined()
        expect(MicrosandboxSandbox.snapshotFamily("fam.v1")).toBe("fam")
        expect(MicrosandboxSandbox.snapshotFamily("nosplit")).toBeUndefined()

        // Seed a machine and capture 2 snapshots via captureSnapshot
        const snapMachineDir = join(snapDir, "m-snap")
        mkdirSync(snapMachineDir, { recursive: true })
        machines.set("m-snap", {
          name: "m-snap",
          dir: snapMachineDir,
          status: "running",
          backendKind: "local",
          labels: { [providerLabel]: providerName, [ownerLabel]: "fuzz-owner", [holderLabel]: "h1" }
        })
        const s1 = yield* MicrosandboxSandbox.captureSnapshot({
          sdk,
          machine: "m-snap",
          family: "repo",
          member: "snap1",
          secrets: []
        })
        expect(s1).toBe("repo.snap1")
        expect(yield* MicrosandboxSandbox.hasSnapshot(sdk, "repo.snap1")).toBe(true)
        expect(yield* MicrosandboxSandbox.hasSnapshot(sdk, "repo.missing")).toBe(false)

        const snapMachineDir2 = join(snapDir, "m-snap2")
        mkdirSync(snapMachineDir2, { recursive: true })
        machines.set("m-snap2", {
          name: "m-snap2",
          dir: snapMachineDir2,
          status: "running",
          backendKind: "local",
          labels: { [providerLabel]: providerName, [ownerLabel]: "fuzz-owner", [holderLabel]: "h1" }
        })
        yield* MicrosandboxSandbox.captureSnapshot({
          sdk,
          machine: "m-snap2",
          family: "repo",
          member: "snap2",
          secrets: []
        })
        const pruned = yield* MicrosandboxSandbox.pruneSnapshots(sdk, "repo", 1)
        expect(pruned.length).toBeGreaterThanOrEqual(1)
        yield* MicrosandboxSandbox.removeSnapshot(sdk, "repo.snap2")

        // Seed machines for reap: one live holder, one dead holder, one dead-but-retained holder
        const m1 = join(snapDir, "m-live")
        const m2 = join(snapDir, "m-dead")
        const m3 = join(snapDir, "m-retain")
        mkdirSync(m1, { recursive: true })
        mkdirSync(m2, { recursive: true })
        mkdirSync(m3, { recursive: true })
        machines.set("m-live", {
          name: "m-live",
          dir: m1,
          status: "running",
          backendKind: "local",
          labels: { [providerLabel]: providerName, [ownerLabel]: "o1", [holderLabel]: "alive-1" }
        })
        machines.set("m-dead", {
          name: "m-dead",
          dir: m2,
          status: "crashed",
          backendKind: "local",
          labels: { [providerLabel]: providerName, [ownerLabel]: "o1", [holderLabel]: "dead-1" }
        })
        machines.set("m-retain", {
          name: "m-retain",
          dir: m3,
          status: "stopped",
          backendKind: "local",
          labels: { [providerLabel]: providerName, [ownerLabel]: "o1", [holderLabel]: "dead-2", sticky: "true" }
        })

        const reaped = yield* MicrosandboxSandbox.reap({
          sdk,
          owner: "o1",
          isAlive: (h) => Effect.succeed(h === "alive-1"),
          retain: (labels) => Effect.succeed(labels.sticky === "true")
        })
        expect(reaped.map((r) => r.name)).toEqual(["m-dead"])
        expect(machines.has("m-live")).toBe(true)
        expect(machines.has("m-retain")).toBe(true)
      }).pipe(Effect.provide(silentLogger))
    )
  })
})
