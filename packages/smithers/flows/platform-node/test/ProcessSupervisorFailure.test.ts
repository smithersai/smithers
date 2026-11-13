import { describe, expect, it } from "@effect/vitest"
import * as ContainedSpawner from "@smthrs/kernel/ContainedSpawner"
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import { Cause, Effect, Exit, Fiber, Layer, Sink, Stream } from "effect"
import type * as PlatformError from "effect/PlatformError"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner, ExitCode, make, makeHandle, ProcessId } from "effect/process/ChildProcessSpawner"
import * as Redacted from "effect/Redacted"
import { once } from "node:events"
import * as Fs from "node:fs"
import * as Net from "node:net"
import { parse } from "node:path"
import * as Tls from "node:tls"
import * as Cleanup from "../src/internal/ProcessCleanup.ts"
import * as Supervisor from "../src/internal/ProcessSupervisor.ts"

const promise = <A>() => {
  let resolve!: (value: A) => void
  const promise = new Promise<A>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

const bounded = async <A>(value: Promise<A>): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      value,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("The test peer did not settle")), 2000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

interface Settings {
  readonly platform?: "darwin" | "win32"
  readonly job?: "held-ready" | "held-settlement" | "attach-failure" | "cleanup-failure"
  /** `unconnected`: a live owner too slow to connect before the bound. */
  readonly readiness?: "valid" | "malformed" | "wrong" | "silent" | "absent" | "unconnected"
  /** `silent`: the owner takes `start` and never confirms the target started. */
  readonly started?: "valid" | "silent"
  readonly stop?: "exit" | "ignore" | "open-channel" | "cleanup-error"
  readonly snapshot?: "empty" | "survivor" | "own-group" | "owner" | "unavailable"
  readonly endOnDisconnect?: boolean
  readonly slowDrainingSnapshot?: boolean
  readonly snapshotUnavailableAfterExitMs?: number
  /** A loaded machine: the owner connects, then announces readiness this late. */
  readonly readinessDelayMs?: number
}

/**
 * The real lifecycle talks to a native peer, but no operating-system process
 * owns this handle. The only cleanup effects are observations and recorded
 * calls. In particular, none of these failure cases can signal a numeric pid.
 */
const fixture = (settings: Settings = {}) => {
  const owner = promise<ExitCode>()
  const jobAttached = promise<void>()
  const jobReady = promise<void>()
  const jobSettled = promise<void>()
  let jobCreated = false
  const jobReferences: Array<boolean> = []
  let jobStops = 0
  const accepted = promise<void>()
  let peer: Net.Socket | undefined
  let requestPeer: Net.Socket | undefined
  let ownerDone = false
  let ownerEndedAt = 0
  let referenced = true
  let unrefs = 0
  let rawKills = 0
  let rawFinalizerReferenced: boolean | undefined
  const requests: Array<Record<string, unknown>> = []
  const commands: Array<ChildProcess.StandardCommand> = []
  const paths: Array<string> = []
  const endOwner = () => {
    ownerDone = true
    ownerEndedAt = Date.now()
    owner.resolve(ExitCode(0))
    if (jobCreated && settings.job !== "held-settlement") jobSettled.resolve()
  }
  const services = {
    ...Supervisor.Services.defaultValue(),
    jobExecutable: () => "/trusted/job-helper",
    job: (pid: number, created: unknown, executable: string) => {
      expect(pid).toBe(900_001)
      expect(created).toBe("123456789012345678")
      expect(executable).toBe("/trusted/job-helper")
      if (settings.job === "attach-failure") throw new Error("job attachment refused")
      jobCreated = true
      jobAttached.resolve()
      if (settings.job !== "held-ready") jobReady.resolve()
      return {
        ready: jobReady,
        settled: {
          promise: jobSettled.promise.then(() => {
            if (settings.job === "cleanup-failure") throw new Error("job settlement unavailable")
          })
        },
        stop: () => {
          jobStops++
          endOwner()
          peer?.end()
        },
        reference: (value: boolean) => jobReferences.push(value)
      }
    }
  }
  const send = (message: unknown) => peer?.write(JSON.stringify(message) + "\n")
  let drained = false
  const system: Cleanup.System = {
    platform: settings.platform ?? "darwin",
    snapshot: () => {
      if (ownerDone && settings.slowDrainingSnapshot && !drained) {
        // A synchronous ps can sample a live member, then deliver that stale
        // table after the group drains and the verification deadline expires.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2600)
        drained = true
        return { ownGroup: 900_002, members: [{ pid: 900_003, startedAtMs: 1, zombie: false }] }
      }
      return settings.snapshot === "unavailable" ||
          ownerDone && Date.now() - ownerEndedAt < (settings.snapshotUnavailableAfterExitMs ?? 0) ?
        undefined :
        ({
          ownGroup: settings.snapshot === "own-group" ? 900_001 : 900_002,
          members: settings.snapshot === "survivor"
            ? [{ pid: 900_003, startedAtMs: 1, zombie: false }]
            : settings.snapshot === "owner" && !ownerDone
            ? [{ pid: 900_001, startedAtMs: 1, zombie: false }]
            : []
        })
    },
    // Only the delayed-drain fixture supplies a positive kernel observation.
    vacant: () => drained
  }
  const spawn = (command: ChildProcess.StandardCommand) =>
    Effect.gen(function*() {
      commands.push(command)
      const path = command.args.map(plainWord).at(-2)!
      paths.push(path)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          rawFinalizerReferenced = referenced
          peer?.destroy()
          requestPeer?.destroy()
          endOwner()
        })
      )
      if (settings.readiness === "absent") endOwner()
      else if (settings.readiness === "unconnected") accepted.resolve()
      else {
        yield* Effect.tryPromise({
          try: async () => {
            peer = Supervisor.connectOwner(path, plainEnvironment(command.options.env) ?? {})
            peer.on("error", () => {})
            requestPeer = Supervisor.connectOwner(
              path.replace(/\/s$/, "/r"),
              plainEnvironment(command.options.env) ?? {}
            )
            requestPeer.on("error", () => {})
            requestPeer.once("close", () => {
              if (settings.endOnDisconnect !== false) {
                endOwner()
                peer?.end()
              }
            })
            let buffer = ""
            requestPeer.on("data", (data) => {
              buffer += String(data)
              for (;;) {
                const end = buffer.indexOf("\n")
                if (end < 0) break
                const frame = JSON.parse(buffer.slice(0, end)) as Record<string, unknown>
                buffer = buffer.slice(end + 1)
                requests.push(frame)
                if (frame.type === "start" && settings.started !== "silent") send({ type: "spawned", pid: 900_004 })
                if (frame.type === "stop" && settings.stop !== "ignore") {
                  if (settings.stop === "cleanup-error") {
                    send({ type: "cleanup_error", message: "test escaped child could not be verified" })
                  }
                  send({ type: "cleanup" })
                  endOwner()
                  if (settings.stop !== "open-channel") peer?.end()
                }
              }
            })
            peer.once("close", () => {
              if (settings.endOnDisconnect !== false) endOwner()
            })
            await bounded(Promise.all([once(peer, "connect"), once(requestPeer, "connect")]))
            const connected = peer
            const announce = () => {
              if (settings.readiness === "malformed") connected.write("{invalid}\n")
              else if (settings.readiness !== "silent") {
                send({
                  type: "ready",
                  version: 1,
                  pid: settings.readiness === "wrong" ? 900_005 : 900_001,
                  created: "123456789012345678"
                })
              }
            }
            // The spawn returns at once; only the readiness message is late.
            if (settings.readinessDelayMs === undefined) announce()
            else setTimeout(() => connected.destroyed || announce(), settings.readinessDelayMs)
            accepted.resolve()
          },
          catch: (cause) => Supervisor.failure("spawn", "test peer", cause)
        })
      }
      return makeHandle({
        pid: ProcessId(900_001),
        exitCode: Effect.promise(() => owner.promise),
        isRunning: Effect.sync(() => !ownerDone),
        kill: () =>
          Effect.sync(() => {
            rawKills++
            endOwner()
          }),
        unref: Effect.sync(() => {
          unrefs++
          referenced = false
          return Effect.sync(() => {
            referenced = true
          })
        }),
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty
      })
    })
  return {
    services,
    jobAttached: jobAttached.promise,
    releaseJob: () => jobReady.resolve(),
    releaseSettlement: () => jobSettled.resolve(),
    jobReferences,
    get jobStops() {
      return jobStops
    },
    system,
    spawn,
    paths,
    requests,
    commands,
    exitTarget: () => send({ type: "exit", code: 0, signal: null }),
    announceCleanup: () => send({ type: "cleanup" }),
    get unrefs() {
      return unrefs
    },
    get rawKills() {
      return rawKills
    },
    get rawFinalizerReferenced() {
      return rawFinalizerReferenced
    },
    disconnect: async () => {
      await bounded(accepted.promise)
      const closed = once(peer!, "close")
      peer!.destroy()
      requestPeer?.destroy()
      await bounded(closed)
    },
    dispose: () => {
      peer?.destroy()
      requestPeer?.destroy()
      endOwner()
    }
  }
}

const run = async (
  host: ReturnType<typeof fixture>,
  use: (handle: ReturnType<typeof makeHandle>) => Effect.Effect<unknown, unknown> = () => Effect.void,
  options: ChildProcess.CommandOptions = {},
  startupBudgetMs?: number,
  activationBudgetMs?: number
) => {
  const ledger = await Effect.runPromise(
    ProcessLedger.makeMemory({ hostId: "failed-supervisor", ownerPid: process.pid })
  )
  const outcome = await Effect.runPromise(
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner
      const handle = yield* spawner.spawn(ChildProcess.make("literal", ["original argument"], {
        forceKillAfter: 0,
        ...options
      }))
      return yield* use(handle)
    }).pipe(
      Effect.provide(ContainedSpawner.layer({ platform: host.system.platform }, Cleanup.lifecycle(host.system))),
      Effect.provide(
        Layer.succeed(ChildProcessSpawner)(make((command) =>
          command._tag === "StandardCommand"
            ? host.spawn(command)
            : Effect.die("the lifecycle must prepare one standard owner")
        ))
      ),
      Effect.provideService(ProcessLedger.ProcessLedger, ledger),
      Effect.provideService(Supervisor.Services, host.services),
      startupBudgetMs === undefined
        ? (effect) => effect
        : Effect.provideService(Supervisor.StartupBudget, startupBudgetMs),
      activationBudgetMs === undefined
        ? (effect) => effect
        : Effect.provideService(Supervisor.ActivationBudget, activationBudgetMs),
      Effect.scoped,
      Effect.exit
    )
  )
  return { outcome, live: await Effect.runPromise(ledger.live) }
}

describe("failed process preparation", () => {
  it.skipIf(process.platform === "win32")(
    "uses private filesystem sockets and refuses a closed request channel",
    async () => {
      const control = new Supervisor.Control()
      try {
        await control.listening
        expect(Fs.statSync(control.directory).mode & 0o777).toBe(0o700)
        expect(Fs.statSync(control.path).isSocket()).toBe(true)
        expect(Fs.statSync(control.requestPath).isSocket()).toBe(true)
        expect(control.environment()).toEqual({})
        const peer = control.connect()
        const requests = control.connect(true)
        await bounded(Promise.all([once(peer, "connect"), once(requests, "connect")]))
        // Real sockets reach the actual control callbacks before write is tested.
        while (control.requestSocket === undefined) await new Promise((resolve) => setTimeout(resolve, 1))
        control.disconnect()
        await expect(control.write({ type: "stop" })).rejects.toMatchObject({ code: "control_channel_closed" })
        peer.destroy()
        requests.destroy()
      } finally {
        control.dispose()
      }
      expect(Fs.existsSync(control.directory)).toBe(false)
    }
  )

  it.each([false, true])("preserves explicit environment values with extendEnv=%s", async (extendEnv) => {
    const host = fixture()
    const name = "SMITHERS_SUPERVISOR_TEST_INHERITED"
    const previous = process.env[name]
    process.env[name] = "from-host"
    try {
      const result = await run(host, undefined, { extendEnv, env: { EXPLICIT: "from-command" } })
      expect(Exit.isSuccess(result.outcome)).toBe(true)
      const env = host.requests.find((request) => request.type === "configure")!.env as Record<string, string>
      expect(env.EXPLICIT).toBe("from-command")
      expect(env[name]).toBe(extendEnv ? "from-host" : undefined)
    } finally {
      if (previous === undefined) delete process.env[name]
      else process.env[name] = previous
      host.dispose()
    }
  })

  it.each(["empty", "survivor", "own-group", "unavailable"] as const)(
    "does not fast-stop a natural exit without an owner-only snapshot (%s)",
    async (snapshot) => {
      const host = fixture({ snapshot })
      try {
        const result = await run(host, (handle) =>
          Effect.gen(function*() {
            host.exitTarget()
            expect(yield* handle.exitCode).toBe(0)
          }))
        expect(host.requests.filter((request) => request.fast === true)).toEqual([])
        expect(Exit.isSuccess(result.outcome)).toBe(snapshot === "empty")
        expect(result.live).toHaveLength(snapshot === "empty" ? 0 : 1)
        expect(host.rawKills).toBe(0)
      } finally {
        host.dispose()
      }
    }
  )

  it("exposes running state and additional pipes while preserving window visibility", async () => {
    const host = fixture()
    try {
      const result = await run(host, (handle) =>
        Effect.gen(function*() {
          expect(yield* handle.isRunning).toBe(true)
          yield* Stream.make(new Uint8Array([1])).pipe(Stream.run(handle.getInputFd(3)))
          expect(yield* handle.getOutputFd(4).pipe(Stream.runCollect)).toEqual([])
          host.exitTarget()
          expect(yield* handle.exitCode).toBe(0)
          expect(yield* handle.isRunning).toBe(false)
        }), { windowsHide: false, additionalFds: { fd3: { type: "input" }, fd4: { type: "output" } } })
      expect(Exit.isSuccess(result.outcome)).toBe(true)
      expect(host.requests.find((request) => request.type === "configure")).toMatchObject({
        windowsHide: false,
        userFds: [3, 4]
      })
      expect(result.live).toEqual([])
    } finally {
      host.dispose()
    }
  })

  it("refuses an unavailable runtime description before allocating or spawning an owner", async () => {
    const cause = new Error("the Node SEA module could not load")
    const host = fixture()
    host.services.runtime = Supervisor.runtimeDescription({ bun: false, main: "" }, () => Promise.reject(cause))
    try {
      const result = await run(host)
      expect(Exit.isFailure(result.outcome)).toBe(true)
      if (Exit.isFailure(result.outcome)) {
        expect(Cause.hasDies(result.outcome.cause)).toBe(false)
        expect(Cause.squash(result.outcome.cause)).toMatchObject({
          _tag: "PlatformError",
          reason: { method: "spawn", cause }
        })
      }
      expect(host.commands).toEqual([])
      expect(host.paths).toEqual([])
      expect(result.live).toEqual([])
    } finally {
      host.dispose()
    }
  })

  it("selects Bun bootstrap flags without changing the target configuration", async () => {
    const host = fixture()
    let imported = false
    host.services.runtime = Supervisor.runtimeDescription({ bun: true, main: "" }, () => {
      imported = true
      return Promise.reject(new Error("Bun must not import Node SEA"))
    })
    try {
      const result = await run(host)
      expect(Exit.isSuccess(result.outcome)).toBe(true)
      expect(host.commands).toHaveLength(1)
      expect(host.commands[0]!.args.slice(0, 3)).toEqual(["--no-env-file", "--config=/dev/null", "-e"])
      expect(host.commands[0]!.options).toMatchObject({
        cwd: parse(process.execPath).root,
        extendEnv: false,
        shell: false
      })
      expect(host.requests.find((frame) => frame.type === "configure")).toMatchObject({
        command: "literal",
        args: ["original argument"]
      })
      expect(result.live).toEqual([])
      expect(imported).toBe(false)
      expect(host.rawKills).toBe(0)
    } finally {
      host.dispose()
    }
  })

  for (const readiness of ["absent", "malformed", "wrong"] as const) {
    it(`refuses ${readiness} owner readiness without activating or leaving a record`, async () => {
      const host = fixture({ readiness })
      try {
        const result = await run(host)
        expect(Exit.isFailure(result.outcome)).toBe(true)
        if (Exit.isFailure(result.outcome)) expect(Cause.hasDies(result.outcome.cause)).toBe(false)
        expect(host.requests.some((frame) => frame.type === "start")).toBe(false)
        expect(result.live).toEqual([])
        expect(host.rawKills).toBe(0)
        for (const path of host.paths) expect(Fs.existsSync(path)).toBe(false)
      } finally {
        host.dispose()
      }
    })
  }

  it("bounds a live owner that never announces readiness and still cleans its preparation", async () => {
    const host = fixture({ readiness: "silent" })
    const started = Date.now()
    try {
      const result = await run(host)
      expect(Exit.isFailure(result.outcome)).toBe(true)
      if (Exit.isFailure(result.outcome)) {
        expect(Cause.hasDies(result.outcome.cause)).toBe(false)
        // A loaded machine starts the owner late; the caller reads a typed
        // timeout it can retry, not an unknown failure.
        const error = Cause.squash(result.outcome.cause) as PlatformError.PlatformError
        expect(error.message).toBe(
          "TimedOut: ChildProcess.spawn (literal): The machine was too busy to start the process within 5 s"
        )
        expect(error.reason).toMatchObject({ _tag: "TimedOut", method: "spawn", cause: { code: "startup_timeout" } })
      }
      expect(Date.now() - started).toBeGreaterThanOrEqual(4900)
      expect(Date.now() - started).toBeLessThan(8000)
      expect(host.requests.map((frame) => frame.type)).toEqual(["stop"])
      expect(result.live).toEqual([])
      expect(host.rawKills).toBe(0)
    } finally {
      host.dispose()
    }
  }, 10_000)

  it("fails an owner that announces readiness after the default 5 s", async () => {
    const host = fixture({ readinessDelayMs: 5600 })
    try {
      const result = await run(host)
      expect(Exit.isFailure(result.outcome)).toBe(true)
      if (Exit.isFailure(result.outcome)) {
        expect((Cause.squash(result.outcome.cause) as PlatformError.PlatformError).message).toContain(
          "too busy to start the process within 5 s"
        )
      }
      expect(result.live).toEqual([])
    } finally {
      host.dispose()
    }
  }, 15_000)

  // A target declared `timeout: "5m"` grants its process minutes; a machine
  // too busy to start the owner within 5 s spends some of them, nothing more.
  it("starts the same late owner inside the budget its caller grants", async () => {
    const host = fixture({ readinessDelayMs: 5600 })
    try {
      const result = await run(host, () => Effect.void, {}, 30_000)
      expect(Exit.isSuccess(result.outcome), String(result.outcome)).toBe(true)
      expect(host.requests.map((frame) => frame.type)).toContain("start")
    } finally {
      host.dispose()
    }
  }, 20_000)

  it("bounds startup by a caller budget shorter than the default", async () => {
    const host = fixture({ readiness: "silent" })
    const started = Date.now()
    try {
      const result = await run(host, () => Effect.void, {}, 400)
      expect(Exit.isFailure(result.outcome)).toBe(true)
      if (Exit.isFailure(result.outcome)) {
        expect((Cause.squash(result.outcome.cause) as PlatformError.PlatformError).message).toContain(
          "too busy to start the process within 0.4 s"
        )
      }
      expect(Date.now() - started).toBeLessThan(4000)
      expect(result.live).toEqual([])
    } finally {
      host.dispose()
    }
  }, 10_000)

  // The busy-machine failure seen in CI: the owner started too slowly to
  // connect within the bound, so it never read the stop it was sent, and
  // cleanup waited it out and failed as a defect instead of the typed miss.
  it("stops an owner that has not connected when its start misses the bound, as a typed miss", async () => {
    const host = fixture({ readiness: "unconnected" })
    const started = Date.now()
    try {
      const result = await run(host, () => Effect.void, {}, 400)
      expect(Exit.isFailure(result.outcome)).toBe(true)
      if (Exit.isFailure(result.outcome)) {
        expect(Cause.hasDies(result.outcome.cause)).toBe(false)
        const error = Cause.squash(result.outcome.cause) as PlatformError.PlatformError
        expect(error.message).toBe(
          "TimedOut: ChildProcess.spawn (literal): The machine was too busy to start the process within 0.4 s"
        )
        expect(error.reason).toMatchObject({ _tag: "TimedOut", cause: { code: "startup_timeout" } })
      }
      expect(Date.now() - started).toBeLessThan(2_000)
      // Nothing was sent: the owner held no target, so it was stopped directly.
      expect(host.requests).toEqual([])
      expect(host.rawKills).toBe(1)
      expect(result.live).toEqual([])
      for (const path of host.paths) expect(Fs.existsSync(path)).toBe(false)
    } finally {
      host.dispose()
    }
  }, 10_000)

  it("reports a miss after activation as activation_timeout, which is no start to retry", async () => {
    const host = fixture({ started: "silent" })
    try {
      const result = await run(host, () => Effect.void, {}, 30_000, 400)
      expect(Exit.isFailure(result.outcome)).toBe(true)
      if (Exit.isFailure(result.outcome)) {
        expect(Cause.hasDies(result.outcome.cause)).toBe(false)
        const error = Cause.squash(result.outcome.cause) as PlatformError.PlatformError
        expect(error.message).toBe(
          "TimedOut: ChildProcess.spawn (literal): " +
            "The machine was too busy to confirm the process started within 0.4 s; it was stopped"
        )
        expect(error.reason).toMatchObject({ _tag: "TimedOut", cause: { code: "activation_timeout" } })
      }
      expect(host.requests.map((frame) => frame.type)).toEqual(["configure", "start", "stop"])
      expect(result.live).toEqual([])
      expect(host.rawKills).toBe(0)
    } finally {
      host.dispose()
    }
  }, 10_000)

  it("refuses excessive private configuration before recording or activating a target", async () => {
    const host = fixture()
    try {
      const result = await run(host, undefined, { env: { LARGE: "x".repeat(4 * 1024 * 1024) } })
      expect(Exit.isFailure(result.outcome)).toBe(true)
      if (Exit.isFailure(result.outcome)) {
        expect(Cause.hasDies(result.outcome.cause)).toBe(false)
        expect(String(result.outcome.cause)).toContain("configuration exceeds")
      }
      expect(host.requests.map((frame) => frame.type)).toEqual(["stop"])
      expect(result.live).toEqual([])
    } finally {
      host.dispose()
    }
  })

  for (const transport of ["native", "tls"] as const) {
    for (const step of ["directory", "permissions", "server", "request-server", "listening"] as const) {
      it.skipIf(process.platform === "win32" && transport === "native")(
        "maps a " + transport + " " + step + " failure into the typed channel and removes any owned directory",
        async () => {
          const cause = Object.assign(new Error(step + " denied"), { code: "EACCES" })
          let directory: string | undefined
          let allocations = 0
          const allocate = <S extends Net.Server>(create: () => S): S => {
            allocations++
            if (step === "server" || step === "request-server" && allocations === 2) throw cause
            const server = create()
            if (step === "listening" && allocations === 1) {
              // Both transports bind a real server to a missing parent.
              const listen = server.listen.bind(server)
              server.listen = ((...args: Array<unknown>) =>
                listen(directory + "/missing/socket", args.at(-1) as () => void)) as typeof server.listen
            }
            return server
          }
          const native: Supervisor.ControlNative = {
            ...Supervisor.controlNative,
            mkdtemp: ((prefix: string) => {
              if (step === "directory") throw cause
              directory = Fs.mkdtempSync(prefix)
              return directory
            }) as typeof Fs.mkdtempSync,
            chmod: (...args) => {
              if (step === "permissions") throw cause
              return Fs.chmodSync(...args)
            },
            server: ((...args: Parameters<typeof Net.createServer>) =>
              allocate(() =>
                Net.createServer(...args)
              )) as typeof Net.createServer,
            tlsServer: ((...args: Parameters<typeof Tls.createServer>) =>
              allocate(() => Tls.createServer(...args))) as typeof Tls.createServer
          }
          let spawned = false
          const outcome = await Effect.runPromise(
            Supervisor.prepare({ platform: "darwin", snapshot: () => undefined, vacant: () => false }, Cleanup.policy)(
              ChildProcess.make("literal"),
              () =>
                Effect.sync(() => {
                  spawned = true
                }).pipe(Effect.andThen(Effect.die("raw spawn must not run")))
            ).pipe(
              Effect.provideService(Supervisor.Services, {
                ...Supervisor.Services.defaultValue(),
                control: (_transport, startup) => new Supervisor.Control(transport, startup, native)
              }),
              Effect.scoped,
              Effect.exit
            )
          )
          expect(Exit.isFailure(outcome)).toBe(true)
          if (Exit.isFailure(outcome)) {
            expect(Cause.hasDies(outcome.cause)).toBe(false)
            const error = Cause.squash(outcome.cause)
            // Containers and native hosts can report either failed path lookup
            // or denied bind access. Both must remain typed and leave no owner.
            if (step === "listening") {
              expect(error).toMatchObject({
                reason: { _tag: expect.stringMatching(/^(NotFound|PermissionDenied)$/), method: "spawn" }
              })
            } else expect(String(outcome.cause)).toContain("PermissionDenied")
          }
          expect(spawned).toBe(false)
          if (directory !== undefined) expect(Fs.existsSync(directory)).toBe(false)
        }
      )
    }
  }
})

describe("unverified cleanup report", () => {
  const control = { fault: undefined, cleanupFailed: false, cleanupAcknowledged: false, targetDone: true }
  it("names the receipt state, the kernel answer and each observed member", () => {
    const snapshot = {
      ownGroup: 700,
      members: [{ pid: 901, startedAtMs: 1, zombie: true }, { pid: 902, startedAtMs: 2, zombie: false }]
    }
    expect(Supervisor.unverifiedCleanup(control, true, false, snapshot)).toBe(
      "target exited: true; cleanup receipt: missing; group vacant: false; group members: 901 zombie, 902 live; host group 700"
    )
    expect(Supervisor.unverifiedCleanup({ ...control, cleanupAcknowledged: true }, true, false, undefined)).toBe(
      "target exited: true; cleanup receipt: acknowledged; group vacant: false; group snapshot: unavailable"
    )
    expect(Supervisor.unverifiedCleanup({ ...control, targetDone: false }, false, true, { ownGroup: 700, members: [] }))
      .toBe(
        "target exited: false; cleanup receipt: not required; group vacant: true; group members: none; host group 700"
      )
  })

  it("reports a failed receipt with its fault, whether an Error, a frame or a string", () => {
    const failed = { ...control, cleanupFailed: true }
    expect(Supervisor.unverifiedCleanup({ ...failed, fault: new Error("escaped child") }, true, false, undefined))
      .toBe(
        "target exited: true; cleanup receipt: failed; group vacant: false; group snapshot: unavailable; fault: escaped child"
      )
    expect(
      Supervisor.unverifiedCleanup({ ...failed, fault: { type: "fault", message: "frame" } }, true, false, undefined)
    )
      .toMatch(/; fault: frame$/)
    expect(Supervisor.unverifiedCleanup({ ...failed, fault: "closed" }, true, false, undefined)).toMatch(
      /; fault: closed$/
    )
  })
})

describe("failed process shutdown", () => {
  it("waits for a real empty-group observation after a transient host probe outage", async () => {
    const host = fixture({ snapshotUnavailableAfterExitMs: 800 })
    try {
      const result = await run(host)
      expect(Exit.isSuccess(result.outcome)).toBe(true)
      expect(result.live).toEqual([])
      expect(host.rawKills).toBe(0)
      expect(host.unrefs).toBe(0)
    } finally {
      host.dispose()
    }
  })

  it("releases an unactivated owner immediately without launching its target or signalling a raw pid", async () => {
    const host = fixture({ snapshot: "owner" })
    try {
      const outcome = await Effect.runPromise(
        Effect.scoped(Effect.gen(function*() {
          const prepared = yield* Supervisor.prepare(host.system, Cleanup.policy)(
            ChildProcess.make("literal", { killSignal: "SIGTERM", forceKillAfter: 500 }),
            host.spawn
          )
          // Preparation can be withdrawn before the ledger accepts the owner.
          // Observe only that owner and request cleanup through its live channel.
          yield* prepared.handle.kill()
          expect(yield* prepared.settled).toBe(true)
        })).pipe(Effect.exit)
      )
      expect(Exit.isSuccess(outcome)).toBe(true)
      expect(host.requests.map((frame) => frame.type)).toEqual(["configure", "stop"])
      expect(host.requests[1]).toMatchObject({ type: "stop", explicit: true, killSignal: "SIGKILL", graceMs: 500 })
      expect(host.rawKills).toBe(0)
      expect(host.unrefs).toBe(0)
      expect(host.rawFinalizerReferenced).toBe(true)
    } finally {
      host.dispose()
    }
  })

  it("disconnects a failed cleanup receipt write and waits for native job settlement", async () => {
    const host = fixture({ platform: "win32" })
    const refused = promise<void>()
    host.services.control = (transport, startup) => {
      const control = new Supervisor.Control(transport, startup)
      const write = control.write.bind(control)
      control.write = (message) => {
        if (typeof message === "object" && message !== null && "type" in message && message.type === "cleanup_ack") {
          refused.resolve()
          return Promise.reject(new Error("the cleanup receipt write failed"))
        }
        return write(message)
      }
      return control
    }
    try {
      const result = await run(host, () =>
        Effect.promise(async () => {
          host.announceCleanup()
          await bounded(refused.promise)
        }))
      expect(Exit.isSuccess(result.outcome)).toBe(true)
      expect(result.live).toEqual([])
      expect(host.rawKills).toBe(0)
    } finally {
      host.dispose()
    }
  })

  it("disconnects after an owner-only natural-exit fast-stop write fails and verifies cleanup", async () => {
    const host = fixture({ snapshot: "owner" })
    const rejected: Array<unknown> = []
    host.services.control = (transport, startup) => {
      const control = new Supervisor.Control(transport, startup)
      const write = control.write.bind(control)
      control.write = (message) => {
        if (typeof message === "object" && message !== null && "fast" in message && message.fast === true) {
          rejected.push(message)
          return Promise.reject(new Error("the fast-stop write failed"))
        }
        return write(message)
      }
      return control
    }
    try {
      const result = await run(host, (handle) =>
        Effect.gen(function*() {
          host.exitTarget()
          expect(yield* handle.exitCode).toBe(0)
        }))
      expect(Exit.isSuccess(result.outcome)).toBe(true)
      expect(rejected).toEqual([{ type: "stop", killSignal: "SIGKILL", fast: true }])
      // The real peer only exits on connection close in this schedule. There
      // was no accepted stop frame and no raw numerical-pid kill fallback.
      expect(host.requests.map((frame) => frame.type)).toEqual(["configure", "start"])
      expect(result.live).toEqual([])
      expect(host.rawKills).toBe(0)
      expect(host.unrefs).toBe(0)
    } finally {
      host.dispose()
    }
  })

  it("uses EOF after a failed stop write and retains an unacknowledged explicit cleanup", async () => {
    const host = fixture()
    try {
      const result = await run(host, (handle) =>
        Effect.gen(function*() {
          yield* Effect.promise(() => host.disconnect())
          yield* handle.kill()
        }))
      expect(Exit.isFailure(result.outcome)).toBe(true)
      expect(host.requests.map((frame) => frame.type)).toEqual(["configure", "start"])
      expect(host.rawKills).toBe(0)
      expect(result.live).toHaveLength(1)
      expect(host.unrefs).toBe(1)
    } finally {
      host.dispose()
    }
  })

  it("bounds an unresponsive owner, retains its record, and disables blind raw cleanup", async () => {
    const host = fixture({ stop: "ignore", endOnDisconnect: false })
    const started = Date.now()
    try {
      const result = await run(host)
      expect(Exit.isFailure(result.outcome)).toBe(true)
      if (Exit.isFailure(result.outcome)) expect(String(result.outcome.cause)).toContain("kill timed out")
      expect(Date.now() - started).toBeLessThan(5000)
      expect(result.live).toHaveLength(1)
      expect(result.live[0]).toMatchObject({
        pid: 900_001,
        pgid: 900_001,
        commandDigest: "literal"
      })
      expect(host.unrefs).toBe(1)
      expect(host.rawFinalizerReferenced).toBe(false)
      expect(host.rawKills).toBe(0)
    } finally {
      host.dispose()
    }
  }, 7000)

  it("rechecks kernel vacancy after a slow snapshot outlives a draining group", async () => {
    const host = fixture({ slowDrainingSnapshot: true })
    try {
      const result = await run(host, (handle) => handle.kill())
      expect(Exit.isSuccess(result.outcome)).toBe(true)
      expect(result.live).toEqual([])
      expect(host.rawKills).toBe(0)
      expect(host.unrefs).toBe(0)
    } finally {
      host.dispose()
    }
  })

  for (const snapshot of ["survivor", "own-group"] as const) {
    it(`retains the record when the owner exits but the observation reports ${snapshot}`, async () => {
      const host = fixture({ snapshot })
      try {
        const result = await run(host)
        expect(Exit.isFailure(result.outcome)).toBe(true)
        if (Exit.isFailure(result.outcome)) {
          expect(String(result.outcome.cause)).toContain("cleanup could not be verified")
          expect(String(result.outcome.cause)).toMatch(/group vacant: false; group members: .*; host group \d+/)
          if (snapshot === "survivor") expect(String(result.outcome.cause)).toContain("900003 live")
        }
        expect(result.live).toHaveLength(1)
        expect(host.unrefs).toBe(1)
        expect(host.rawFinalizerReferenced).toBe(false)
        expect(host.rawKills).toBe(0)
      } finally {
        host.dispose()
      }
    })
  }

  it("retains a reported escaped-child cleanup failure despite an empty original group", async () => {
    const host = fixture({ stop: "cleanup-error" })
    try {
      const result = await run(host)
      expect(Exit.isFailure(result.outcome)).toBe(true)
      expect(result.live).toHaveLength(1)
      expect(host.unrefs).toBe(1)
      expect(host.rawFinalizerReferenced).toBe(false)
    } finally {
      host.dispose()
    }
  })

  it("bounds a status channel left open after verified raw-owner exit", async () => {
    const host = fixture({ stop: "open-channel" })
    const started = Date.now()
    try {
      const result = await run(host)
      expect(Exit.isSuccess(result.outcome)).toBe(true)
      expect(Date.now() - started).toBeLessThan(2000)
      expect(result.live).toEqual([])
      expect(host.unrefs).toBe(0)
      expect(host.rawKills).toBe(0)
    } finally {
      host.dispose()
    }
  })
})

describe("Windows job ownership", () => {
  it("keeps the real job's creation-identity guard before allocating a native child", () => {
    const services = Supervisor.Services.defaultValue()
    expect(() => services.job(process.pid, undefined, process.execPath))
      .toThrow("Windows process owner has no exact creation identity")
  })

  it("completes native settlement after an explicit kill is interrupted", async () => {
    const host = fixture({ platform: "win32", job: "held-settlement" })
    let interruptFinished = false
    const result = await run(host, (handle) =>
      Effect.gen(function*() {
        const killed = yield* handle.kill().pipe(Effect.forkChild({ startImmediately: true }))
        while (!host.requests.some((message) => message.type === "stop")) yield* Effect.sleep(1)
        const interrupted = yield* Fiber.interrupt(killed).pipe(
          Effect.andThen(Effect.sync(() => {
            interruptFinished = true
          })),
          Effect.forkChild({ startImmediately: true })
        )
        yield* Effect.sleep(10)
        expect(interruptFinished).toBe(false)
        host.releaseSettlement()
        yield* Fiber.join(interrupted)
      }))
    expect(interruptFinished).toBe(true)
    expect(Exit.isSuccess(result.outcome)).toBe(true)
    expect(result.live).toEqual([])
    expect(host.requests.filter((message) => message.type === "stop")).toHaveLength(1)
  })

  it("refuses an unavailable native helper before creating an owner", async () => {
    const host = fixture({ platform: "win32" })
    host.services.jobExecutable = () => {
      throw new Error("missing native helper")
    }
    const result = await run(host)
    expect(Exit.isFailure(result.outcome)).toBe(true)
    expect(host.commands).toEqual([])
    expect(result.live).toEqual([])
  })
  it("waits for native job assignment before configuring or activating the target", async () => {
    const host = fixture({ platform: "win32", job: "held-ready" })
    const running = run(host)
    await host.jobAttached
    expect(host.requests).toEqual([])
    expect(host.commands[0]!.options.detached).toBe(false)
    host.releaseJob()
    const result = await running
    expect(Exit.isSuccess(result.outcome)).toBe(true)
    expect(host.requests.map((message) => message.type)).toEqual(["configure", "start", "stop"])
    expect(result.live).toEqual([])
    expect(host.rawKills).toBe(0)
  })

  it("refuses activation when the native job cannot attach", async () => {
    const host = fixture({ platform: "win32", job: "attach-failure" })
    const result = await run(host)
    expect(Exit.isFailure(result.outcome)).toBe(true)
    expect(host.requests.every((message) => message.type === "stop")).toBe(true)
    expect(result.live).toEqual([])
  })

  it("retains the ledger record when native settlement fails", async () => {
    const host = fixture({ platform: "win32", job: "cleanup-failure" })
    const result = await run(host)
    expect(Exit.isFailure(result.outcome)).toBe(true)
    expect(result.live).toHaveLength(1)
    expect(host.jobStops).toBe(1)
    expect(host.jobReferences).toEqual([false])
    expect(host.rawFinalizerReferenced).toBe(false)
  })

  it("forces the job when its Node owner does not answer a stop", async () => {
    const host = fixture({ platform: "win32", stop: "ignore" })
    const result = await run(host)
    expect(Exit.isSuccess(result.outcome)).toBe(true)
    expect(host.jobStops).toBe(1)
    expect(host.rawKills).toBe(0)
    expect(result.live).toEqual([])
  })

  it.each(["darwin", "win32"] as const)(
    "tracks %s references through repeated unref, reref, and explicit stop",
    async (platform) => {
      const host = fixture({ platform })
      const result = await run(host, (handle) =>
        Effect.gen(function*() {
          const reref = yield* handle.unref
          const second = yield* handle.unref
          yield* reref
          yield* second
          yield* Effect.asVoid(handle.unref)
          yield* handle.kill({ killSignal: "SIGINT", forceKillAfter: 0 })
        }))
      expect(Exit.isSuccess(result.outcome)).toBe(true)
      expect(host.jobReferences).toEqual(platform === "win32" ? [false, true, false, true] : [])
      expect(host.requests.at(-1)).toMatchObject({ type: "stop", killSignal: "SIGINT", graceMs: 0 })
      expect(result.live).toEqual([])
    }
  )
})

/** Native test hosts inspect the arguments they actually execute. */
const plainWord = (value: string | Redacted.Redacted<string>): string =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value

const plainEnvironment = (
  values: Readonly<Record<string, string | Redacted.Redacted<string> | undefined>> | undefined
): Record<string, string | undefined> =>
  Object.fromEntries(
    Object.entries(values ?? {}).map(([key, value]) => [key, value === undefined ? undefined : plainWord(value)])
  )
