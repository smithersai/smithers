import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Cause, Duration, Effect, Exit, Fiber, Layer, Schema, type Scope, Stream } from "effect"
import * as ChildProcess from "effect/process/ChildProcess"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as AwsSandbox from "../src/AwsSandbox/index.ts"
import * as CloudflareSandbox from "../src/CloudflareSandbox/index.ts"
import * as CommandSandbox from "../src/CommandSandbox/index.ts"
import * as ContainerSandbox from "../src/ContainerSandbox/index.ts"
import * as JjWorkspaceSandbox from "../src/JjWorkspaceSandbox/index.ts"
import * as KubernetesSandbox from "../src/KubernetesSandbox/index.ts"
import * as MicrosandboxSandbox from "../src/MicrosandboxSandbox/index.ts"
import { JjError } from "@smthrs/jj"
import { platform } from "./helpers/containedPlatform.ts"

const executions = Math.max(1, Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? "10"))

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const formatted = Fuzz.formatReport(report)
  if (formatted !== undefined) throw new Error(formatted)
  expect(report._tag).toBe("Passed")
}

const enc = new TextEncoder()
const tmpDirs: Array<string> = []
const makeTmp = (prefix: string): string => {
  const d = mkdtempSync(nodePath.join(os.tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}

afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // ignore cleanup
    }
  }
})

const makeStubHandle = (
  stdout: string | Uint8Array,
  stderr: string,
  code: number,
  options?: {
    readonly delayMs?: number
    readonly killFail?: boolean
    readonly onKill?: () => void
  }
): ChildProcessSpawner.ChildProcessHandle => {
  const outBytes = typeof stdout === "string" ? enc.encode(stdout) : stdout
  const errBytes = enc.encode(stderr)
  return {
    pid: ChildProcessSpawner.ProcessId(4242),
    unref: Effect.void,
    exitCode: options?.delayMs !== undefined
      ? Effect.sleep(Duration.millis(options.delayMs)).pipe(Effect.as(ChildProcessSpawner.ExitCode(code)))
      : Effect.succeed(ChildProcessSpawner.ExitCode(code)),
    isRunning: Effect.succeed(false),
    kill: () => {
      options?.onKill?.()
      return options?.killFail
        ? Effect.fail({ _tag: "PlatformError", reason: { _tag: "Unknown", description: "kill boom" } } as any)
        : Effect.void
    },
    stdin: { [Symbol.for("effect/Sink")]: true } as any,
    stdout: Stream.make(outBytes),
    stderr: Stream.make(errBytes),
    all: Stream.make(outBytes),
    getInputFd: () => ({} as any),
    getOutputFd: () => Stream.empty
  } as unknown as ChildProcessSpawner.ChildProcessHandle
}

const extractCmd = (cmd: ChildProcess.Command): { readonly command: string; readonly args: ReadonlyArray<string> } => {
  const c = cmd as any
  return { command: String(c.command ?? ""), args: Array.isArray(c.args) ? c.args.map(String) : [] }
}

const spawnerOf = (
  handler: (
    command: string,
    args: ReadonlyArray<string>,
    cmd: ChildProcess.Command
  ) => Effect.Effect<ChildProcessSpawner.ChildProcessHandle, any>
): ChildProcessSpawner.ChildProcessSpawner["Service"] =>
  ChildProcessSpawner.make((cmd) => {
    const { command, args } = extractCmd(cmd)
    return handler(command, args, cmd)
  })

describe("Wave9 Final Boost — flows/sandbox deep provider lifecycles", () => {
  it("fuzzes MicrosandboxSandbox revive, nix env, rootDisk, retained attach/destroy", async () => {
    const Case = Schema.Struct({
      mode: Schema.Literals([
        "revive-running-ok",
        "revive-running-transient-then-start",
        "revive-network-replaced",
        "create-non-already-exists",
        "retained-attach-variants",
        "retained-destroy-variants"
      ]),
      detached: Schema.Boolean,
      nixAttr: Schema.Boolean
    })

    const report = await Effect.runPromise(
      Fuzz.run(
        Arbitrary.schema(Case),
        (c) =>
          Effect.gen(function*() {
            let capturedLabels: Record<string, string> = {}
            let capturedConfig: Record<string, unknown> = {}
            let tripTransient = false
            let getStatus = "running"
            let getConfigOverride: string | undefined = undefined
            let getError: unknown = undefined
            let connectFailTransient = false
            let createFailOther = c.mode === "create-non-already-exists"
            const createdNames = new Set<string>()

            const makeExecStream = (stdout = "ok\n", exitCode = 0) => {
              const events: Array<any> = [
                { kind: "stdout", data: enc.encode(stdout) },
                { kind: "exited", code: exitCode }
              ]
              let idx = 0
              return {
                recv: async () => (idx < events.length ? events[idx++] : null),
                sendStdin: async () => {},
                closeStdin: async () => {},
                kill: async () => {},
                wait: async () => ({ code: exitCode })
              }
            }

            const makeVendorSandbox = (name: string): any => ({
              name,
              backendKind: "local",
              fs: () => ({
                mkdir: async () => {},
                write: async () => {},
                read: async () => enc.encode("data"),
                remove: async () => {},
              destroy: async () => {},
                removeDir: async () => {},
                stat: async () => ({ kind: "file", size: 4 }),
                list: async () => []
              }),
              execStreamWith: async (_prog: string, configureBuilder?: (b: any) => any) => {
                const state: any = { args: [], env: {} }
                const b: any = {
                  args: (a: ReadonlyArray<string>) => {
                    state.args = a
                    return b
                  },
                  cwd: () => b,
                  env: (k: string, v: string) => {
                    state.env[k] = v
                    return b
                  },
                  envs: (e: Record<string, string>) => {
                    Object.assign(state.env, e)
                    return b
                  },
                  tty: () => b
                }
                configureBuilder?.(b)
                if (tripTransient && !state.args.includes("true")) {
                  tripTransient = false
                  throw Object.assign(new Error("connection reset by peer"), { code: "ECONNRESET" })
                }
                return makeExecStream("hi\n", 0)
              },
              stop: async () => {},
              kill: async () => {},
              remove: async () => {},
              destroy: async () => {},
              drain: async () => {}
            })

            const makeHandle = (name: string): any => ({
              name,
              status: getStatus,
              configJson: getConfigOverride ?? JSON.stringify({ labels: capturedLabels, ...capturedConfig }),
              connect: async () => {
                if (connectFailTransient) {
                  connectFailTransient = false
                  throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" })
                }
                return makeVendorSandbox(name)
              },
              refresh: async () => ({
                ...makeHandle(name),
                status: "stopped"
              }),
              start: async () => makeVendorSandbox(name),
              startDetached: async () => makeVendorSandbox(name),
              stop: async () => {},
              kill: async () => {},
              remove: async () => {},
              destroy: async () => {}
            })

            const sdk: any = {
              defaultBackendKind: () => "local",
              setDefaultBackend: () => {},
              Sandbox: {
                builder: (name: string) => {
                  const cfg: Record<string, unknown> = {}
                  const b: any = {
                    image: (img: string) => {
                      cfg["image"] = img
                      return b
                    },
                    fromSnapshot: (s: string) => {
                      cfg["snapshot"] = s
                      return b
                    },
                    rootDisk: (m: number) => {
                      cfg["rootDiskMib"] = m
                      return b
                    },
                    cpus: () => b,
                    maxCpus: () => b,
                    memory: () => b,
                    maxMemory: () => b,
                    security: (s: string) => {
                      cfg["security"] = s
                      return b
                    },
                    pullPolicy: () => b,
                    labels: (l: Record<string, string>) => {
                      capturedLabels = { ...l }
                      return b
                    },
                    maxDuration: () => b,
                    idleTimeout: () => b,
                    disableNetwork: () => {
                      cfg["network"] = { enabled: false }
                      return b
                    },
                    network: () => b,
                    ephemeral: () => b,
                    detached: () => b,
                    create: async () => {
                      capturedConfig = cfg
                      if (createFailOther) {
                        throw Object.assign(new Error("disk full"), { code: "diskFull" })
                      }
                      createdNames.add(name)
                      return makeVendorSandbox(name)
                    }
                  }
                  return b
                },
                get: async (name: string) => {
                  if (getError !== undefined) throw getError
                  if (!createdNames.has(name)) throw Object.assign(new Error("not found"), { code: "sandboxNotFound" })
                  return makeHandle(name)
                },
                list: async () => []
              },
              Snapshot: {
                create: async () => ({ id: "snap-1" }),
                remove: async () => {}
              }
            }

            const provider = MicrosandboxSandbox.make({
              sdk,
              image: "alpine:3.20",
              rootDiskMib: 1024,
              persistence: "sticky",
              detached: c.detached,
              environment: c.nixAttr ? { kind: "nix", attr: "dev" } : { kind: "nix" },
              env: { BASE_VAR: "1" },
              collector: { collect: Effect.void, onStart: Effect.void }
            } as any)

            if (c.mode === "create-non-already-exists") {
              const ex = yield* Effect.exit(Effect.scoped(provider.acquire("sess-fail")))
              return Exit.isFailure(ex)
            }

            if (c.mode === "revive-running-ok" || c.mode === "revive-running-transient-then-start" || c.mode === "revive-network-replaced") {
              const res = yield* Effect.exit(
                Effect.scoped(
                  Effect.gen(function*() {
                    const sess = yield* provider.acquire("sess-revive")
                    // 1st spawn succeeds (also tests filterDefined env with undefined)
                    const p1 = yield* sess.spawn("echo ok", { env: { A: "1", B: undefined } })
                    yield* p1.exitCode
                    if (c.mode === "revive-running-transient-then-start") {
                      connectFailTransient = true
                    } else if (c.mode === "revive-network-replaced") {
                      getConfigOverride = JSON.stringify({
                        labels: { ...capturedLabels, "smithers.network": "open" }
                      })
                    }
                    // 2nd spawn fails transiently -> triggers revive!
                    tripTransient = true
                    const p2 = yield* sess.spawn("echo two", {})
                    return yield* p2.exitCode
                  })
                )
              )
              if (c.mode === "revive-network-replaced") return Exit.isFailure(res)
              if (Exit.isFailure(res)) throw new Error("Msb revive failed (" + c.mode + "): " + JSON.stringify(res.cause))
              return true
            }

            const retainedProvider = provider as unknown as { attach: (s: any) => Effect.Effect<any, any, Scope.Scope>; destroy: (s: any) => Effect.Effect<void, any> }
            if (c.mode === "retained-attach-variants") {
              // Acquire once so labels are captured and we know remoteId
              const captured = yield* Effect.scoped(
                Effect.map(provider.acquire("sess-ret"), (s) => ({ id: s.id, remoteId: s.remoteId }))
              )
              // Mismatched identity
              const mismatch = yield* Effect.exit(
                Effect.scoped(retainedProvider.attach({ id: "other", remoteId: captured.remoteId }))
              )
              // sandboxNotFound
              getError = Object.assign(new Error("gone"), { code: "sandboxNotFound" })
              const notFound = yield* Effect.exit(Effect.scoped(retainedProvider.attach(captured)))
              // generic get error
              getError = new Error("rpc boom")
              const rpcErr = yield* Effect.exit(Effect.scoped(retainedProvider.attach(captured)))
              getError = undefined
              // wrong owner label -> verifyRetained refusal
              getConfigOverride = JSON.stringify({ labels: { wrong: "1" } })
              const badLabels = yield* Effect.exit(Effect.scoped(retainedProvider.attach(captured)))
              getConfigOverride = undefined
              // status stopped -> not_found
              getStatus = "stopped"
              const stopped = yield* Effect.exit(Effect.scoped(retainedProvider.attach(captured)))
              // status creating -> unavailable
              getStatus = "creating"
              const creating = yield* Effect.exit(Effect.scoped(retainedProvider.attach(captured)))
              // status running -> succeeds
              getStatus = "running"
              const ok = yield* Effect.exit(Effect.scoped(retainedProvider.attach(captured)))
              const checks = {
                mismatch: Exit.isFailure(mismatch),
                notFound: Exit.isFailure(notFound),
                rpcErr: Exit.isFailure(rpcErr),
                badLabels: Exit.isFailure(badLabels),
                stopped: Exit.isFailure(stopped),
                creating: Exit.isFailure(creating),
                ok: Exit.isSuccess(ok),
                okCause: Exit.isFailure(ok) ? Cause.pretty(ok.cause) : null
              }
              if (!(checks.mismatch && checks.notFound && checks.rpcErr && checks.badLabels && checks.stopped && checks.creating && checks.ok)) {
                throw new Error("msb attach: " + JSON.stringify(checks))
              }
              return true
            }

            // retained-destroy-variants
            const captured = yield* Effect.scoped(
              Effect.map(provider.acquire("sess-dest"), (s) => ({ id: s.id, remoteId: s.remoteId }))
            )
            const badId = yield* Effect.exit(retainedProvider.destroy({ id: "wrong", remoteId: captured.remoteId }))
            getError = Object.assign(new Error("gone"), { code: "sandboxNotFound" })
            const nfOk = yield* Effect.exit(retainedProvider.destroy(captured))
            getError = new Error("boom")
            const errFail = yield* Effect.exit(retainedProvider.destroy(captured))
            getError = undefined
            const okDest = yield* Effect.exit(retainedProvider.destroy(captured))
            if (!(Exit.isFailure(badId) && Exit.isSuccess(nfOk) && Exit.isFailure(errFail) && Exit.isSuccess(okDest))) throw new Error("Msb dest: " + JSON.stringify({ badId: Exit.isFailure(badId), nfOk, errFail: Exit.isFailure(errFail), okDest }))
            return true
          }),
        { executions: Math.min(executions, 24), seed: 9101 }
      )
    )
    assertPassed(report)
  })

  it("fuzzes KubernetesSandbox env manifest injection, HMAC reattach seal, and leftover pod replacement", async () => {
    const Case = Schema.Struct({
      mode: Schema.Literals([
        "env-ok",
        "env-dryrun-fail",
        "env-bad-json",
        "sealed-adopt",
        "unsealed-replace-ok",
        "unsealed-replace-fail",
        "legacy-unsealed-refuse",
        "create-non-conflict-fail"
      ])
    })

    const report = await Effect.runPromise(
      Fuzz.run(
        Arbitrary.schema(Case),
        (c) =>
          Effect.gen(function*() {
            let capturedFingerprint = ""
            let capturedSeal = ""
            let capturedPodName = ""
            let phase: "first" | "second" = "first"
            let createAttempts = 0

            const spawner = spawnerOf((_cmd, args) => {
              const joined = args.join(" ")
              // dry-run render for environment injection
              if (args.includes("--dry-run=client")) {
                const nameIdx = args.indexOf("run")
                const podName = nameIdx >= 0 ? args[nameIdx + 1] ?? "pod" : "pod"
                capturedPodName = podName
                if (c.mode === "env-dryrun-fail") {
                  return Effect.succeed(makeStubHandle("", "dry-run failed", 1))
                }
                if (c.mode === "env-bad-json") {
                  return Effect.succeed(makeStubHandle("{bad-json", "", 0))
                }
                return Effect.succeed(
                  makeStubHandle(
                    JSON.stringify({
                      metadata: { name: podName },
                      spec: {
                        containers: [
                          { name: podName, env: [{ name: "KEEP", value: "1" }, { name: "FOO", value: "old" }] }
                        ]
                      }
                    }),
                    "",
                    0
                  )
                )
              }

              // create -f -
              if (args[0] === "create" && args[1] === "-f") {
                return Effect.succeed(makeStubHandle("pod created", "", 0))
              }

              // kubectl run
              if (args[0] === "run") {
                createAttempts++
                capturedPodName = args[1] ?? capturedPodName
                for (const a of args) {
                  if (a === "--labels") {
                    const next = args[args.indexOf(a) + 1] ?? ""
                    for (const part of next.split(",")) {
                      const [k, v] = part.split("=")
                      if (k === "smithers.dev/sandbox-fingerprint" && v) capturedFingerprint = v
                    }
                  }
                }
                if (c.mode === "create-non-conflict-fail") {
                  return Effect.succeed(makeStubHandle("", "quota exceeded", 1))
                }
                if (phase === "second") {
                  if (createAttempts === 1) {
                    return Effect.succeed(makeStubHandle("", "pods already exists (AlreadyExists)", 1))
                  }
                  if (c.mode === "unsealed-replace-fail") {
                    return Effect.succeed(makeStubHandle("", "recreate conflict", 1))
                  }
                  return Effect.succeed(makeStubHandle("recreated", "", 0))
                }
                return Effect.succeed(makeStubHandle("created", "", 0))
              }

              // kubectl label pod/... seal=...
              if (args[0] === "label") {
                for (const a of args) {
                  if (a.startsWith("smithers.dev/sandbox-seal=")) {
                    capturedSeal = a.slice(a.indexOf("=") + 1)
                  }
                }
                return Effect.succeed(makeStubHandle("labeled", "", 0))
              }

              // kubectl get pod ...
              if (args[0] === "get" && (args[1] === "pod" || args[1]?.startsWith("pod/"))) {
                const podArg = args[1] === "pod" ? (args[2] ?? "") : (args[1] ?? "")
                const isLegacyCheck = phase === "first" && c.mode === "legacy-unsealed-refuse"
                if (args.includes("-o") && joined.includes("jsonpath")) {
                  return Effect.succeed(makeStubHandle("uid-123", "", 0))
                }
                const podName = podArg.replace(/^pod\//, "")
                if (!isLegacyCheck && (phase === "first" || (capturedPodName !== "" && podName !== capturedPodName))) {
                  if (args.includes("--ignore-not-found")) return Effect.succeed(makeStubHandle("", "", 0))
                  return Effect.succeed(makeStubHandle("", "Error from server (NotFound): pods not found", 1))
                }
                const labels: Record<string, string> = {
                  "smithers.dev/sandbox-fingerprint": capturedFingerprint || "fp",
                  ...(c.mode === "sealed-adopt" && capturedSeal ? { "smithers.dev/sandbox-seal": capturedSeal } : {})
                }
                const podJson = {
                  metadata: { name: podName, uid: "uid-123", labels },
                  spec: {
                    containers: [
                      {
                        name: podName,
                        image: "alpine:3.20",
                        workingDir: "/workspace",
                        securityContext: { privileged: false }
                      }
                    ],
                    volumes: []
                  },
                  status: { phase: "Running" }
                }
                return Effect.succeed(makeStubHandle(JSON.stringify(podJson), "", 0))
              }

              // wait / delete / exec
              if (args[0] === "delete") {
                return Effect.succeed(makeStubHandle("deleted", "", c.mode === "env-ok" ? 1 : 0))
              }
              return Effect.succeed(makeStubHandle("ok", "", 0))
            })

            const baseOpts = {
              image: "alpine:3.20",
              spawner,
              reattachKey: "k8s-hmac-secret",
              ...(c.mode.startsWith("env-") ? { env: { FOO: "bar" } } : {})
            }
            const provider = KubernetesSandbox.make(baseOpts as any)

            if (c.mode === "env-ok") {
              const ex = yield* Effect.exit(Effect.scoped(provider.acquire("k8s-env-ok")))
              return Exit.isSuccess(ex)
            }
            if (c.mode === "env-dryrun-fail" || c.mode === "env-bad-json" || c.mode === "create-non-conflict-fail") {
              const ex = yield* Effect.exit(Effect.scoped(provider.acquire("k8s-fail")))
              return Exit.isFailure(ex)
            }
            if (c.mode === "legacy-unsealed-refuse") {
              // First acquire to learn fingerprint on another key or same key? We need fingerprint to match!
              // Run once cleanly on normal pod to capture fingerprint, then simulate legacy match.
              phase = "first"
              const probeProvider = KubernetesSandbox.make({
                image: "alpine:3.20",
                spawner: spawnerOf((_cmd, args) => {
                  if (args[0] === "run") {
                    for (const a of args) {
                      if (a === "--labels") {
                    const next = args[args.indexOf(a) + 1] ?? ""
                    for (const part of next.split(",")) {
                      const [k, v] = part.split("=")
                      if (k === "smithers.dev/sandbox-fingerprint" && v) capturedFingerprint = v
                    }
                  }
                    }
                    return Effect.succeed(makeStubHandle("ok", "", 0))
                  }
                  if (args[0] === "get" && args.includes("-o") && args.join(" ").includes("jsonpath")) {
                    return Effect.succeed(makeStubHandle("uid-123", "", 0))
                  }
                  if (args[0] === "get") return Effect.succeed(makeStubHandle("", "", 0))
                  return Effect.succeed(makeStubHandle("ok", "", 0))
                }),
                reattachKey: "k8s-hmac-secret"
              } as any)
              yield* Effect.exit(Effect.scoped(probeProvider.acquire("k8s-legacy")))
              const ex = yield* Effect.exit(Effect.scoped(provider.acquire("k8s-legacy")))
              return Exit.isFailure(ex)
            }

            // First acquire creates fresh pod and captures fingerprint + HMAC seal
            const first = yield* Effect.exit(Effect.scoped(provider.acquire("k8s-reattach")))
            if (Exit.isFailure(first)) throw new Error("K8s first failed: " + JSON.stringify(first.cause))
            // Second acquire triggers AlreadyExists -> inspect -> sealed adopt or unsealed replace
            phase = "second"
            createAttempts = 0
            const second = yield* Effect.exit(Effect.scoped(provider.acquire("k8s-reattach")))
            if (c.mode === "unsealed-replace-fail") return Exit.isFailure(second)
            if (Exit.isFailure(second)) throw new Error("K8s second failed (" + c.mode + "): " + JSON.stringify(second.cause))
            return true
          }),
        { executions: Math.min(executions, 24), seed: 9102 }
      )
    )
    assertPassed(report)
  })

  it("fuzzes ContainerSandbox removal polling, vanished conflict retry, and rm error warning", async () => {
    const Case = Schema.Struct({
      mode: Schema.Literals([
        "removing-then-created",
        "removing-exhausted",
        "vanished-then-created",
        "vanished-twice-fails",
        "rm-spawner-error",
        "bad-inspect-json"
      ])
    })

    const report = await Effect.runPromise(
      Fuzz.run(
        Arbitrary.schema(Case),
        (c) =>
          Effect.gen(function*() {
            let createCalls = 0
            let inspectCalls = 0
            let capturedFp = ""
            const spawner = spawnerOf((_cmd, args) => {
              if (args[0] === "create") {
                createCalls++
                for (let i = 0; i < args.length - 1; i++) {
                  if (args[i] === "--label" && args[i + 1]?.includes("fingerprint=")) {
                    capturedFp = args[i + 1]!.split("=")[1] ?? ""
                  }
                }
                if (c.mode === "rm-spawner-error") return Effect.succeed(makeStubHandle("cid", "", 0))
                if (c.mode === "removing-then-created" && createCalls >= 2) {
                  return Effect.succeed(makeStubHandle("cid", "", 0))
                }
                if (c.mode === "vanished-then-created" && createCalls >= 2) {
                  return Effect.succeed(makeStubHandle("cid", "", 0))
                }
                return Effect.succeed(makeStubHandle("", "name already in use", 1))
              }
              if (args[0] === "container" && args[1] === "inspect") {
                inspectCalls++
                // First inspect is legacy check -> not found
                if (inspectCalls === 1) return Effect.succeed(makeStubHandle("", "No such container", 1))
                if (c.mode === "bad-inspect-json") {
                  return Effect.succeed(makeStubHandle("not-json", "", 0))
                }
                if (c.mode === "vanished-then-created" || c.mode === "vanished-twice-fails") {
                  return Effect.succeed(makeStubHandle("", "gone", 1))
                }
                if (c.mode === "removing-then-created") {
                  if (inspectCalls === 2) {
                    return Effect.succeed(
                      makeStubHandle(
                        JSON.stringify([
                          {
                            State: { Status: "removing" },
                            Config: {
                              Image: "alpine:3.20",
                              WorkingDir: "/workspace",
                              Labels: { "smithers.sandbox.fingerprint": capturedFp }
                            },
                            HostConfig: { NetworkMode: "none", Privileged: false, Binds: [] },
                            Mounts: []
                          }
                        ]),
                        "",
                        0
                      )
                    )
                  }
                  return Effect.succeed(makeStubHandle("", "gone", 1))
                }
                if (c.mode === "removing-exhausted") {
                  // Alternate removing (on attempt inspect) then gone (on awaitRemoval poll 0) so each of 5 attempts finishes in 0ms!
                  if (inspectCalls % 2 === 0) {
                    return Effect.succeed(
                      makeStubHandle(
                        JSON.stringify([
                          {
                            State: { Status: "removing" },
                            Config: {
                              Image: "alpine:3.20",
                              WorkingDir: "/workspace",
                              Labels: { "smithers.sandbox.fingerprint": capturedFp }
                            },
                            HostConfig: { NetworkMode: "none", Privileged: false, Binds: [] },
                            Mounts: []
                          }
                        ]),
                        "",
                        0
                      )
                    )
                  }
                  return Effect.succeed(makeStubHandle("", "gone", 1))
                }
                return Effect.succeed(makeStubHandle("", "gone", 1))
              }
              if (args[0] === "rm") {
                if (c.mode === "rm-spawner-error") {
                  return Effect.fail({ _tag: "PlatformError", reason: { _tag: "Unknown", description: "rm fail" } } as any)
                }
                return Effect.succeed(makeStubHandle("", "", 0))
              }
              return Effect.succeed(makeStubHandle("ok", "", 0))
            })

            const provider = ContainerSandbox.make({
              program: "docker",
              image: "alpine:3.20",
              spawner
            })

            const ex = yield* Effect.exit(Effect.scoped(provider.acquire("ctr-key")))
            if (
              c.mode === "removing-then-created" ||
              c.mode === "vanished-then-created" ||
              c.mode === "rm-spawner-error"
            ) {
              return Exit.isSuccess(ex)
            }
            return Exit.isFailure(ex)
          }),
        { executions: Math.min(executions, 8), seed: 9103 }
      )
    )
    assertPassed(report)
  })

  it("fuzzes AwsSandbox leftover task adoption, duplicate stopping, and foreign task refusal", async () => {
    const Case = Schema.Struct({
      mode: Schema.Literals(["adopt-ready", "adopt-provisioning-with-stale", "foreign-task-refused", "all-stopped"]),
      useImage: Schema.Boolean
    })

    const report = await Effect.runPromise(
      Fuzz.run(
        Arbitrary.schema(Case),
        (c) =>
          Effect.gen(function*() {
            let capturedStartedBy = ""
            let capturedDefArn = ""
            let capturedTags: ReadonlyArray<{ key?: string; value?: string }> = []
            let phase: "seed" | "adopt" = "seed"
            let readyPolls = 0
            const stoppedArns: Array<string> = []

            const sdk: any = {
              registerTaskDefinition: async (input: any) => ({
                taskDefinition: { taskDefinitionArn: `arn:aws:ecs:us-east-1:123:task-definition/${input.family}:1` }
              }),
              listTaskDefinitions: async () => ({
                taskDefinitionArns: capturedDefArn ? [capturedDefArn, `${capturedDefArn.replace(/:1$/, ":0")}`] : []
              }),
              deregisterTaskDefinition: async () => ({}),
              runTask: async (input: any) => {
                capturedStartedBy = input.startedBy
                capturedDefArn = input.taskDefinition
                capturedTags = input.tags ?? []
                return { tasks: [{ taskArn: "arn:aws:ecs:us-east-1:123:task/c/seed" }] }
              },
              listTasks: async (input: any) => {
                if (phase === "seed" || input.startedBy !== capturedStartedBy) return { taskArns: [] }
                if (c.mode === "all-stopped") {
                  return { taskArns: ["arn:aws:ecs:us-east-1:123:task/c/stopped-1"] }
                }
                if (c.mode === "adopt-provisioning-with-stale") {
                  return {
                    taskArns: [
                      "arn:aws:ecs:us-east-1:123:task/c/a-live",
                      "arn:aws:ecs:us-east-1:123:task/c/b-dup",
                      "arn:aws:ecs:us-east-1:123:task/c/c-stopped"
                    ]
                  }
                }
                return { taskArns: ["arn:aws:ecs:us-east-1:123:task/c/a-live"] }
              },
              describeTasks: async (input: any) => {
                readyPolls++
                const tasks = (input.tasks as Array<string>).map((arn) => {
                  if (arn.includes("stopped")) {
                    return { taskArn: arn, lastStatus: "STOPPED" }
                  }
                  const isReady = phase === "seed" || c.mode !== "adopt-provisioning-with-stale" || readyPolls > 1
                  return {
                    taskArn: arn,
                    taskDefinitionArn: capturedDefArn,
                    startedBy: capturedStartedBy,
                    lastStatus: isReady ? "RUNNING" : "PROVISIONING",
                    enableExecuteCommand: true,
                    tags: c.mode === "foreign-task-refused" ? [] : capturedTags,
                    containers: [
                      {
                        name: "sandbox",
                        lastStatus: isReady ? "RUNNING" : "PENDING",
                        managedAgents: [{ name: "ExecuteCommandAgent", lastStatus: isReady ? "RUNNING" : "PENDING" }]
                      }
                    ]
                  }
                })
                return { tasks }
              },
              stopTask: async (input: any) => {
                stoppedArns.push(input.task)
                return {}
              }
            }

            const spawner = spawnerOf((_cmd, args) => {
              const ci = args.indexOf("--command")
              const remote = ci >= 0 ? (args[ci + 1] ?? "") : ""
              const m = remote.match(/\\n([^%\x27\"]+?)%s__/)
              const out = m ? `Starting session with SessionId: s1\nok\n${m[1]}0__\n` : "ok\n"
              return Effect.succeed(makeStubHandle(out, "", 0))
            })
            const provider = AwsSandbox.make({
              sdk,
              cluster: "test-cluster",
              subnets: ["subnet-1"],
              pollIntervalMs: 0,
              maxPollAttempts: 3,
              exec: { spawner },
              ...(c.useImage
                ? { image: "alpine:3.20" }
                : { taskDefinition: "arn:aws:ecs:us-east-1:123:task-definition/custom:1", container: "sandbox" })
            } as any)

            // Seed pass to capture exact startedBy + fingerprint tag + taskDefinitionArn
            const s1 = yield* Effect.exit(Effect.scoped(provider.acquire("aws-adopt-key")))
            if (Exit.isFailure(s1)) { throw new Error("AWS s1 failed: " + JSON.stringify(s1.cause)) }

            phase = "adopt"
            readyPolls = 0
            const s2 = yield* Effect.exit(Effect.scoped(provider.acquire("aws-adopt-key")))
            if (c.mode === "foreign-task-refused") return Exit.isFailure(s2)
            if (Exit.isFailure(s2)) throw new Error("AWS s2 failed (" + c.mode + "): " + JSON.stringify(s2.cause))
            if (c.mode === "adopt-provisioning-with-stale") {
              if (!stoppedArns.includes("arn:aws:ecs:us-east-1:123:task/c/b-dup")) throw new Error("AWS stale not stopped: " + JSON.stringify(stoppedArns))
              return true
            }
            return true
          }),
        { executions: Math.min(executions, 20), seed: 9104 }
      )
    )
    assertPassed(report)
  })

  it("fuzzes JjWorkspaceSandbox, CommandSandbox, and CloudflareSandbox error & lifecycle edges", async () => {
    const Case = Schema.Struct({
      scenario: Schema.Literals([
        "jj-uncontained",
        "jj-unmigrated-config",
        "jj-sticky-reattach-and-absent-attach",
        "jj-teardown-and-rollback-failures",
        "jj-concurrent-held",
        "cmd-probe-and-piddir-errors",
        "cmd-heartbeat-and-nul",
        "cf-exec-stdin-and-retained"
      ])
    })

    const report = await Effect.runPromise(
      Fuzz.run(
        Arbitrary.schema(Case),
        (c) =>
          Effect.gen(function*() {
            if (c.scenario === "jj-uncontained") {
              const root = makeTmp("wave9-jj-un-")
              const bareSpawner = spawnerOf(() => Effect.succeed(makeStubHandle("", "", 0)))
              const prov = JjWorkspaceSandbox.make({
                workspacesRoot: root,
                git: false,
                spawner: bareSpawner,
                jj: {
                  workspaceAdd: () => Effect.void,
                  workspaceForget: () => Effect.void,
                  currentCommitId: () => Effect.succeed("0".repeat(40))
                } as any,
                fs: {} as any,
                path: {} as any
              } as any)
              const ex = yield* Effect.exit(Effect.scoped(prov.acquire("k")))
              return Exit.isFailure(ex)
            }

            if (
              c.scenario === "jj-unmigrated-config" ||
              c.scenario === "jj-sticky-reattach-and-absent-attach" ||
              c.scenario === "jj-teardown-and-rollback-failures" ||
              c.scenario === "jj-concurrent-held"
            ) {
              const root = makeTmp("wave9-jj-")
              return yield* Effect.gen(function*() {
                const { fs, path, spawner } = yield* Effect.gen(function*() {
                  const ctx = yield* Layer.build(platform)
                  const all = Array.from(ctx.mapUnsafe.values())
                  const fsSvc = all.find((v: any) => typeof v?.readDirectory === "function" && typeof v?.makeDirectory === "function")
                  const pathSvc = all.find((v: any) => typeof v?.join === "function" && typeof v?.resolve === "function")
                  const spawnerSvc = all.find((v: any) => typeof v?.spawn === "function")
                  return { fs: fsSvc, path: pathSvc, spawner: spawnerSvc }
                })

                const reported: Array<unknown> = []
                let failForget = false
                let failAddMode: "none" | "pre" | "post" = "none"
                let failRemove = false

                const wrappedFs = {
                  ...fs,
                  remove: (p: string, opts?: any) =>
                    failRemove
                      ? Effect.fail({ _tag: "PlatformError", reason: { _tag: "Unknown", description: "rm boom" } } as any)
                      : fs.remove(p, opts)
                }

                const jjStub: any = {
                  workspaceAdd: (_wsName: string, destination: string) => {
                    if (failAddMode === "pre") {
                      return Effect.fail(new JjError({ code: "not_installed", command: "workspace add", message: "destination path already exists" }))
                    }
                    mkdirSync(nodePath.join(destination, ".jj"), { recursive: true })
                    if (failAddMode === "post") {
                      return Effect.fail(new JjError({ code: "unknown", command: "workspace add", message: "post-create failure" }))
                    }
                    return Effect.void
                  },
                  workspaceForget: () =>
                    failForget
                      ? Effect.fail(new JjError({ code: "unknown", command: "workspace forget", message: "forget boom" }))
                      : Effect.void,
                  currentCommitId: () => Effect.succeed("a".repeat(40))
                }

                const prov = JjWorkspaceSandbox.make({
                  workspacesRoot: root,
                  git: false,
                  persistence: c.scenario === "jj-sticky-reattach-and-absent-attach" || c.scenario === "jj-unmigrated-config"
                    ? "sticky"
                    : "ephemeral",
                  spawner,
                  fs: wrappedFs,
                  path,
                  jj: jjStub,
                  onTeardownFailure: (f: unknown) =>
                    Effect.sync(() => {
                      reported.push(f)
                    })
                } as any)

                if (c.scenario === "jj-unmigrated-config") {
                  // Create sticky session, drop unmigrated .jj/workspace-config.toml, re-acquire -> fails
                  const created = yield* Effect.scoped(
                    Effect.map(prov.acquire("cfg-key"), (s) => ({ id: s.id, remoteId: s.remoteId, workdir: s.workdir }))
                  )
                  writeFileSync(nodePath.join(created.workdir, ".jj", "workspace-config.toml"), "a = 1\n")
                  const ex = yield* Effect.exit(Effect.scoped(prov.acquire("cfg-key")))
                  return Exit.isFailure(ex)
                }

                if (c.scenario === "jj-sticky-reattach-and-absent-attach") {
                  const s1 = yield* Effect.scoped(
                    Effect.map(prov.acquire("sticky-k"), (s) => ({ id: s.id, remoteId: s.remoteId }))
                  )
                  // Re-acquire existing sticky dir
                  const s2 = yield* Effect.exit(Effect.scoped(prov.acquire("sticky-k")))
                  // Attach absent workspace
                  const absent = yield* Effect.exit(Effect.scoped(((prov as any).attach({ id: "missing", remoteId: "ws-missing" }) as Effect.Effect<unknown, unknown, Scope.Scope>)))
                  // Attach existing workspace
                  const attached = yield* Effect.exit(Effect.scoped(((prov as any).attach(s1) as Effect.Effect<unknown, unknown, Scope.Scope>)))
                  return Exit.isSuccess(s2) && Exit.isFailure(absent) && Exit.isSuccess(attached)
                }

                if (c.scenario === "jj-concurrent-held") {
                  return yield* Effect.scoped(
                    Effect.gen(function*() {
                      yield* prov.acquire("held-k")
                      const second = yield* Effect.exit(prov.acquire("held-k"))
                      return Exit.isFailure(second)
                    })
                  )
                }

                // jj-teardown-and-rollback-failures
                failAddMode = "pre"
                const preFail = yield* Effect.exit(Effect.scoped(prov.acquire("rb-pre")))
                failAddMode = "post"
                failForget = true
                failRemove = true
                const postFail = yield* Effect.exit(Effect.scoped(prov.acquire("rb-post")))
                failAddMode = "none"
                const teardownRun = yield* Effect.exit(Effect.scoped(prov.acquire("td-fail")))
                if (!(Exit.isFailure(preFail) && Exit.isFailure(postFail) && Exit.isSuccess(teardownRun) && reported.length >= 2)) throw new Error("jj teardown: " + JSON.stringify({ preFail: Exit.isFailure(preFail), postFail: Exit.isFailure(postFail), teardownRun: Exit.isSuccess(teardownRun), reportedLen: reported.length, tdCause: Exit.isFailure(teardownRun) ? Cause.pretty(teardownRun.cause) : null }))
                return true
              }).pipe(Effect.scoped)
            }

            if (c.scenario === "cmd-probe-and-piddir-errors") {
              // 1. probe exits non-zero
              const p1 = CommandSandbox.make({
                prefix: ["fake-ssh", "host"],
                workdir: "/workspace",
                spawner: spawnerOf(() => Effect.succeed(makeStubHandle("", "ssh refused", 255)))
              })
              const r1 = yield* Effect.exit(Effect.scoped(p1.acquire("c1")))
              // 2. legacy piddir returns exit 2
              let step = 0
              const p2 = CommandSandbox.make({
                prefix: ["fake-ssh", "host"],
                workdir: "/workspace",
                spawner: spawnerOf(() => {
                  step++
                  if (step === 1) return Effect.succeed(makeStubHandle("Linux\n1000\nboot-a\n", "", 0))
                  return Effect.succeed(makeStubHandle("", "err", 2))
                })
              })
              const r2 = yield* Effect.exit(Effect.scoped(p2.acquire("c2")))
              // 3. ownPids exits 1
              let step3 = 0
              const p3 = CommandSandbox.make({
                prefix: ["fake-ssh", "host"],
                workdir: "/workspace",
                spawner: spawnerOf(() => {
                  step3++
                  if (step3 === 1) return Effect.succeed(makeStubHandle("Linux\n1000\nboot-a\n", "", 0))
                  if (step3 === 2) return Effect.succeed(makeStubHandle("", "", 1))
                  return Effect.succeed(makeStubHandle("", "not private", 1))
                })
              })
              const r3 = yield* Effect.exit(Effect.scoped(p3.acquire("c3")))
              return Exit.isFailure(r1) && Exit.isFailure(r2) && Exit.isFailure(r3)
            }

            if (c.scenario === "cmd-heartbeat-and-nul") {
              let call = 0
              let hbCall = 0
              const p = CommandSandbox.make({
                prefix: ["fake-exec"],
                workdir: "/workspace",
                heartbeat: Duration.millis(15),
                spawner: spawnerOf((_cmd, args) => {
                  call++
                  if (call === 1) return Effect.succeed(makeStubHandle("Linux\n1000\nboot-1\n", "", 0))
                  if (call === 2) return Effect.succeed(makeStubHandle("", "", 1))
                  if (call === 3) return Effect.succeed(makeStubHandle("", "", 0))
                  if (call === 4) {
                    // Long-running command waiting on heartbeat
                    return Effect.succeed(makeStubHandle("done\n", "", 0, { delayMs: 250 }))
                  }
                  hbCall++
                  if (hbCall === 1) return Effect.succeed(makeStubHandle("boot-1", "", 4)) // starting
                  if (hbCall === 2) return Effect.succeed(makeStubHandle("boot-1", "", 0)) // alive
                  if (hbCall === 3) return Effect.succeed(makeStubHandle("boot-1", "", 1)) // 1 silent blip
                  return Effect.succeed(makeStubHandle("boot-2", "", 3)) // restarted -> trips lost!
                })
              })
              const res = yield* Effect.exit(
                Effect.scoped(
                  Effect.gen(function*() {
                    const sess = yield* p.acquire("hb-1")
                    // NUL in shell script -> rejected
                    const nulEx = yield* Effect.exit(sess.spawn("echo a\0b", {}))
                    // Spawn command whose exit races heartbeat restart
                    const h = yield* sess.spawn("sleep 1", {})
                    const codeEx = yield* Effect.exit(h.exitCode)
                    if (!Exit.isFailure(nulEx)) throw new Error("expected nulEx failure")
                    if (!Exit.isFailure(codeEx)) throw new Error("expected codeEx failure, got " + JSON.stringify(codeEx))
                    return true
                  })
                )
              )
              return Exit.isFailure(res) || res.value
            }

            // cf-exec-stdin-and-retained
            let rmExitCode = 0
            let killCalled = false
            const makeCfSandbox = () => ({
              exec: async (cmd: string) => {
                if (cmd.startsWith("rm -f ")) return { stdout: "", stderr: "", exitCode: rmExitCode }
                return { stdout: "exec-ok", stderr: "", exitCode: 0 }
              },
              startProcess: async () => ({
                exitCode: undefined,
                waitForExit: async () => new Promise((resolve) => setTimeout(() => resolve({ exitCode: 0 }), 120)),
                getLogs: async () => ({ stdout: "proc-out", stderr: "" }),
                kill: async () => {
                  killCalled = true
                  throw new Error("kill warn")
                }
              }),
              writeFile: async () => {},
              readFile: async () => ({ content: "abc", encoding: "utf-8" }),
              deleteFile: async () => {},
              mkdir: async () => {},
              destroy: async () => {}
            })

            const cfExec = CloudflareSandbox.make({
              binding: {} as any,
              execution: "exec",
              sdk: {
                execSupportsCancellation: true,
                getSandbox: () => makeCfSandbox()
              }
            } as any)

            const execRes = yield* Effect.scoped(
              Effect.gen(function*() {
                const s = yield* cfExec.acquire("cf-exec")
                // With stdin to trigger stdinRedirect + removeFile (exit 0)
                const h1 = yield* s.spawn("cat", { stdin: enc.encode("hello") })
                const c1 = yield* h1.exitCode
                rmExitCode = 1
                const h2 = yield* Effect.exit(s.spawn("cat", { stdin: enc.encode("hello2") }))
                return c1 === 0 && Exit.isSuccess(h2)
              })
            )

            const cfRetained = CloudflareSandbox.make({
              binding: {} as any,
              retained: true,
              sdk: {
                getSandbox: () => makeCfSandbox()
              }
            } as any)

            const retInfo = yield* Effect.scoped(
              Effect.gen(function*() {
                const s = yield* cfRetained.acquire("cf-ret")
                // Start process and interrupt immediately to trigger stop -> started.kill() warning
                const f = yield* Effect.forkChild(
                  Effect.scoped(s.spawn("sleep 5", {}))
                )
                yield* Effect.sleep(Duration.millis(20))
                yield* Fiber.interrupt(f)
                return { id: s.id, remoteId: s.remoteId }
              })
            )
            const attEx = yield* Effect.exit(Effect.scoped(((cfRetained as any).attach(retInfo) as Effect.Effect<unknown, unknown, Scope.Scope>)))
            const desEx = yield* Effect.exit(((cfRetained as any).destroy(retInfo) as Effect.Effect<unknown, unknown>))
            return execRes && Exit.isSuccess(attEx) && Exit.isSuccess(desEx) && killCalled
          }),
        { executions: Math.min(executions, 24), seed: 9105 }
      )
    )
    assertPassed(report)
  })
})
