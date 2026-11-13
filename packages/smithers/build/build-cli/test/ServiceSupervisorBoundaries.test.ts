/**
 * ServiceSupervisor boundaries the lifecycle suite does not reach:
 *
 * 1. Spec validation refuses every malformed shape without running caller
 *    code, including nested functions, accessors, and class instances that
 *    validation messages would otherwise convert or render.
 * 2. The captured output tail is bounded without splitting a surrogate pair.
 * 3. Hooks and probes are bounded: a flooding hook, a hook killed by a
 *    signal, a hook that cannot start, and a hook that outlives its bound all
 *    fail init with the matching detail.
 * 4. The health loop stops probing once the service has exited, and a dead
 *    service fails later acquisitions immediately.
 * 5. Pipe and status faults of the process boundary, injected through the
 *    `ProcessSpawner` service, fail a live service and are ignored during its
 *    own stop.
 */
import * as ScopedProcess from "@smthrs/platform-node/ScopedProcess"
import * as Secret from "@smthrs/targets/Secret"
import { PlatformError } from "effect"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import * as Fs from "node:fs/promises"
import { createRequire } from "node:module"
import * as NodeNet from "node:net"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import { ProcessSpawner } from "../src/internal/ContainedProcess.ts"
import * as ServiceSupervisor from "../src/ServiceSupervisor.ts"

const fixtureDir = NodePath.resolve(import.meta.dirname, "fixtures/service-supervisor")
const idle = "setInterval(() => {}, 1000)"

const run = <A>(effect: Effect.Effect<A, unknown, never>): Promise<A> =>
  Effect.runPromise(effect as Effect.Effect<A, never, never>)

const acquireFlipped = (spec: unknown): Promise<ServiceSupervisor.ServiceError> =>
  run(Effect.scoped(Effect.gen(function*() {
    const supervisor = yield* ServiceSupervisor.make
    return yield* Effect.flip(supervisor.acquire(spec as ServiceSupervisor.ServiceSpec))
  })))

const waitFor = async (predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`condition not reached within ${timeoutMs}ms`)
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = NodeNet.createServer()
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address() as NodeNet.AddressInfo
      probe.close(() => resolve(address.port))
    })
    probe.on("error", reject)
  })

const scratch = (): Promise<string> => Fs.mkdtemp(NodePath.join(Os.tmpdir(), "service-boundaries-"))

const base = { key: "//x:boundary", cwd: fixtureDir, argv: [process.execPath, "-e", idle] }

describe("spec validation", () => {
  it("names the shape it refuses for every malformed field", async () => {
    const refusal = async (spec: unknown, expected: string): Promise<ServiceSupervisor.ServiceError> => {
      const error = await acquireFlipped(spec)
      expect([expected, error.reason]).toEqual([expected, "invalid-spec"])
      expect(error.message).toContain(expected)
      return error
    }
    const sparse: Array<unknown> = [process.execPath, , "-e"]
    Object.defineProperty(sparse, "tag", { enumerable: true, value: 1 })

    await refusal({ ...base, cwd: new Proxy({}, {}) }, "service spec cwd must not be a proxy")
    await refusal(
      { ...base, argv: Object.setPrototypeOf([process.execPath], null) },
      "service spec argv must be an array"
    )
    await refusal({ ...base, argv: sparse }, "service spec argv must be a dense array without extra properties")
    await refusal({ ...base, env: Object.create({}) }, "service spec env must be a plain object")
    await refusal({ ...base, secrets: [{}] }, "service //x:boundary secrets must contain only secret declarations")
    await refusal(
      { ...base, readiness: { http: "ftp://127.0.0.1/", timeout: "1s" } },
      "readiness.http must be an http(s) URL: \"ftp://127.0.0.1/\""
    )
    await refusal(
      { ...base, readiness: { exec: [], timeout: "1s" } },
      "readiness.exec must be a non-empty argv of strings"
    )
    await refusal(
      { ...base, readiness: { port: 1 }, health: { interval: "1s", failures: 0 } },
      "health.failures must be a positive integer"
    )
  })

  it("reports an unreadable key as <invalid key> and a readable key as itself", async () => {
    for (
      const [spec, message] of [
        [null, "a service spec must be a plain object"],
        [new Proxy({ ...base }, {}), "a service spec must be a plain object"],
        [{ ...base, key: "" }, "a service spec requires a non-empty key"],
        [{ ...base, key: 7 }, "a service spec requires a non-empty key"]
      ] as const
    ) {
      const error = await acquireFlipped(spec)
      expect([error.key, error.reason, error.message]).toEqual(["<invalid key>", "invalid-spec", message])
    }
  })

  it("reports <invalid key> when the spec is a module namespace whose key binding never initialized", async () => {
    const dir = await scratch()
    const module = NodePath.join(dir, "halted.mjs")
    // The module records its own namespace on the failure it throws before
    // `key` initializes, so the binding stays in its temporal dead zone and
    // reading its descriptor throws.
    await Fs.writeFile(
      module,
      [
        "import * as self from './halted.mjs'",
        "throw Object.assign(new Error('halted'), { namespace: self })",
        "export let key = '//x:never'"
      ].join("\n")
    )
    // A synchronous require keeps a real module namespace rather than the
    // test runner's transformed export object.
    let namespace: object | undefined
    try {
      createRequire(import.meta.url)(module)
    } catch (error) {
      namespace = (error as { readonly namespace: object }).namespace
    }
    expect(() => Object.getOwnPropertyDescriptor(namespace, "key")).toThrow(ReferenceError)
    const error = await acquireFlipped(namespace)
    expect([error.key, error.reason, error.message]).toEqual([
      "<invalid key>",
      "invalid-spec",
      "a service spec must not contain symbol properties"
    ])
  })

  it("never runs caller code nested in a field it validates or renders", async () => {
    let calls = 0
    const called = () => {
      calls += 1
      throw "caller code ran"
    }
    const withAccessor = {}
    Object.defineProperty(withAccessor, "port", { enumerable: true, get: called })
    const refusals: ReadonlyArray<readonly [unknown, string]> = [
      // parseDurationMs would call `.trim()` on this timeout.
      [
        { ...base, readiness: { exec: ["true"], timeout: { trim: called } } },
        "readiness.timeout.trim must not be a function"
      ],
      // The cwd refusal renders the value with JSON.stringify, which would call an inherited toJSON.
      [{ ...base, cwd: Object.create({ toJSON: called }) }, "service spec cwd must be plain data"],
      // The signal pattern test would convert this through its own toString.
      [{ ...base, stop: { signal: { toString: called }, grace: "1s" } }, "signal.toString must not be a function"],
      [{ ...base, readiness: { port: withAccessor } }, "readiness.port.port must be an enumerable data property"],
      [{ ...base, readiness: { http: new URL("http://127.0.0.1/"), timeout: "1s" } }, "http must be plain data"],
      [{ ...base, env: { NESTED: [{ deep: called }] } }, "env.NESTED.0.deep must not be a function"]
    ]
    for (const [spec, expected] of refusals) {
      const error = await acquireFlipped(spec)
      expect([expected, calls, error.reason]).toEqual([expected, 0, "invalid-spec"])
      expect(error.message).toContain(expected)
    }
  })

  it("accepts a null-prototype env and passes it to the service unchanged", async () => {
    const env = Object.assign(Object.create(null) as Record<string, string>, { B: "2", A: "1", C: "3" })
    const tail = await run(Effect.scoped(Effect.gen(function*() {
      const supervisor = yield* ServiceSupervisor.make
      const handle = yield* supervisor.acquire({
        ...base,
        key: "//x:null-prototype-env",
        argv: [process.execPath, "-e", `console.log([process.env.A, process.env.B, process.env.C].join(','));${idle}`],
        env,
        stop: { signal: "SIGTERM", grace: "100ms" }
      })
      yield* Effect.promise(() => waitFor(() => handle.outputTail().includes("1,2,3"), 10_000))
      // The same entries in another order are the same identity, not drift.
      yield* supervisor.acquire({
        ...base,
        key: "//x:null-prototype-env",
        argv: [process.execPath, "-e", `console.log([process.env.A, process.env.B, process.env.C].join(','));${idle}`],
        env: { C: "3", A: "1", B: "2" },
        stop: { signal: "SIGTERM", grace: "100ms" }
      })
      return handle.outputTail()
    })))
    expect(tail).toBe("1,2,3\n")
  })
})

describe("output tail", () => {
  const emoji = "\u{1F600}"
  const tailOf = (text: string, marker: string) =>
    run(Effect.scoped(Effect.gen(function*() {
      const supervisor = yield* ServiceSupervisor.make
      const handle = yield* supervisor.acquire({
        ...base,
        key: `//x:tail-${marker}`,
        argv: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(text)});${idle}`],
        stop: { signal: "SIGTERM", grace: "100ms" }
      })
      yield* Effect.promise(() => waitFor(() => handle.outputTail().endsWith(marker), 10_000))
      return handle.outputTail()
    })))

  it("drops the orphaned half when the limit falls inside a surrogate pair", async () => {
    // 1 + 12000 + 3 code units: the cut falls between a high and a low surrogate.
    const tail = await tailOf(`x${emoji.repeat(6_000)}END`, "END")
    expect(tail.length).toBe(ServiceSupervisor.outputTailLimit - 1)
    expect(tail.codePointAt(0)).toBe(0x1f600)
  })

  it("keeps exactly the limit when the cut falls between two pairs", async () => {
    // 1 + 12000 + 4 code units: the cut falls after a low surrogate.
    const tail = await tailOf(`x${emoji.repeat(6_000)}END!`, "END!")
    expect(tail.length).toBe(ServiceSupervisor.outputTailLimit)
    expect(tail.codePointAt(0)).toBe(0x1f600)
  })
})

describe("bounded hooks", () => {
  const initFailure = (init: ReadonlyArray<readonly [string, ...Array<string>]>, timeout = "10s") =>
    acquireFlipped({
      ...base,
      key: "//x:init",
      readiness: { exec: ["true"], timeout },
      stop: { signal: "SIGTERM", grace: "100ms" },
      init
    })

  it("stops reading a hook that floods past 1 MiB instead of waiting for it to exit", async () => {
    const started = Date.now()
    const error = await initFailure([[process.execPath, "-e", `process.stdout.write('f'.repeat(2 << 20));${idle}`]])
    expect(Date.now() - started).toBeLessThan(9_000)
    expect(error.reason).toBe("init-failed")
    const detail = error.message.slice(error.message.lastIndexOf(": ") + 2)
    expect(detail).toMatch(/^f+$/)
    expect(detail.length).toBeLessThanOrEqual((1 << 20) + (64 << 10))
  })

  it("names the signal that killed a silent hook", async () => {
    const error = await initFailure([[process.execPath, "-e", "process.kill(process.pid, 'SIGKILL')"]])
    expect(error.reason).toBe("init-failed")
    expect(error.message).toMatch(/: command terminated by SIGKILL$/)
  })

  it("reports why a hook could not start", async () => {
    const error = await initFailure([["/nonexistent/smthrs-init-hook"]])
    expect(error.reason).toBe("init-failed")
    expect(error.message).toContain("init command failed: /nonexistent/smthrs-init-hook: ")
    expect(error.message).toMatch(/ENOENT|not found|no such file/i)
  })

  it("names the expired bound of a silent hook that never exits", async () => {
    const error = await initFailure([[process.execPath, "-e", idle]], "500ms")
    expect(error.reason).toBe("init-failed")
    expect(error.message).toMatch(/: the command timed out after 500ms$/)
  })
})

describe("probes", () => {
  for (const url of ["http://nonexistent.invalid/", "https://nonexistent.invalid/"]) {
    it(`gives up on an unresolvable ${new URL(url).protocol} readiness URL at its deadline`, async () => {
      const error = await acquireFlipped({
        ...base,
        key: "//x:unresolvable",
        readiness: { http: url, timeout: "1s" },
        stop: { signal: "SIGTERM", grace: "100ms" }
      })
      expect(error.reason).toBe("readiness-timeout")
      expect(error.message).toContain("service //x:unresolvable was not ready within 1000ms")
    })
  }

  it("marks a service unhealthy when its HTTP health probe stops answering", async () => {
    const port = await freePort()
    const server = `let n = 0; require('node:http').createServer((q, s) => { if (n++ === 0) s.end('ok') })` +
      `.listen(${port}, '127.0.0.1')`
    const error = await run(Effect.scoped(Effect.gen(function*() {
      const supervisor = yield* ServiceSupervisor.make
      const handle = yield* supervisor.acquire({
        ...base,
        key: "//x:hanging-health",
        argv: [process.execPath, "-e", server],
        readiness: { http: `http://127.0.0.1:${port}/`, timeout: "10s" },
        health: { interval: "300ms", failures: 1 },
        stop: { signal: "SIGTERM", grace: "100ms" }
      })
      return yield* Effect.flip(handle.whileHealthy(Effect.sleep("20 seconds")))
    })))
    expect(error).toMatchObject({ key: "//x:hanging-health", reason: "unhealthy" })
    expect(error.message).toBe(
      "service //x:hanging-health failed 1 consecutive health probes: the probe timed out after 300ms"
    )
  })
})

describe("secret boundary", () => {
  it("refuses a brokered origin no declared secret is bound to", async () => {
    const error = await acquireFlipped({
      ...base,
      key: "//x:unbound-origin",
      argv: [process.execPath, "-e", idle, Secret.SecretOrigin("http://127.0.0.1:2")],
      secrets: [Secret.HttpSecret(Secret.Secret("UNBOUND_ORIGIN_SECRET"), ["http://127.0.0.1:1"])]
    })
    expect(error).toMatchObject({ key: "//x:unbound-origin", reason: "spawn-failed" })
    expect(error.message).toBe(
      "service //x:unbound-origin secret boundary could not bind a brokered origin: " +
        "no declared secret is bound to http://127.0.0.1:2"
    )
  })
})

describe("health loop after exit", () => {
  /** A counting exec probe; from call `triggerAt` on it also tells the service to exit, then lingers. */
  const probe = (triggerAt: number) =>
    [
      process.execPath,
      "-e",
      "const fs = require('node:fs'); const c = process.env.PROBE_COUNTER;" +
      "const n = (fs.existsSync(c) ? Number(fs.readFileSync(c, 'utf8')) : 0) + 1; fs.writeFileSync(c, String(n));" +
      `if (n >= ${triggerAt}) { fs.writeFileSync(process.env.EXIT_TRIGGER, ''); setTimeout(() => {}, 800) }`
    ] as const
  const service = [
    process.execPath,
    "-e",
    "setInterval(() => { if (require('node:fs').existsSync(process.env.EXIT_TRIGGER)) process.exit(4) }, 20)"
  ] as const
  const probes = async (counter: string) => Number(await Fs.readFile(counter, "utf8"))

  it("stops probing once the service exits while the loop sleeps, and fails later acquisitions at once", async () => {
    const dir = await scratch()
    const env = { PROBE_COUNTER: NodePath.join(dir, "count"), EXIT_TRIGGER: NodePath.join(dir, "exit") }
    const spec: ServiceSupervisor.ServiceSpec = {
      key: "//x:exit-while-sleeping",
      cwd: dir,
      argv: [...service],
      env,
      readiness: { exec: [...probe(Number.MAX_SAFE_INTEGER)], timeout: "10s" },
      health: { interval: "1s" },
      stop: { signal: "SIGTERM", grace: "100ms" }
    }
    const [first, second, before, after] = await run(Effect.scoped(Effect.gen(function*() {
      const supervisor = yield* ServiceSupervisor.make
      const handle = yield* supervisor.acquire(spec)
      yield* Effect.promise(() => Fs.writeFile(env.EXIT_TRIGGER, ""))
      const first = yield* Effect.flip(handle.whileHealthy(Effect.sleep("20 seconds")))
      const before = yield* Effect.promise(() => probes(env.PROBE_COUNTER))
      // The loop wakes inside this window and finds the service already gone.
      yield* Effect.sleep("1500 millis")
      const after = yield* Effect.promise(() => probes(env.PROBE_COUNTER))
      const second = yield* Effect.flip(supervisor.acquire(spec))
      return [first, second, before, after] as const
    })))
    expect(first).toMatchObject({
      reason: "exited",
      message: "service //x:exit-while-sleeping exited with code 4 while supervised"
    })
    expect(second).toEqual(first)
    expect(after).toBe(before)
  })

  it("discards the result of a probe that was running when the service exited", async () => {
    const dir = await scratch()
    const env = { PROBE_COUNTER: NodePath.join(dir, "count"), EXIT_TRIGGER: NodePath.join(dir, "exit") }
    const [error, count] = await run(Effect.scoped(Effect.gen(function*() {
      const supervisor = yield* ServiceSupervisor.make
      const handle = yield* supervisor.acquire({
        key: "//x:exit-while-probing",
        cwd: dir,
        argv: [...service],
        env,
        readiness: { exec: [...probe(2)], timeout: "10s" },
        health: { interval: "300ms", failures: 1 },
        stop: { signal: "SIGTERM", grace: "100ms" }
      })
      const error = yield* Effect.flip(handle.whileHealthy(Effect.sleep("20 seconds")))
      // Outlive the lingering probe and one more interval.
      yield* Effect.sleep("1500 millis")
      return [error, yield* Effect.promise(() => probes(env.PROBE_COUNTER))] as const
    })))
    expect(error).toMatchObject({
      reason: "exited",
      message: "service //x:exit-while-probing exited with code 4 while supervised"
    })
    expect(count).toBe(2)
  })
})

describe("process boundary faults", () => {
  const marker = "service-boundary-fault-target"
  const platformFault = (method: string, message: string) =>
    PlatformError.systemError({ _tag: "Unknown", module: "ChildProcess", method, cause: new Error(message) })
  /** Delegates to the real process owner, rewriting the handle of the service process only. */
  const rewriting = (rewrite: (handle: ScopedProcess.Handle) => ScopedProcess.Handle) => ({
    spawn: (options: ScopedProcess.Options) =>
      ScopedProcess.spawn(options).pipe(
        Effect.map((handle) => options.args?.includes(marker) === true ? rewrite(handle) : handle)
      )
  })
  const spec: ServiceSupervisor.ServiceSpec = {
    ...base,
    key: "//x:faulty-boundary",
    argv: [process.execPath, "-e", idle, marker],
    stop: { signal: "SIGTERM", grace: "100ms" }
  }
  const flippedUnder = (spawner: { readonly spawn: typeof ScopedProcess.spawn }, target = spec) =>
    run(
      Effect.scoped(Effect.gen(function*() {
        const supervisor = yield* ServiceSupervisor.make
        return yield* Effect.flip(supervisor.acquire(target))
      })).pipe(Effect.provideService(ProcessSpawner, spawner))
    )

  it("fails a live service whose output pipe breaks, naming the native cause", async () => {
    const error = await flippedUnder(rewriting((handle) => ({
      ...handle,
      stdout: Stream.fail(platformFault("stdout", "stdout pipe broke"))
    })))
    expect(error).toMatchObject({
      reason: "exited",
      message: "service //x:faulty-boundary output could not be read: stdout pipe broke"
    })
  })

  it("fails a live service whose exit status cannot be observed", async () => {
    const error = await flippedUnder(rewriting((handle) => ({
      ...handle,
      exitCode: Effect.fail(platformFault("exitCode", "status channel closed"))
    })))
    expect(error).toMatchObject({
      reason: "exited",
      message: "service //x:faulty-boundary could not be observed: status channel closed"
    })
  })

  it("ignores pipe and status faults raised by the service's own stop", async () => {
    const result = await run(
      Effect.scoped(Effect.gen(function*() {
        const supervisor = yield* ServiceSupervisor.make
        const handle = yield* supervisor.acquire(spec)
        return yield* handle.whileHealthy(Effect.succeed("consumer finished"))
      })).pipe(Effect.provideService(
        ProcessSpawner,
        rewriting((handle) => ({
          ...handle,
          // Both faults surface only once the stop has ended the process.
          stdout: handle.stdout.pipe(Stream.concat(Stream.fail(platformFault("stdout", "closed by stop")))),
          exitCode: handle.exitCode.pipe(Effect.andThen(Effect.fail(platformFault("exitCode", "closed by stop"))))
        }))
      ))
    )
    expect(result).toBe("consumer finished")
  })

  it("reports a failed init hook without a detail when the native cause has no message", async () => {
    const hook = "/smthrs/faulty-init-hook"
    const error = await flippedUnder({
      spawn: (options) =>
        options.command === hook
          ? Effect.fail(platformFault("spawn", ""))
          : ScopedProcess.spawn(options)
    }, { ...spec, readiness: { exec: ["true"], timeout: "10s" }, init: [[hook, "--flag"]] })
    expect(error).toMatchObject({
      reason: "init-failed",
      message: "service //x:faulty-boundary init command failed: /smthrs/faulty-init-hook --flag"
    })
  })
})
