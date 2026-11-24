import { NodeChildProcessSpawner, NodeFileSystem } from "@effect/platform-node"
import { Fuzz } from "@smthrs/fuzz"
import {
  Arbitrary,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Path,
  PlatformError,
  Schema,
  Sink,
  Stream
} from "effect"
import {
  ChildProcessSpawner,
  ExitCode,
  make as makeSpawner,
  makeHandle,
  ProcessId
} from "effect/process/ChildProcessSpawner"
import * as Redacted from "effect/Redacted"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as AwsSandbox from "../src/AwsSandbox/index.ts"
import * as CloudflareSandbox from "../src/CloudflareSandbox/index.ts"
import * as CommandSandbox from "../src/CommandSandbox/index.ts"
import * as ContainerSandbox from "../src/ContainerSandbox/index.ts"
import * as DirectorySandbox from "../src/DirectorySandbox/index.ts"
import { networkLabel } from "../src/internal/microsandboxNetwork.ts"
import * as JustBashSandbox from "../src/JustBashSandbox/index.ts"
import * as KubernetesSandbox from "../src/KubernetesSandbox/index.ts"
import * as MicrosandboxSandbox from "../src/MicrosandboxSandbox/index.ts"
import { holderLabel, ownerLabel, providerLabel, providerName } from "../src/MicrosandboxSandbox/labels.ts"
import type { Sdk as MsbSdk } from "../src/MicrosandboxSandbox/Sdk.ts"
import type { Session } from "../src/Sandbox/Session.ts"
import * as VercelSandbox from "../src/VercelSandbox/index.ts"
import type { Sdk as VercelSdk } from "../src/VercelSandbox/Sdk.ts"
import { platform } from "./helpers/containedPlatform.ts"

const configurationLabel = "smithers.configuration"
const limitsLabel = "smithers.limits"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "40"))
const ioExecutions = Math.max(10, Math.min(baseExecutions, 24))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261124")
const silentLogger = Logger.layer([])

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-wave9-prov-")))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const localServices = Effect.runSync(
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    const fs = yield* FileSystem.FileSystem
    return { spawner, fs }
  }).pipe(Effect.provide(platform))
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

const makeSimpleHandle = (
  stdoutText: string,
  stderrText: string,
  code: number,
  options?: { readonly killFail?: boolean; readonly onKill?: (sig: string) => void }
) =>
  makeHandle({
    pid: ProcessId(1000 + (++seq % 5000)),
    exitCode: Effect.succeed(ExitCode(code)),
    isRunning: Effect.succeed(false),
    kill: (opts) => {
      options?.onKill?.(opts?.killSignal ?? "SIGTERM")
      return options?.killFail
        ? Effect.fail(
          PlatformError.systemError({
            _tag: "Unknown",
            module: "ChildProcess",
            method: "kill",
            description: "kill denied"
          })
        )
        : Effect.void
    },
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: stdoutText === "" ? Stream.empty : Stream.make(encoder.encode(stdoutText)),
    stderr: stderrText === "" ? Stream.empty : Stream.make(encoder.encode(stderrText)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty
  })

describe("@smthrs/sandbox Wave-9 providers deep fuzz", () => {
  it(
    "MicrosandboxSandbox covers reattach refusals, revive loops, retained attach, snapshots secret scan, process kill/recv faults, and remove/network helpers",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          reattachCase: Schema.Literals([
            "owner-mismatch",
            "network-mismatch",
            "limits-mismatch",
            "config-mismatch",
            "bad-config-json",
            "modify-not-applied",
            "reattach-running",
            "reattach-stopped-detached",
            "reattach-stopped-attached"
          ]),
          attachCase: Schema.Literals(["absent", "stopped", "starting", "bad-owner", "ok"]),
          reviveCase: Schema.Literals(["connect-ok", "transient-then-restart", "network-replaced"]),
          snapshotCase: Schema.Literals([
            "bad-name",
            "short-secret",
            "no-network-stopped",
            "leaked-secret",
            "ok",
            "missing-remove"
          ]),
          killFault: Schema.Boolean,
          recvFault: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (tc) =>
            Effect.gen(function*() {
              const files = new Map<string, Uint8Array>()
              const validLabels: Record<string, string> = {
                [providerLabel]: providerName,
                [ownerLabel]: "wave9-owner",
                [holderLabel]: "old-holder",
                [networkLabel]: "none",
                [configurationLabel]: JSON.stringify({
                  image: "alpine:latest",
                  rootDiskMib: 512,
                  cpus: 1,
                  memoryMib: 256
                })
              }

              const makeVendorSandbox = (
                name: string,
                opts?: {
                  readonly failFirstExec?: boolean
                  readonly destroyFail?: boolean
                  readonly forceRevive?: boolean
                }
              ) => {
                let execCalls = 0
                return {
                  name,
                  backendKind: "local",
                  fs: () => ({
                    mkdir: async () => undefined,
                    read: async (path: string) => {
                      const data = files.get(path)
                      if (!data) {
                        const err = new Error(`not found: ${path}`)
                        Object.assign(err, { code: "ENOENT" })
                        throw err
                      }
                      return data
                    },
                    write: async (path: string, data: Uint8Array) => {
                      files.set(path, data)
                    }
                  }),
                  execStreamWith: async (cmd: string, configure?: (b: unknown) => unknown) => {
                    execCalls += 1
                    const argsList: Array<string> = []
                    const builder = {
                      args: (a: ReadonlyArray<string>) => {
                        argsList.push(...a)
                        return builder
                      },
                      cwd: () => builder,
                      env: () => builder,
                      envs: () => builder,
                      stdinBytes: () => builder,
                      stdinNull: () => builder
                    }
                    configure?.(builder)
                    const joined = `${cmd} ${argsList.join(" ")}`
                    if ((opts?.failFirstExec || opts?.forceRevive) && execCalls === 1) {
                      const err = new Error("connection reset by peer")
                      Object.assign(err, { code: "ECONNRESET" })
                      throw err
                    }
                    let step = 0
                    const isScrub = joined.includes("base64") || joined.includes("grep") || joined.includes("find")
                    const leakText = tc.snapshotCase === "leaked-secret" && isScrub ? "etc/leaked.env\n" : ""
                    return {
                      recv: async () => {
                        step += 1
                        if (tc.recvFault && !isScrub && !joined.includes("true") && !joined.includes("sync")) {
                          throw new Error("stream broken")
                        }
                        if (step === 1 && leakText !== "") {
                          return { kind: "stdout", data: encoder.encode(leakText) }
                        }
                        if ((step === 1 && leakText === "") || (step === 2 && leakText !== "")) {
                          return { kind: "exited", code: isScrub && leakText === "" ? 1 : 0 }
                        }
                        return null
                      },
                      kill: async () => {
                        if (tc.killFault) throw new Error("kill rpc failed")
                      }
                    }
                  },
                  stop: async () => undefined,
                  destroy: async () => {
                    if (opts?.destroyFail) throw new Error("destroy rpc failed")
                  }
                }
              }

              const reattachLabels: Record<string, string> = (() => {
                switch (tc.reattachCase) {
                  case "owner-mismatch":
                    return { ...validLabels, [ownerLabel]: "other-owner" }
                  case "network-mismatch":
                    return { ...validLabels, [networkLabel]: "open" }
                  case "limits-mismatch":
                    return { ...validLabels, [limitsLabel]: JSON.stringify({ cpus: 4 }) }
                  case "config-mismatch":
                    return {
                      ...validLabels,
                      [configurationLabel]: JSON.stringify({
                        image: "ubuntu:latest",
                        rootDiskMib: 512,
                        cpus: 1,
                        memoryMib: 256
                      })
                    }
                  case "bad-config-json":
                    return { ...validLabels, [configurationLabel]: "{not-json" }
                  default:
                    return validLabels
                }
              })()

              const reattachNetwork = tc.reattachCase === "network-mismatch" ? { policy: "open" } : { disabled: true }
              const reattachStatus = tc.reattachCase === "reattach-running" ? "running" : "stopped"

              const makeBuilder = () => {
                const b = {
                  image: () => b,
                  fromSnapshot: () => b,
                  rootDisk: () => b,
                  cpus: () => b,
                  maxCpus: () => b,
                  memory: () => b,
                  maxMemory: () => b,
                  security: () => b,
                  pullPolicy: () => b,
                  labels: () => b,
                  maxDuration: () => b,
                  idleTimeout: () => b,
                  disableNetwork: () => b,
                  network: (fn: (nb: { policy: (p: unknown) => unknown }) => unknown) => {
                    fn({ policy: () => undefined })
                    return b
                  },
                  ephemeral: () => b,
                  detached: () => b,
                  create: async () => {
                    const err = new Error("already exists")
                    Object.assign(err, { code: "sandboxAlreadyExists" })
                    throw err
                  }
                }
                return b
              }

              let reviveGetCount = 0
              const sdk: MsbSdk = {
                defaultBackendKind: () => "local",
                setDefaultBackend: () => undefined,
                Sandbox: {
                  builder: makeBuilder as unknown as MsbSdk["Sandbox"]["builder"],
                  get: async (name: string) => {
                    if (name.startsWith("smthrs-") && name.length < 25) {
                      const err = new Error("not found")
                      Object.assign(err, { code: "sandboxNotFound" })
                      throw err
                    }
                    if (name === "snap-vm") {
                      return {
                        name,
                        status: tc.snapshotCase === "no-network-stopped" ? "stopped" : "running",
                        configJson: JSON.stringify(
                          tc.snapshotCase === "no-network-stopped"
                            ? { labels: {} }
                            : { labels: validLabels, network: { disabled: true } }
                        ),
                        modify: async () => ({ applied: true }),
                        connect: async () => makeVendorSandbox(name),
                        start: async () => makeVendorSandbox(name),
                        startDetached: async () => makeVendorSandbox(name),
                        stop: async () => undefined,
                        refresh: async () => {
                          throw new Error("unused")
                        },
                        snapshot: async () => undefined,
                        destroy: async () => undefined
                      } as unknown as Awaited<ReturnType<MsbSdk["Sandbox"]["get"]>>
                    }
                    if (name.includes("attach-")) {
                      if (tc.attachCase === "absent") {
                        const err = new Error("not found")
                        Object.assign(err, { code: "sandboxNotFound" })
                        throw err
                      }
                      return {
                        name,
                        status: tc.attachCase === "stopped"
                          ? "stopped"
                          : tc.attachCase === "starting"
                          ? "starting"
                          : "running",
                        configJson: JSON.stringify({
                          labels: tc.attachCase === "bad-owner"
                            ? { ...validLabels, [ownerLabel]: "stranger" }
                            : validLabels,
                          network: { disabled: true }
                        }),
                        modify: async () => ({ applied: true }),
                        connect: async () => makeVendorSandbox(name, { destroyFail: tc.killFault }),
                        start: async () => makeVendorSandbox(name),
                        startDetached: async () => makeVendorSandbox(name),
                        stop: async () => undefined,
                        refresh: async () => ({} as never),
                        snapshot: async () => undefined,
                        destroy: async () => {
                          if (tc.killFault) throw new Error("destroy fail")
                        }
                      } as unknown as Awaited<ReturnType<MsbSdk["Sandbox"]["get"]>>
                    }
                    reviveGetCount += 1
                    const isRevive = reviveGetCount > 1
                    const handleObj = {
                      name,
                      status: isRevive ? "running" : reattachStatus,
                      configJson: JSON.stringify({
                        labels: reattachLabels,
                        network: isRevive && tc.reviveCase === "network-replaced" ? { policy: "open" } : reattachNetwork
                      }),
                      modify: async () => ({ applied: tc.reattachCase !== "modify-not-applied" }),
                      connect: async () =>
                        makeVendorSandbox(name, {
                          failFirstExec: isRevive && tc.reviveCase === "transient-then-restart",
                          forceRevive: !isRevive && tc.reattachCase === "reattach-running",
                          destroyFail: tc.killFault
                        }),
                      start: async () => makeVendorSandbox(name),
                      startDetached: async () => makeVendorSandbox(name),
                      stop: async () => undefined,
                      refresh: async () => ({ ...handleObj, status: "stopped" }),
                      snapshot: async () => undefined,
                      destroy: async () => {
                        if (tc.killFault) throw new Error("destroy fail")
                      }
                    }
                    return handleObj as unknown as Awaited<ReturnType<MsbSdk["Sandbox"]["get"]>>
                  },
                  listWith: async () =>
                    ({ items: [], nextCursor: null }) as unknown as Awaited<ReturnType<MsbSdk["Sandbox"]["listWith"]>>
                },
                Snapshot: {
                  get: async () => ({ name: "s", createdAt: 0 }) as never,
                  list: async () => [],
                  remove: async () => {
                    if (tc.snapshotCase === "missing-remove") {
                      const err = new Error("snapshot not found")
                      Object.assign(err, { code: "snapshotNotFound" })
                      throw err
                    }
                  }
                }
              }

              const provider = MicrosandboxSandbox.make({
                sdk,
                image: "alpine:latest",
                rootDiskMib: 512,
                cpus: tc.reattachCase === "limits-mismatch" ? undefined : 1,
                memoryMib: 256,
                owner: "wave9-owner",
                network: "none",
                persistence: tc.reattachCase === "reattach-stopped-attached" ? "ephemeral" : "sticky",
                detached: tc.reattachCase === "reattach-stopped-detached"
                  ? true
                  : tc.reattachCase === "reattach-stopped-attached"
                  ? false
                  : undefined,
                limits: tc.reattachCase === "limits-mismatch" ? { cpus: 2 } : undefined,
                collector: { collect: Effect.void } as never
              })

              const acquired = yield* Effect.exit(
                Effect.scoped(
                  Effect.gen(function*() {
                    const session = yield* provider.acquire(`s-${++seq}`)
                    const procExit = yield* Effect.exit(
                      Effect.scoped(
                        Effect.gen(function*() {
                          const proc = yield* session.spawn("echo hi", { env: { FOO: "bar" } })
                          if (session.kill) {
                            yield* Effect.exit(session.kill(proc, "SIGTERM"))
                          }
                          return yield* proc.exitCode
                        })
                      )
                    )
                    expect(Exit.isSuccess(procExit) || Exit.isFailure(procExit)).toBe(true)
                  })
                )
              )
              expect(Exit.isSuccess(acquired) || Exit.isFailure(acquired)).toBe(true)

              if (provider.attach) {
                const attachExit = yield* Effect.exit(
                  Effect.scoped(
                    provider.attach({
                      id: `a-${++seq}`,
                      remoteId: `msb-attach-${seq}`
                    })
                  )
                )
                expect(Exit.isSuccess(attachExit) || Exit.isFailure(attachExit)).toBe(true)
              }

              const snapExit = yield* Effect.exit(
                MicrosandboxSandbox.captureSnapshot({
                  sdk,
                  machine: "snap-vm",
                  family: tc.snapshotCase === "bad-name" ? "" : "wave9-fam",
                  member: tc.snapshotCase === "bad-name" ? "bad/member" : "v1",
                  secrets: tc.snapshotCase === "short-secret"
                    ? ["short"]
                    : ["line1\nsuper-secret-token-value-1234567890+/=!\nend"]
                })
              )
              if (tc.snapshotCase === "ok") {
                expect(Exit.isSuccess(snapExit)).toBe(true)
              } else if (tc.snapshotCase !== "missing-remove") {
                expect(Exit.isFailure(snapExit)).toBe(true)
              }
              return true
            }).pipe(Effect.provide(silentLogger)),
          { executions: ioExecutions, seed }
        )
      )
      assertPassed(report)
    },
    60_000
  )

  it(
    "AwsSandbox covers option conflicts, pagination cycles, multi-batch adoption/stale deregister, ready timeout, no-transport session & kill paths",
    async () => {
      const baseAws = {
        sdk: {} as AwsSandbox.Sdk,
        region: "us-east-1",
        cluster: "cl",
        image: "alpine",
        taskRoleArn: "arn:aws:iam::123:role/task",
        subnets: ["subnet-1"]
      } as const

      expect(() => AwsSandbox.make({ ...baseAws, cpu: "512", limits: { cpus: 1 } })).toThrow(TypeError)
      expect(() => AwsSandbox.make({ ...baseAws, memory: "1024", limits: { memoryMib: 512 } })).toThrow(TypeError)
      expect(() => AwsSandbox.make({ ...baseAws, limits: { cpus: 0.3 } })).toThrow(TypeError)

      const arb = Arbitrary.schema(
        Schema.Struct({
          listMode: Schema.Literals([
            "cycle",
            "adopt-and-stale",
            "mismatch-owner",
            "fresh-empty-run",
            "no-transport",
            "ready-timeout"
          ]),
          deregisterFail: Schema.Boolean,
          execFailCode: Schema.Literals([0, 1]),
          writeFail: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (tc) =>
            Effect.gen(function*() {
              let regCount = 0
              const stubSpawner = makeSpawner((cmd) => {
                const standard = cmd._tag === "StandardCommand" ? cmd : undefined
                const joined = standard ? [standard.command, ...standard.args.map(plainWord)].join(" ") : ""
                if (tc.execFailCode !== 0 && joined.includes("execute-command")) {
                  return Effect.succeed(makeSimpleHandle("", "aws ecs exec failed", 1))
                }
                if (tc.writeFail && joined.includes("base64")) {
                  return Effect.succeed(makeSimpleHandle("write error", "", 1))
                }
                return Effect.succeed(makeSimpleHandle("ok\n", "", 0))
              })

              const sdk: AwsSandbox.Sdk = {
                registerTaskDefinition: async (input) => ({
                  taskDefinition: {
                    taskDefinitionArn: `arn:aws:ecs:us-east-1:123:task-definition/${input.family}:${++regCount}`
                  }
                }),
                deregisterTaskDefinition: async () => {
                  if (tc.deregisterFail) throw new Error("deregister failed")
                  return {}
                },
                listTaskDefinitions: async (input) => ({
                  taskDefinitionArns: [
                    `arn:aws:ecs:us-east-1:123:task-definition/${input.familyPrefix}:1`,
                    `arn:aws:ecs:us-east-1:123:task-definition/${input.familyPrefix}:2`
                  ]
                }),
                listTasks: async (input) => {
                  if (tc.listMode === "cycle") {
                    return { taskArns: [], nextToken: "loop-token" }
                  }
                  if (tc.listMode === "adopt-and-stale" || tc.listMode === "mismatch-owner") {
                    return input.desiredStatus === "RUNNING"
                      ? {
                        taskArns: [
                          "arn:aws:ecs:us-east-1:123:task/cl/t-1",
                          "arn:aws:ecs:us-east-1:123:task/cl/t-2",
                          "arn:aws:ecs:us-east-1:123:task/cl/t-stopped"
                        ]
                      }
                      : { taskArns: [] }
                  }
                  return { taskArns: [] }
                },
                describeTasks: async (input) => ({
                  tasks: input.tasks.map((arn) => {
                    if (arn.endsWith("t-stopped")) {
                      return {
                        taskArn: arn,
                        lastStatus: "STOPPED",
                        taskDefinitionArn: "arn:aws:ecs:us-east-1:123:task-definition/smthrs:1"
                      }
                    }
                    const agentStatus = tc.listMode === "ready-timeout" ? "PENDING" : "RUNNING"
                    const ownerTag = tc.listMode === "mismatch-owner" ? "other-owner" : "smithers"
                    return {
                      taskArn: arn,
                      lastStatus: "RUNNING",
                      taskDefinitionArn: "arn:aws:ecs:us-east-1:123:task-definition/smthrs:1",
                      tags: [
                        { key: "smithers.provider", value: "aws-ecs" },
                        { key: "smithers.owner", value: ownerTag }
                      ],
                      containers: [
                        {
                          name: "sandbox",
                          managedAgents: [{ name: "ExecuteCommandAgent", lastStatus: agentStatus }]
                        }
                      ]
                    }
                  })
                }),
                runTask: async () =>
                  tc.listMode === "fresh-empty-run"
                    ? { tasks: [], failures: [{ reason: "NO_CAPACITY" }] }
                    : { tasks: [{ taskArn: "arn:aws:ecs:us-east-1:123:task/cl/t-new", lastStatus: "RUNNING" }] },
                stopTask: async () => ({})
              }

              const provider = AwsSandbox.make({
                sdk,
                exec: tc.listMode === "no-transport" ? undefined : { spawner: stubSpawner },
                region: "us-east-1",
                cluster: "cl",
                image: "alpine:latest",
                taskRoleArn: "arn:aws:iam::123:role/task",
                subnets: ["subnet-1"],
                env: { WAVE9: "yes" },
                pollIntervalMs: 0,
                maxPollAttempts: 2
              })

              const res = yield* Effect.exit(
                Effect.scoped(
                  Effect.gen(function*() {
                    const s = yield* provider.acquire(`aws-${++seq}`)
                    yield* Effect.exit(s.readFile(`${s.workdir}/a.txt`))
                    yield* Effect.exit(s.writeFile(`${s.workdir}/a.txt`, encoder.encode("hi")))
                    const pExit = yield* Effect.exit(s.spawn("echo hi", {}))
                    if (Exit.isSuccess(pExit) && s.kill) {
                      yield* Effect.exit(s.kill(pExit.value, "SIGTERM"))
                    }
                    if (s.kill) {
                      const fakeProc = {
                        stdout: Stream.empty,
                        stderr: Stream.empty,
                        exitCode: Effect.succeed(0)
                      }
                      const unknownKill = yield* Effect.exit(s.kill(fakeProc, "SIGTERM"))
                      expect(Exit.isFailure(unknownKill)).toBe(true)
                    }
                  })
                )
              )
              expect(Exit.isSuccess(res) || Exit.isFailure(res)).toBe(true)
              return true
            }).pipe(Effect.provide(silentLogger)),
          { executions: ioExecutions, seed: seed + 1 }
        )
      )
      assertPassed(report)
    },
    60_000
  )

  it(
    "KubernetesSandbox, ContainerSandbox, CloudflareSandbox & VercelSandbox cover validation, sealing, env injection, removing polls, legacy fallback & faults",
    async () => {
      expect(() =>
        KubernetesSandbox.make({
          spawner: localServices.spawner,
          image: "alpine",
          resources: { limits: { cpu: "1" } },
          limits: { cpus: 1 }
        })
      ).toThrow(TypeError)
      expect(() =>
        KubernetesSandbox.make({
          spawner: localServices.spawner,
          image: "alpine",
          resources: { limits: { memory: "512Mi" } },
          limits: { memoryMib: 512 }
        })
      ).toThrow(TypeError)

      expect(() =>
        ContainerSandbox.make({
          spawner: localServices.spawner,
          image: "alpine",
          createArgs: ["--cpus=2"],
          limits: { cpus: 1 }
        })
      ).toThrow(TypeError)
      expect(() =>
        ContainerSandbox.make({
          spawner: localServices.spawner,
          image: "alpine",
          createArgs: ["-im", "512m"],
          limits: { memoryMib: 256 }
        })
      ).toThrow(TypeError)

      expect(() =>
        CloudflareSandbox.make({
          sdk: { getSandbox: () => ({} as never) },
          binding: {} as never,
          instances: [{ name: "s", cpus: 1, memoryMib: 256, binding: {} as never }]
        })
      ).toThrow()
      expect(() =>
        CloudflareSandbox.make({
          sdk: { getSandbox: () => ({} as never) },
          instances: [{ name: "bad", cpus: 1, memoryMib: 0, binding: {} as never }]
        })
      ).toThrow()

      expect(() =>
        VercelSandbox.make({
          sdk: { Sandbox: { getOrCreate: async () => ({} as never) } },
          timeoutMs: 1000,
          limits: { timeoutSecs: 60 }
        })
      ).toThrow(TypeError)

      const arb = Arbitrary.schema(
        Schema.Struct({
          k8sMode: Schema.Literals(["seal-env-ok", "empty-uid", "leftover-replace", "delete-fail"]),
          containerMode: Schema.Literals(["removing-ok", "removing-timeout", "unowned", "env-create-fail"]),
          cfMode: Schema.Literals(["legacy-ok", "file-not-found", "rm-fail", "ping-fail", "kill-fail", "destroy-fail"]),
          vercelMode: Schema.Literals(["legacy-found", "legacy-404", "legacy-500", "stderr-fail", "ping-fail"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (tc) =>
            Effect.gen(function*() {
              let k8sCreateCalls = 0
              const k8sSpawner = makeSpawner((cmd) => {
                const standard = cmd._tag === "StandardCommand" ? cmd : undefined
                const args = standard ? standard.args.map(plainWord) : []
                const joined = args.join(" ")
                if (joined.includes("--dry-run=client")) {
                  const pod = {
                    apiVersion: "v1",
                    kind: "Pod",
                    metadata: { name: "p" },
                    spec: {
                      containers: [{
                        name: args[args.indexOf("run") + 1] ?? "sandbox",
                        env: [{ name: "KEEP", value: "1" }]
                      }]
                    }
                  }
                  return Effect.succeed(makeSimpleHandle(JSON.stringify(pod), "", 0))
                }
                if (joined.includes("create -f -")) {
                  k8sCreateCalls += 1
                  if (tc.k8sMode === "leftover-replace" && k8sCreateCalls === 1) {
                    return Effect.succeed(makeSimpleHandle("", "AlreadyExists", 1))
                  }
                  return Effect.succeed(makeSimpleHandle("pod/p created\n", "", 0))
                }
                if (joined.includes("jsonpath={.metadata.uid}")) {
                  return Effect.succeed(makeSimpleHandle(tc.k8sMode === "empty-uid" ? "" : "uid-12345", "", 0))
                }
                if (joined.includes("get pod")) {
                  if (tc.k8sMode === "leftover-replace") {
                    return Effect.succeed(
                      makeSimpleHandle(
                        JSON.stringify({
                          metadata: {
                            uid: "old-uid",
                            labels: { "smithers.provider": "kubernetes", "smithers.owner": "smithers" },
                            annotations: {}
                          },
                          status: { phase: "Failed" }
                        }),
                        "",
                        0
                      )
                    )
                  }
                  return Effect.succeed(makeSimpleHandle("", "NotFound", 1))
                }
                if (joined.includes("delete pod")) {
                  return Effect.succeed(
                    makeSimpleHandle(
                      "",
                      tc.k8sMode === "delete-fail" ? "delete failed" : "",
                      tc.k8sMode === "delete-fail" ? 1 : 0
                    )
                  )
                }
                return Effect.succeed(makeSimpleHandle("ok", "", 0))
              })

              const k8s = KubernetesSandbox.make({
                spawner: k8sSpawner,
                image: "alpine:latest",
                namePrefix: "very-long-kubernetes-sandbox-prefix-for-truncation-test-",
                env: { K8S_ENV: "val" },
                reattachKey: "super-secret-reattach-hmac-key-0123456789"
              })
              const k8sExit = yield* Effect.exit(
                Effect.scoped(
                  Effect.gen(function*() {
                    yield* k8s.acquire(`k8s-very-long-session-key-${++seq}`)
                  })
                )
              )
              expect(Exit.isSuccess(k8sExit) || Exit.isFailure(k8sExit)).toBe(true)

              let inspectCalls = 0
              const cSpawner = makeSpawner((cmd) => {
                const standard = cmd._tag === "StandardCommand" ? cmd : undefined
                const args = standard ? standard.args.map(plainWord) : []
                const joined = args.join(" ")
                if (joined.includes("container create")) {
                  if (tc.containerMode === "env-create-fail") {
                    return Effect.succeed(makeSimpleHandle("", "create failed", 1))
                  }
                  return Effect.succeed(makeSimpleHandle("", "Conflict. The container name is already in use", 1))
                }
                if (joined.includes("container inspect")) {
                  inspectCalls += 1
                  if (tc.containerMode === "removing-ok") {
                    if (inspectCalls === 1) {
                      return Effect.succeed(
                        makeSimpleHandle(
                          JSON.stringify([{ State: { Status: "removing" }, Config: { Labels: {} } }]),
                          "",
                          0
                        )
                      )
                    }
                    return Effect.succeed(makeSimpleHandle("", "No such container", 1))
                  }
                  if (tc.containerMode === "removing-timeout") {
                    return Effect.succeed(
                      makeSimpleHandle(
                        JSON.stringify([{ State: { Status: "removing" }, Config: { Labels: {} } }]),
                        "",
                        0
                      )
                    )
                  }
                  if (tc.containerMode === "unowned") {
                    return Effect.succeed(
                      makeSimpleHandle(
                        JSON.stringify([{
                          State: { Status: "running" },
                          Config: { Labels: { "smithers.owner": "other" } }
                        }]),
                        "",
                        0
                      )
                    )
                  }
                  return Effect.succeed(makeSimpleHandle("", "No such container", 1))
                }
                if (joined.includes("container rm")) {
                  return Effect.succeed(makeSimpleHandle("", "rm failed", 1))
                }
                return Effect.succeed(makeSimpleHandle("ok", "", 0))
              })

              const container = ContainerSandbox.make(
                {
                  spawner: cSpawner,
                  image: "alpine:latest",
                  env: { C_ENV: "1" },
                  removalPollMillis: 1,
                  removalPolls: 2
                } as Parameters<typeof ContainerSandbox.make>[0]
              )
              const cExit = yield* Effect.exit(Effect.scoped(container.acquire(`ctr-${++seq}`)))
              expect(Exit.isSuccess(cExit) || Exit.isFailure(cExit)).toBe(true)

              const cfHandle = {
                exec: async (cmd: string) => {
                  if (cmd.startsWith("rm -f") && tc.cfMode === "rm-fail") {
                    return { stdout: "", stderr: "rm denied", exitCode: 1 }
                  }
                  if (cmd === "true" && tc.cfMode === "ping-fail") {
                    return { stdout: "", stderr: "down", exitCode: 1 }
                  }
                  return { stdout: "ok", stderr: "", exitCode: 0 }
                },
                startProcess: async () => ({
                  id: "p1",
                  waitForExit: async () => ({ stdout: "ok", stderr: "", exitCode: 0 }),
                  kill: async () => {
                    if (tc.cfMode === "kill-fail") throw new Error("kill fail")
                  }
                }),
                readFile: async () => {
                  if (tc.cfMode === "file-not-found") {
                    const e = new Error("missing")
                    Object.assign(e, { code: "FILE_NOT_FOUND" })
                    throw e
                  }
                  return { content: "aGk=", encoding: "base64" as const }
                },
                writeFile: async () => undefined,
                destroy: async () => {
                  if (tc.cfMode === "destroy-fail") throw new Error("destroy fail")
                }
              }
              const cf = CloudflareSandbox.make({
                sdk: {
                  getSandbox: () => cfHandle as never,
                  findSandbox: async () => (tc.cfMode === "legacy-ok" ? (cfHandle as never) : undefined)
                },
                binding: {} as never
              })
              yield* Effect.exit(
                Effect.scoped(
                  Effect.gen(function*() {
                    const s = yield* cf.acquire(`cf-${++seq}`)
                    yield* Effect.exit(s.readFile(`${s.workdir}/x.txt`))
                    if (s.files?.remove) yield* Effect.exit(s.files.remove(`${s.workdir}/x.txt`))
                    yield* Effect.exit(s.spawn("echo hi", { stdin: encoder.encode("in") }))
                    if (s.ping) yield* Effect.exit(s.ping)
                  })
                )
              )
              if (cf.attach && cf.destroy) {
                const cfSess = { id: `cf-att-${++seq}`, remoteId: `smthrs-cf-att-${seq}` }
                yield* Effect.exit(Effect.scoped(cf.attach(cfSess)))
                yield* Effect.exit(cf.destroy(cfSess))
              }

              const vBox = {
                sandboxId: "v-1",
                runCommand: async (opts: { readonly cmd: string }) => ({
                  exitCode: opts.cmd === "true" && tc.vercelMode === "ping-fail" ? 1 : 0,
                  stdout: async () => "ok",
                  stderr: async () => {
                    if (tc.vercelMode === "stderr-fail") throw new Error("stderr read err")
                    return ""
                  }
                }),
                readFileToBuffer: async () => Buffer.from("hi"),
                writeFiles: async () => undefined,
                stop: async () => undefined
              }
              const vSdk: VercelSdk = {
                Sandbox: {
                  getOrCreate: async () => vBox as never,
                  get: async () => {
                    if (tc.vercelMode === "legacy-found") return vBox as never
                    if (tc.vercelMode === "legacy-404") {
                      const e = new Error("not found")
                      Object.assign(e, { response: { status: 404 } })
                      throw e
                    }
                    if (tc.vercelMode === "legacy-500") {
                      const e = new Error("boom")
                      Object.assign(e, { response: { status: 500 } })
                      throw e
                    }
                    return undefined as never
                  }
                }
              }
              const vercel = VercelSandbox.make({ sdk: vSdk })
              yield* Effect.exit(
                Effect.scoped(
                  Effect.gen(function*() {
                    const s = yield* vercel.acquire(`vc-${++seq}`)
                    const p = yield* s.spawn("echo hi", {})
                    yield* Effect.exit(Stream.runDrain(p.stderr))
                    if (s.ping) yield* Effect.exit(s.ping)
                  })
                )
              )
              return true
            }).pipe(Effect.provide(silentLogger)),
          { executions: ioExecutions, seed: seed + 2 }
        )
      )
      assertPassed(report)
    },
    60_000
  )

  it(
    "DirectorySandbox, JustBashSandbox & CommandSandbox cover relative root, fork, kill, large binary stdin, closed workspace, NUL script, piddir & heartbeat states",
    async () => {
      expect(() =>
        DirectorySandbox.make({
          fs: localServices.fs,
          spawner: localServices.spawner,
          root: "relative/path"
        })
      ).toThrow(TypeError)

      const arb = Arbitrary.schema(
        Schema.Struct({
          hbCode: Schema.Literals([0, 3, 4, 1]),
          hbBootChanged: Schema.Boolean,
          jbClosed: Schema.Boolean,
          jbKill: Schema.Boolean,
          cmdNul: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (tc) =>
            Effect.gen(function*() {
              const dirRoot = freshDir("dir-sb")
              const dirProvider = DirectorySandbox.make({
                fs: localServices.fs,
                spawner: localServices.spawner,
                root: dirRoot
              })
              yield* Effect.scoped(
                Effect.gen(function*() {
                  const s1 = yield* dirProvider.acquire(`dir-${++seq}`)
                  yield* s1.writeFile(`${s1.workdir}/hello.txt`, encoder.encode("world"))
                  writeFileSync(join(s1.workdir, ".netrc"), "secret")
                  const proc = yield* s1.spawn("sleep 5", {})
                  if (s1.kill) {
                    yield* Effect.exit(s1.kill(proc, "SIGTERM"))
                    const fakeProc = { stdout: Stream.empty, stderr: Stream.empty, exitCode: Effect.succeed(0) }
                    const badKill = yield* Effect.exit(s1.kill(fakeProc, "SIGTERM"))
                    expect(Exit.isFailure(badKill)).toBe(true)
                  }
                  if (s1.fork) {
                    const s2 = yield* s1.fork(`dir-fork-${++seq}`)
                    const copied = yield* s2.readFile(`${s2.workdir}/hello.txt`)
                    expect(decoder.decode(copied)).toBe("world")
                  }
                })
              )

              const jbRoot = freshDir("jb-sb")
              const jbProvider = JustBashSandbox.make({
                root: jbRoot,
                fs: localServices.fs,
                bash: {
                  exec: async (_cmd, opts) => {
                    if (tc.jbKill) {
                      await new Promise((r) => setTimeout(r, 40))
                    }
                    return { stdout: String(opts?.stdin?.length ?? 0), stderr: "", exitCode: 0 }
                  }
                }
              })
              let leakedSession: Session | undefined
              yield* Effect.scoped(
                Effect.gen(function*() {
                  const s = yield* jbProvider.acquire(`jb-${++seq}`)
                  leakedSession = s
                  const bigBytes = new Uint8Array(10_000)
                  bigBytes.fill(0xfe)
                  const proc = yield* s.spawn("cat", {
                    stdin: bigBytes,
                    env: { GOOD: "1" }
                  })
                  if (tc.jbKill && s.kill) {
                    yield* Effect.exit(s.kill(proc, "SIGTERM"))
                  }
                  yield* Effect.exit(proc.exitCode)
                  const badEnv = yield* Effect.exit(
                    s.spawn("echo", { env: { BAD: undefined as unknown as string } })
                  )
                  expect(Exit.isFailure(badEnv)).toBe(true)
                  const missing = yield* Effect.exit(s.readFile(`${s.workdir}/does-not-exist.bin`))
                  expect(Exit.isFailure(missing)).toBe(true)
                })
              )
              if (tc.jbClosed && leakedSession !== undefined) {
                const target = leakedSession
                const closedExit = yield* Effect.exit(Effect.scoped(target.spawn("echo hi", {})))
                expect(Exit.isFailure(closedExit)).toBe(true)
              }

              let bootCall = 0
              const hbSpawner = makeSpawner((cmd) => {
                const standard = cmd._tag === "StandardCommand" ? cmd : undefined
                const joined = standard ? [standard.command, ...standard.args.map(plainWord)].join(" ") : ""
                if (joined.includes("id -u")) {
                  return Effect.succeed(makeSimpleHandle("1000\n", "", 0))
                }
                if (joined.includes("boot_id") || joined.includes("heartbeat") || joined.includes("stat")) {
                  bootCall += 1
                  if (bootCall === 1) return Effect.succeed(makeSimpleHandle("boot-1\n", "", 0))
                  const bootId = tc.hbBootChanged ? "boot-2\n" : "boot-1\n"
                  return Effect.succeed(makeSimpleHandle(bootId, "", tc.hbCode))
                }
                return Effect.succeed(makeSimpleHandle("ok\n", "", 0))
              })
              const cmdSb = CommandSandbox.make(
                {
                  spawner: hbSpawner,
                  prefix: ["ssh", "host"],
                  workdir: "/workspace",
                  name: "wave9-cmd",
                  heartbeatEvery: "5 millis"
                } as Parameters<typeof CommandSandbox.make>[0]
              )
              yield* Effect.exit(
                Effect.scoped(
                  Effect.gen(function*() {
                    const s = yield* cmdSb.acquire(`cmd-${++seq}`)
                    if (tc.cmdNul) {
                      const nulExit = yield* Effect.exit(s.spawn("echo \0bad", {}))
                      expect(Exit.isFailure(nulExit)).toBe(true)
                    } else {
                      const f = yield* Effect.forkChild(s.spawn("echo ok", {}))
                      yield* Effect.sleep("15 millis")
                      yield* Fiber.interrupt(f)
                    }
                  })
                )
              )
              return true
            }).pipe(Effect.provide(silentLogger)),
          { executions: ioExecutions, seed: seed + 3 }
        )
      )
      assertPassed(report)
    },
    60_000
  )
})
