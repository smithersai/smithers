import { Fuzz } from "@smthrs/fuzz"
import { JjError } from "@smthrs/jj"
import type * as Jj from "@smthrs/jj/Jj"
import { Arbitrary, Effect, Exit, Fiber, FileSystem, Logger, Path, PlatformError, Schema, Sink, Stream } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as ChildProcess from "effect/process/ChildProcess"
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
import * as HttpSandbox from "../src/HttpSandbox/index.ts"
import { linuxFileSystem } from "../src/internal/linuxFileSystem.ts"
import { networkLabel } from "../src/internal/microsandboxNetwork.ts"
import { sessionSlug } from "../src/internal/sessionSlug.ts"
import * as JjWorkspaceSandbox from "../src/JjWorkspaceSandbox/index.ts"
import * as MicrosandboxSandbox from "../src/MicrosandboxSandbox/index.ts"
import { holderLabel, ownerLabel, providerLabel, providerName } from "../src/MicrosandboxSandbox/labels.ts"
import type { Sdk as MsbSdk } from "../src/MicrosandboxSandbox/Sdk.ts"
import * as RemoteChildProcessSpawner from "../src/RemoteChildProcessSpawner/index.ts"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import * as Sandbox from "../src/Sandbox/index.ts"
import { platform } from "./helpers/containedPlatform.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "40"))
const ioExecutions = Math.max(10, Math.min(baseExecutions, 20))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261128")
const silentLogger = Logger.layer([])

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-wave9-boost-")))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const encoder = new TextEncoder()
const localServices = Effect.runSync(
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    return { spawner, fs, path }
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

const makeSimpleHandle = (stdoutText: string, stderrText: string, code: number, delayMs = 0) =>
  makeHandle({
    pid: ProcessId(2000 + (++seq % 5000)),
    exitCode: delayMs > 0
      ? Effect.sleep(`${delayMs} millis`).pipe(Effect.as(ExitCode(code)))
      : Effect.succeed(ExitCode(code)),
    isRunning: Effect.succeed(delayMs > 0),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: stdoutText === "" ? Stream.empty : Stream.make(encoder.encode(stdoutText)),
    stderr: stderrText === "" ? Stream.empty : Stream.make(encoder.encode(stderrText)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty
  })

describe("@smthrs/sandbox Wave-9 deep boost (revive, attach, adopt, sticky jj/cf, heartbeat, linuxFS, HTTP limits)", () => {
  it(
    "MicrosandboxSandbox covers sticky revive (connect-ok, transient-restart, network-replaced), retained attach (matching slug), image+snapshot conflict & microsandboxProcess interrupt/null/undefined",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          revivePath: Schema.Literals(["connect-ok", "transient-restart", "network-replaced", "non-transient"]),
          attachState: Schema.Literals(["absent", "stopped", "starting", "bad-labels", "running-ok"]),
          processEdge: Schema.Literals(["abandon-start", "recv-null", "recv-undefined", "kill-error"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (tc) =>
            Effect.gen(function*() {
              const owner = "wave9-boost-owner"
              const validLabels: Record<string, string> = {
                [providerLabel]: providerName,
                [ownerLabel]: owner,
                [holderLabel]: "h1",
                [networkLabel]: "none"
              }
              const makeLiveBox = (name: string, failNextExec: boolean, slowStart: boolean) => {
                let execNum = 0
                return {
                  name,
                  backendKind: "local" as const,
                  fs: () => ({
                    mkdir: async () => undefined,
                    read: async () => encoder.encode("ok"),
                    write: async () => undefined
                  }),
                  execStreamWith: async (_cmd: string, configure?: (b: unknown) => unknown) => {
                    execNum += 1
                    const builder = {
                      args: () => builder,
                      cwd: () => builder,
                      envs: () => builder,
                      stdinBytes: () => builder
                    }
                    configure?.(builder)
                    if (slowStart) {
                      await new Promise((r) => setTimeout(r, 40))
                    }
                    if (failNextExec && execNum === 1) {
                      const e = new Error("connection reset")
                      Object.assign(e, { code: "ECONNRESET" })
                      throw e
                    }
                    let idx = 0
                    return {
                      recv: async () => {
                        idx += 1
                        if (tc.processEdge === "recv-null") return null
                        if (tc.processEdge === "recv-undefined") return undefined
                        if (idx === 1) return { kind: "exited", code: 0 }
                        return null
                      },
                      kill: async () => {
                        if (tc.processEdge === "kill-error") throw new Error("kill failed")
                      }
                    }
                  },
                  stop: async () => undefined,
                  destroy: async () => undefined
                }
              }

              let createdCount = 0
              let getCount = 0
              const sdk: MsbSdk = {
                defaultBackendKind: () => "local",
                setDefaultBackend: () => undefined,
                Sandbox: {
                  builder: ((name: string) => {
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
                      network: () => b,
                      ephemeral: () => b,
                      detached: () => b,
                      create: async () => {
                        createdCount += 1
                        return makeLiveBox(name, createdCount === 1, false)
                      }
                    }
                    return b
                  }) as unknown as MsbSdk["Sandbox"]["builder"],
                  get: async (name: string) => {
                    if (name.includes("att-")) {
                      if (tc.attachState === "absent") {
                        const e = new Error("absent")
                        Object.assign(e, { code: "sandboxNotFound" })
                        throw e
                      }
                      return {
                        name,
                        status: tc.attachState === "stopped"
                          ? "stopped"
                          : tc.attachState === "starting"
                          ? "starting"
                          : "running",
                        configJson: JSON.stringify({
                          labels: tc.attachState === "bad-labels"
                            ? { ...validLabels, [ownerLabel]: "wrong" }
                            : validLabels,
                          network: { disabled: true }
                        }),
                        modify: async () => ({ applied: true }),
                        connect: async () => makeLiveBox(name, false, tc.processEdge === "abandon-start"),
                        start: async () => makeLiveBox(name, false, false),
                        startDetached: async () => makeLiveBox(name, false, false),
                        stop: async () => undefined,
                        refresh: async () => ({} as never),
                        snapshot: async () => undefined,
                        destroy: async () => undefined
                      } as unknown as Awaited<ReturnType<MsbSdk["Sandbox"]["get"]>>
                    }
                    getCount += 1
                    // First get is legacy lookup -> sandboxNotFound
                    if (getCount === 1) {
                      const e = new Error("not found")
                      Object.assign(e, { code: "sandboxNotFound" })
                      throw e
                    }
                    const handleObj = {
                      name,
                      status: "running",
                      configJson: JSON.stringify({
                        labels: validLabels,
                        network: tc.revivePath === "network-replaced" ? { policy: "open" } : { disabled: true }
                      }),
                      modify: async () => ({ applied: true }),
                      connect: async () => {
                        if (tc.revivePath === "transient-restart") {
                          const e = new Error("ECONNRESET")
                          Object.assign(e, { code: "ECONNRESET" })
                          throw e
                        }
                        if (tc.revivePath === "non-transient") {
                          throw new Error("fatal guest error")
                        }
                        return makeLiveBox(name, false, false)
                      },
                      start: async () => makeLiveBox(name, false, false),
                      startDetached: async () => makeLiveBox(name, false, false),
                      stop: async () => undefined,
                      refresh: async () => ({ ...handleObj, status: "stopped" }),
                      snapshot: async () => undefined,
                      destroy: async () => undefined
                    }
                    return handleObj as unknown as Awaited<ReturnType<MsbSdk["Sandbox"]["get"]>>
                  },
                  listWith: async () =>
                    ({ items: [], nextCursor: null }) as unknown as Awaited<ReturnType<MsbSdk["Sandbox"]["listWith"]>>
                },
                Snapshot: {
                  get: async () => ({ name: "s", createdAt: 0 }) as never,
                  list: async () => [],
                  remove: async () => undefined
                }
              }

              // 1. Both image & snapshot exclusive failure
              const badBoth = MicrosandboxSandbox.make({
                sdk,
                image: "alpine:latest",
                snapshot: "snap-1",
                owner,
                network: "none",
                collector: { collect: Effect.void } as never
              })
              const bothExit = yield* Effect.exit(Effect.scoped(badBoth.acquire("both-1")))
              expect(Exit.isFailure(bothExit)).toBe(true)

              // 2. Sticky provider with rootDiskMib & revive trigger
              const sticky = MicrosandboxSandbox.make({
                sdk,
                image: "alpine:latest",
                rootDiskMib: 512,
                owner,
                network: "none",
                persistence: "sticky",
                collector: { collect: Effect.void } as never
              })
              yield* Effect.exit(
                Effect.scoped(
                  Effect.gen(function*() {
                    const s = yield* sticky.acquire(`rev-${++seq}`)
                    yield* Effect.exit(s.spawn("echo revive-me", { env: { A: "1", SKIP: undefined } }))
                  })
                )
              )

              // 3. Retained attach with exact matching remoteId slug
              if (sticky.attach) {
                const id = `att-${++seq}`
                const remoteId = `smthrs-${sessionSlug(id)}`
                yield* Effect.exit(
                  Effect.scoped(
                    Effect.gen(function*() {
                      const s = yield* sticky.attach!({ id, remoteId })
                      if (tc.processEdge === "abandon-start") {
                        const f = yield* Effect.forkChild(s.spawn("sleep 1", {}))
                        yield* Effect.sleep("5 millis")
                        yield* Fiber.interrupt(f)
                      } else {
                        const p = yield* Effect.exit(s.spawn("echo x", {}))
                        if (Exit.isSuccess(p) && s.kill) {
                          yield* Effect.exit(s.kill(p.value, "SIGTERM"))
                        }
                      }
                    })
                  )
                )
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
    "AwsSandbox adopts matching live tasks, stops stale duplicates, deregisters stale definitions, awaits unready adopted tasks & serves no-transport refusal session",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          adoptedReady: Schema.Boolean,
          corruptTag: Schema.Boolean,
          withExec: Schema.Boolean,
          taskDefEnvNoContainer: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (tc) =>
            Effect.gen(function*() {
              let capturedTags: ReadonlyArray<
                { readonly key?: string | undefined; readonly value?: string | undefined }
              > = []
              let capturedDef = "arn:aws:ecs:us-east-1:123:task-definition/smthrs-def:1"
              let firstRun = true
              let describeCalls = 0
              const sdk: AwsSandbox.Sdk = {
                registerTaskDefinition: async (input) => {
                  capturedDef = `arn:aws:ecs:us-east-1:123:task-definition/${input.family}:2`
                  return { taskDefinition: { taskDefinitionArn: capturedDef } }
                },
                deregisterTaskDefinition: async () => ({}),
                listTaskDefinitions: async (input) => ({
                  taskDefinitionArns: [
                    `arn:aws:ecs:us-east-1:123:task-definition/${input.familyPrefix}:1`,
                    capturedDef
                  ]
                }),
                listTasks: async (input) => {
                  if (firstRun) return { taskArns: [] }
                  return input.desiredStatus === "RUNNING"
                    ? {
                      taskArns: [
                        "arn:aws:ecs:us-east-1:123:task/cl/adopt-1",
                        "arn:aws:ecs:us-east-1:123:task/cl/stale-2",
                        "arn:aws:ecs:us-east-1:123:task/cl/stopped-3"
                      ]
                    }
                    : { taskArns: [] }
                },
                describeTasks: async (input) => {
                  describeCalls += 1
                  const readyNow = tc.adoptedReady || describeCalls >= 3
                  return {
                    tasks: input.tasks.map((arn) => {
                      if (arn.endsWith("stopped-3")) {
                        return { taskArn: arn, lastStatus: "STOPPED", taskDefinitionArn: capturedDef }
                      }
                      const tags = tc.corruptTag
                        ? [{ key: "smithers:configuration", value: "wrong-fp" }]
                        : capturedTags
                      return {
                        taskArn: arn,
                        lastStatus: "RUNNING",
                        taskDefinitionArn: capturedDef,
                        tags,
                        containers: [
                          {
                            name: "sandbox",
                            managedAgents: [{
                              name: "ExecuteCommandAgent",
                              lastStatus: readyNow ? "RUNNING" : "PENDING"
                            }]
                          }
                        ]
                      }
                    })
                  }
                },
                runTask: async (input) => {
                  capturedTags = input.tags ?? []
                  return { tasks: [{ taskArn: "arn:aws:ecs:us-east-1:123:task/cl/fresh-1", lastStatus: "RUNNING" }] }
                },
                stopTask: async () => ({})
              }

              if (tc.taskDefEnvNoContainer) {
                const badTd = AwsSandbox.make({
                  sdk,
                  region: "us-east-1",
                  cluster: "cl",
                  taskDefinition: "my-td:1",
                  subnets: ["subnet-1"],
                  env: { A: "1" },
                  pollIntervalMs: 0,
                  maxPollAttempts: 2
                })
                const e = yield* Effect.exit(Effect.scoped(badTd.acquire("td-1")))
                expect(Exit.isFailure(e)).toBe(true)
                return true
              }

              const spawner = makeSpawner(() => Effect.succeed(makeSimpleHandle("ok\n", "", 0)))
              const provider = AwsSandbox.make({
                sdk,
                exec: tc.withExec ? { spawner } : undefined,
                region: "us-east-1",
                cluster: "cl",
                image: "alpine:latest",
                taskRoleArn: "arn:aws:iam::123:role/task",
                subnets: ["subnet-1"],
                pollIntervalMs: 0,
                maxPollAttempts: 3
              })

              const key = `adopt-key-${++seq}`
              // Run 1 captures the exact configuration fingerprint tag
              yield* Effect.exit(
                Effect.scoped(
                  Effect.gen(function*() {
                    const s = yield* provider.acquire(key)
                    if (!tc.withExec) {
                      expect(Exit.isFailure(yield* Effect.exit(s.spawn("echo hi", {})))).toBe(true)
                      expect(Exit.isFailure(yield* Effect.exit(s.readFile("/workspace/a")))).toBe(true)
                      expect(Exit.isFailure(yield* Effect.exit(s.writeFile("/workspace/a", encoder.encode("x"))))).toBe(
                        true
                      )
                    }
                  })
                )
              )
              // Run 2 finds the running + stale + stopped tasks and exercises adoption / mismatch / deregister / awaitReady
              firstRun = false
              describeCalls = 0
              yield* Effect.exit(Effect.scoped(provider.acquire(key)))
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
    "JjWorkspaceSandbox (sticky attach/destroy/teardown faults), CloudflareSandbox (sticky attach/destroy/ping), CommandSandbox (piddir/NUL/heartbeat) & linuxFileSystem cover all remaining branches",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          jjCase: Schema.Literals(["attach-ok", "attach-absent", "missing-config-id", "destroy-faults"]),
          cmdCase: Schema.Literals([
            "legacy-fail",
            "not-private",
            "nul-script",
            "hb-restarted",
            "hb-starting",
            "hb-silent"
          ]),
          cfAttachFail: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (tc) =>
            Effect.gen(function*() {
              // 1. JjWorkspaceSandbox sticky mode: attach, destroy, missing workspace-config-id, teardown failure logging
              const wsRoot = freshDir("jj-sticky")
              const created = new Map<string, string>()
              const stubJj = {
                snapshot: () => Effect.succeed({ commitId: "a".repeat(40) }),
                workspaceAdd: (name: string, destination: string) =>
                  Effect.sync(() => {
                    mkdirSync(join(destination, ".jj"), { recursive: true })
                    if (tc.jjCase !== "missing-config-id") {
                      writeFileSync(join(destination, ".jj", "workspace-config-id"), "cfg-1")
                    }
                    created.set(name, destination)
                  }),
                workspaceForget: (name: string) =>
                  tc.jjCase === "destroy-faults"
                    ? Effect.fail(new JjError({ code: "unknown", message: "forget err" }))
                    : Effect.sync(() => {
                      created.delete(name)
                    })
              } as unknown as Jj.Jj

              const jjSticky = JjWorkspaceSandbox.make({
                jj: stubJj,
                workspacesRoot: wsRoot,
                fs: localServices.fs,
                path: localServices.path,
                spawner: localServices.spawner,
                persistence: "sticky",
                git: false
              })

              const jjId = `jjs-${++seq}`
              const acqExit = yield* Effect.exit(
                Effect.scoped(
                  Effect.gen(function*() {
                    const s = yield* jjSticky.acquire(jjId)
                    yield* s.writeFile(`${s.workdir}/f.txt`, encoder.encode("abc"))
                    if (tc.jjCase === "destroy-faults") {
                      // Leave a running process in the lane so destroy kills it
                      yield* s.spawn("sleep 5", {})
                    }
                    return { id: s.id, remoteId: s.remoteId }
                  })
                )
              )
              if (Exit.isSuccess(acqExit) && jjSticky.attach && jjSticky.destroy) {
                if (tc.jjCase === "attach-ok") {
                  yield* Effect.exit(Effect.scoped(jjSticky.attach(acqExit.value)))
                } else if (tc.jjCase === "attach-absent") {
                  const abs = yield* Effect.exit(
                    Effect.scoped(jjSticky.attach({ id: "absent-x", remoteId: `smthrs-${sessionSlug("absent-x")}` }))
                  )
                  expect(Exit.isFailure(abs)).toBe(true)
                }
                yield* Effect.exit(jjSticky.destroy(acqExit.value))
              }

              // 2. CloudflareSandbox sticky attach, destroy, ping & FILE_NOT_FOUND
              const cfBox = {
                exec: async (cmd: string) => {
                  if (cmd === "true" && tc.cfAttachFail) return { stdout: "", stderr: "fail", exitCode: 1 }
                  if (cmd.startsWith("rm -f") && tc.cfAttachFail) return { stdout: "", stderr: "rm err", exitCode: 1 }
                  return { stdout: "ok", stderr: "", exitCode: 0 }
                },
                startProcess: async () => ({
                  id: "p",
                  waitForExit: async () => ({ stdout: "ok", stderr: "", exitCode: 0 }),
                  kill: async () => {
                    if (tc.cfAttachFail) throw new Error("kill fail")
                  }
                }),
                readFile: async () => {
                  const e = new Error("missing")
                  Object.assign(e, { code: "FILE_NOT_FOUND" })
                  throw e
                },
                mkdir: async () => undefined,
                writeFile: async () => undefined,
                destroy: async () => {
                  if (tc.cfAttachFail) throw new Error("destroy fail")
                }
              }
              const cfSticky = CloudflareSandbox.make({
                sdk: {
                  getSandbox: () => cfBox as never,
                  findSandbox: async () => undefined
                },
                binding: {} as never
              })
              const cfId = `cfs-${++seq}`
              const cfInfo = yield* Effect.scoped(
                Effect.gen(function*() {
                  const s = yield* cfSticky.acquire(cfId)
                  yield* Effect.exit(s.readFile(`${s.workdir}/missing.txt`))
                  if (s.ping) yield* Effect.exit(s.ping)
                  if (s.files?.remove) yield* Effect.exit(s.files.remove(`${s.workdir}/x`))
                  return { id: s.id, remoteId: s.remoteId }
                })
              )
              if (cfSticky.attach && cfSticky.destroy) {
                yield* Effect.exit(Effect.scoped(cfSticky.attach(cfInfo)))
                yield* Effect.exit(cfSticky.destroy(cfInfo))
              }

              // 3. CommandSandbox probe -> piddir -> NUL -> heartbeat transitions
              let hbCalls = 0
              const cmdSpawner = makeSpawner((cmd) => {
                const standard = cmd._tag === "StandardCommand" ? cmd : undefined
                const joined = standard ? [standard.command, ...standard.args.map(plainWord)].join(" ") : ""
                if (joined.includes("uname") && joined.includes("id -u")) {
                  return Effect.succeed(makeSimpleHandle("Linux\n1000\nboot-1\n", "", 0))
                }
                if (joined.includes("test -d ")) {
                  return Effect.succeed(makeSimpleHandle("", "", tc.cmdCase === "legacy-fail" ? 2 : 1))
                }
                if (joined.includes("ls -ldn")) {
                  return Effect.succeed(makeSimpleHandle("", "", tc.cmdCase === "not-private" ? 1 : 0))
                }
                if (joined.includes("boot_id") || joined.includes("kill -0")) {
                  hbCalls += 1
                  if (tc.cmdCase === "hb-restarted") return Effect.succeed(makeSimpleHandle("boot-2\n", "", 3))
                  if (tc.cmdCase === "hb-starting") {
                    return Effect.succeed(makeSimpleHandle(hbCalls > 1 ? "boot-2\n" : "boot-1\n", "", 4))
                  }
                  if (tc.cmdCase === "hb-silent") return Effect.succeed(makeSimpleHandle("", "lost", 1))
                  return Effect.succeed(makeSimpleHandle("boot-1\n", "", 0))
                }
                return Effect.succeed(makeSimpleHandle("ok\n", "", 0, tc.cmdCase.startsWith("hb-") ? 35 : 0))
              })
              const cmdSb = CommandSandbox.make(
                {
                  spawner: cmdSpawner,
                  prefix: ["ssh", "box"],
                  workdir: "/workspace",
                  name: "w9-cmd",
                  heartbeatEvery: "5 millis"
                } as Parameters<typeof CommandSandbox.make>[0]
              )
              yield* Effect.exit(
                Effect.scoped(
                  Effect.gen(function*() {
                    const s = yield* cmdSb.acquire(`c-${++seq}`)
                    if (tc.cmdCase === "nul-script") {
                      const nul = yield* Effect.exit(s.spawn("echo \0nope", {}))
                      expect(Exit.isFailure(nul)).toBe(true)
                    } else {
                      const p = yield* s.spawn("sleep 1", {})
                      yield* Effect.exit(p.exitCode)
                    }
                  })
                )
              )
              return true
            }).pipe(Effect.provide(silentLogger)),
          { executions: ioExecutions, seed: seed + 2 }
        )
      )
      assertPassed(report)

      // 4. linuxFileSystem writeFile wx/invalid flag & chown (-1,-1 / invalid / valid) + HttpSandbox tooLarge/404 + RemoteChildProcessSpawner stdin/sink edge cases
      const fsRoot = freshDir("linux-fs")
      const dirSb = DirectorySandbox.make({ fs: localServices.fs, spawner: localServices.spawner, root: fsRoot })
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const s = yield* dirSb.acquire("lfs-1")
            // Strip native fs overrides so Sandbox.fileSystem uses linuxFileSystem probes
            const probeSession: Sandbox.Session = {
              id: s.id,
              remoteId: s.remoteId,
              workdir: s.workdir,
              spawn: s.spawn,
              readFile: s.readFile,
              writeFile: s.writeFile
            }
            const lfs = Sandbox.fileSystem(probeSession)
            const p = `${s.workdir}/wx.txt`
            expect(
              Exit.isFailure(yield* Effect.exit(lfs.writeFile(p, encoder.encode("v1"), { flag: "wx", mode: 0o644 })))
            ).toBe(true)
            yield* lfs.writeFile(p, encoder.encode("v1"))
            yield* Effect.exit(lfs.chown(p, -1, -1))
            const nativeLfs = linuxFileSystem(probeSession, "wave9")
            const p2 = `${s.workdir}/wx2.txt`
            yield* Effect.exit(nativeLfs.writeFile!(p2, encoder.encode("v1"), { flag: "wx", mode: 0o644 }))
            expect(Exit.isFailure(yield* Effect.exit(nativeLfs.writeFile!(p2, encoder.encode("v2"), { flag: "a" }))))
              .toBe(true)
            yield* Effect.exit(nativeLfs.chown!(p2, -1, -1))
            expect(Exit.isFailure(yield* Effect.exit(nativeLfs.chown!(p2, -2, 0)))).toBe(true)
            yield* Effect.exit(nativeLfs.chown!(p2, process.getuid?.() ?? 1000, process.getgid?.() ?? 1000))
          })
        ).pipe(Effect.provide(silentLogger))
      )

      // 5. HttpSandbox tooLarge file read & upload + absent DELETE
      const httpRoot = freshDir("http-boost")
      const baseDir = DirectorySandbox.make({ fs: localServices.fs, spawner: localServices.spawner, root: httpRoot })
      const retProv: Sandbox.Provider = {
        ...baseDir,
        retained: true,
        attach: (sess) =>
          sess.id === "gone"
            ? Effect.fail(new ProviderError({ code: "not_found", message: "absent" }))
            : baseDir.acquire(sess.id),
        destroy: () => Effect.void
      }
      const handler = HttpSandbox.serve({ provider: retProv, token: "t", maxFileBytes: 16, maxRequestBytes: 32 })
      const webClient = HttpClient.make((request) =>
        Effect.gen(function*() {
          const web = yield* Effect.orDie(HttpClientRequest.toWeb(request))
          const resp = yield* handler(web)
          return HttpClientResponse.fromWeb(request, resp)
        })
      )
      const client = HttpSandbox.make({ url: "http://local", token: "t", client: webClient })
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const s = yield* client.acquire("hb-1")
            mkdirSync(s.workdir, { recursive: true })
            writeFileSync(join(s.workdir, "big.bin"), "x".repeat(128))
            const bigRead = yield* Effect.exit(s.readFile(`${s.workdir}/big.bin`))
            expect(Exit.isFailure(bigRead)).toBe(true)
            const delGone = yield* handler(
              new Request("http://local/v1/sessions/gone?id=gone", {
                method: "DELETE",
                headers: { authorization: "Bearer t" }
              })
            )
            expect(delGone.status).toBeLessThan(500)
            const bigUpload = yield* handler(
              new Request(
                `http://local/v1/sessions/${
                  encodeURIComponent(s.remoteId)
                }/uploads/v2?id=${s.id}&path=${s.workdir}/u.bin&offset=0&end=100`,
                {
                  method: "PUT",
                  headers: { authorization: "Bearer t" },
                  body: "a".repeat(100)
                }
              )
            )
            expect(bigUpload.status).toBe(413)
          })
        ).pipe(Effect.provide(silentLogger))
      )

      // 6. RemoteChildProcessSpawner stream stdin on non-stdin provider + stdout/stderr "ignore"
      const noStdin = RemoteChildProcessSpawner.TestRemote.make({
        session: "ns",
        stdin: false,
        scripts: { "echo x": { stdout: "x", exitCode: 0 } }
      })
      const nsLayer = RemoteChildProcessSpawner.layer(noStdin)
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const sp = yield* ChildProcessSpawner
            const badIn = yield* Effect.exit(
              sp.spawn(ChildProcess.make("echo", ["x"], { stdin: { stream: Stream.make(encoder.encode("hi")) } }))
            )
            expect(Exit.isFailure(badIn)).toBe(true)
            const h = yield* sp.spawn(
              ChildProcess.make("echo", ["x"], { stdout: "ignore", stderr: "ignore", shell: true })
            )
            yield* Stream.runDrain(h.stdout)
            yield* Stream.runDrain(h.getOutputFd(4))
            yield* Stream.run(Stream.empty, h.getInputFd(4))
            yield* h.exitCode
          })
        ).pipe(Effect.provide(nsLayer), Effect.provide(silentLogger))
      )

      // ContainerSandbox.existing coverage
      const existSpawner = makeSpawner((cmd) => {
        const standard = cmd._tag === "StandardCommand" ? cmd : undefined
        const args = standard ? standard.args.map(plainWord) : []
        const joined = args.join(" ")
        if (joined.includes("container inspect")) {
          return Effect.succeed(
            makeSimpleHandle(JSON.stringify([{ State: { Running: true }, Config: { WorkingDir: "/app" } }]), "", 0)
          )
        }
        return Effect.succeed(makeSimpleHandle("ok\n", "", 0))
      })
      const existingSession = ContainerSandbox.existing({
        spawner: existSpawner,
        container: "c-exist",
        workdir: "/app",
        transport: { program: "docker", prefix: [] } as never
      })
      await Effect.runPromise(
        Effect.exit(
          Effect.scoped(
            Effect.gen(function*() {
              yield* Effect.exit(existingSession.spawn("echo hi", {}))
              if (existingSession.ping) yield* Effect.exit(existingSession.ping)
            })
          )
        ).pipe(Effect.provide(silentLogger))
      )
    },
    60_000
  )
})
