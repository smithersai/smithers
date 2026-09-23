/**
 * The exec boundary's stream decoding, settlement, and child lifetime.
 *
 * These run real child processes, because what is under test is the behaviour
 * of real pipes: how a code point split across two writes decodes, what a
 * bounded capture keeps, and what happens to a process group when the fiber
 * running it is interrupted. Nothing here sleeps and hopes; each case waits
 * for a fact it can observe.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Exec from "../src/Exec.ts"
import * as Secret from "../src/Secret.ts"

let root: string

const payload = (
  program: string,
  overrides: {
    readonly expectedExitCodes?: ReadonlyArray<number>
    readonly env?: Readonly<Record<string, string>>
    readonly timeoutMs?: number
  } = {}
): Exec.Payload => ({
  cwd: ".",
  argv: [process.execPath, "-e", program],
  env: overrides.env ?? {},
  secrets: [],
  expectedExitCodes: overrides.expectedExitCodes ?? [0],
  timeoutMs: overrides.timeoutMs ?? Exec.defaultTimeoutMs
})

const run = (value: Exec.Payload): Promise<Exit.Exit<Exec.Result, Exec.ExecError>> =>
  Effect.runPromiseExit(Exec.run({ workspaceRoot: root }, value))

const succeeded = async (value: Exec.Payload): Promise<Exec.Result> => {
  const exit = await run(value)
  if (!Exit.isSuccess(exit)) throw new Error(`expected a success: ${JSON.stringify(exit.cause)}`)
  return exit.value
}

const failed = async (value: Exec.Payload): Promise<Exec.ExecError> => {
  const exit = await run(value)
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const rendered = JSON.stringify(exit.cause)
  const parsed = JSON.parse(rendered) as { readonly failures?: ReadonlyArray<{ readonly error: Exec.ExecError }> }
  const error = parsed.failures?.[0]?.error
  if (error === undefined) throw new Error(`expected an ExecError: ${rendered}`)
  return error
}

/** Waits for a predicate to hold, polling rather than guessing a duration. */
const until = async <A>(read: () => Promise<A | undefined>): Promise<A> => {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("timed out waiting for the child to report")
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-exec-streams-")))
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

/**
 * A declared Nix closure replaces the host's executable lookup outright, so
 * the child sees the closure's `PATH` and the variables its tools need rather
 * than whatever the runner happened to export. Asserted against a real child's
 * own view of its environment, because the point is what the process receives.
 */
/**
 * A declared secret never reaches the child. The environment carries a minted
 * placeholder and the loopback proxy that will substitute it on an authorized
 * request, so a tool that dumps its own environment leaks a value that is
 * worthless anywhere else.
 */
describe("a declared secret", () => {
  it("hands the child a placeholder and the proxy endpoint, never the credential", async () => {
    const credential = Secret.HttpSecret(
      Secret.Secret("EXEC_STREAMS_TOKEN", { fallback: "the-real-credential" }),
      ["https://example.test"]
    )
    const exit = await Effect.runPromiseExit(Exec.run({ workspaceRoot: root }, {
      ...payload(
        "process.stdout.write([process.env.EXEC_STREAMS_TOKEN, process.env.HTTP_PROXY, process.env.http_proxy].join(\"\\n\"))"
      ),
      secrets: [credential]
    }))
    if (!Exit.isSuccess(exit)) throw new Error(`expected a success: ${JSON.stringify(exit.cause)}`)
    const [token, upper, lower] = exit.value.stdout.split("\n")
    expect(token).toMatch(new RegExp(`^${Secret.placeholderPrefix}[0-9a-f]{${Secret.placeholderBytes * 2}}$`))
    expect(exit.value.stdout).not.toContain("the-real-credential")
    expect(upper).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/?$/)
    // Tools split on which spelling they read, so both reach a POSIX child.
    expect(lower).toBe(upper)
  })
})

describe("a resolved tool environment", () => {
  const readEnv = (name: string): string =>
    `process.stdout.write(String(process.env[${JSON.stringify(name)}] ?? "<unset>"))`

  it("replaces PATH with the closure's and carries the closure's other variables", async () => {
    const closure = { path: "/closure/bin:/closure/sbin", variables: { SSL_CERT_FILE: "/closure/etc/ca-bundle.crt" } }
    const exit = await Effect.runPromiseExit(Exec.run(
      { workspaceRoot: root, environment: closure },
      payload(`${readEnv("PATH")};process.stdout.write("|");${readEnv("SSL_CERT_FILE")}`)
    ))
    if (!Exit.isSuccess(exit)) throw new Error(`expected a success: ${JSON.stringify(exit.cause)}`)
    expect(exit.value.stdout).toBe("/closure/bin:/closure/sbin|/closure/etc/ca-bundle.crt")
    expect(exit.value.stdout).not.toContain(process.env["PATH"] ?? "\u0000")
  })

  it("lets the payload's own environment win over the closure's variables", async () => {
    const closure = { path: "/closure/bin", variables: { SSL_CERT_FILE: "/closure/etc/ca-bundle.crt" } }
    const declared = payload(readEnv("SSL_CERT_FILE"), { env: { SSL_CERT_FILE: "/declared/ca.pem" } })
    const exit = await Effect.runPromiseExit(Exec.run({ workspaceRoot: root, environment: closure }, declared))
    if (!Exit.isSuccess(exit)) throw new Error(`expected a success: ${JSON.stringify(exit.cause)}`)
    expect(exit.value.stdout).toBe("/declared/ca.pem")
  })

  it("still withholds a sensitive name the closure exports", async () => {
    const closure = { path: "/closure/bin", variables: { SMITHERS_CACHE_TOKEN: "leaked" } }
    const exit = await Effect.runPromiseExit(Exec.run(
      { workspaceRoot: root, environment: closure },
      payload(readEnv("SMITHERS_CACHE_TOKEN"))
    ))
    if (!Exit.isSuccess(exit)) throw new Error(`expected a success: ${JSON.stringify(exit.cause)}`)
    expect(exit.value.stdout).toBe("<unset>")
  })
})

describe("stream decoding", () => {
  /**
   * The regression: each chunk was decoded with `Buffer.toString("utf8")` on
   * its own, so a code point whose bytes landed in two chunks became two
   * replacement characters. Which chunk boundary the kernel chose was not the
   * tool's decision, so one command's captured output differed between runs
   * and a cached result differed from the run that produced it. The decoder is
   * now per stream and holds the partial sequence until the rest arrives.
   */
  it("decodes a code point split across two chunks", async () => {
    const bytes = [...Buffer.from("é☃🙂", "utf8")]
    const result = await succeeded(payload(
      `const b = Buffer.from(${JSON.stringify(bytes)});` +
        // Split inside the first code point, and again inside the last one.
        `process.stdout.write(b.subarray(0, 1));` +
        `setTimeout(() => process.stdout.write(b.subarray(1, 8)), 60);` +
        `setTimeout(() => process.stdout.write(b.subarray(8)), 120);`
    ))

    expect(result.stdout).toBe("é☃🙂")
    expect(result.stdout).not.toContain("�")
  })

  it("decodes stdout and stderr independently", async () => {
    const out = [...Buffer.from("ü", "utf8")]
    const err = [...Buffer.from("ß", "utf8")]
    const result = await succeeded(payload(
      `const o = Buffer.from(${JSON.stringify(out)});` +
        `const e = Buffer.from(${JSON.stringify(err)});` +
        `process.stdout.write(o.subarray(0, 1));` +
        `process.stderr.write(e.subarray(0, 1));` +
        `setTimeout(() => { process.stdout.write(o.subarray(1)); process.stderr.write(e.subarray(1)) }, 60);`
    ))

    expect(result.stdout).toBe("ü")
    expect(result.stderr).toBe("ß")
  })

  it("reports a trailing truncated sequence rather than dropping it", async () => {
    const result = await succeeded(payload(
      `process.stdout.write(Buffer.from([0xe2, 0x98]))`
    ))

    expect(result.stdout).toBe("�")
  })
})

describe("bounded capture", () => {
  it("keeps exactly the output limit and no more", async () => {
    const result = await succeeded(payload(
      `process.stdout.write('a'.repeat(${Exec.outputLimit + 5000}));` +
        `process.stderr.write('b'.repeat(${Exec.outputLimit + 5000}))`
    ))

    expect(result.stdout).toHaveLength(Exec.outputLimit)
    expect(result.stderr).toHaveLength(Exec.outputLimit)
  })

  /**
   * A limit counted in UTF-16 code units can fall between the halves of an
   * astral code point. Cutting there leaves a lone surrogate, which is not
   * text and does not survive the JSON round trip a cache entry makes.
   */
  it("never cuts an astral code point in half", async () => {
    const result = await succeeded(payload(
      `process.stdout.write('a'.repeat(${Exec.outputLimit - 1}) + '\\u{1D4B3}'.repeat(4))`
    ))

    expect(result.stdout).toHaveLength(Exec.outputLimit - 1)
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(result.stdout)).toBe(false)
    expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(result.stdout)).toBe(false)
  })

  it("captures the same prefix when an omitted astral character spans its own chunk", async () => {
    const result = await succeeded(payload(
      `process.stdout.write('a'.repeat(${Exec.outputLimit - 1}));` +
        `setTimeout(() => process.stdout.write('\\u{1D4B3}'), 40);` +
        `setTimeout(() => process.stdout.write('z'), 80);`
    ))

    expect(result.stdout).toBe("a".repeat(Exec.outputLimit - 1))
  })

  it("carries the tail of each stream on a failure, not the head", async () => {
    const error = await failed(payload(
      `process.stdout.write('o'.repeat(10) + 'STDOUT-END');` +
        // Exit from the write's callback: a stream this much larger than the
        // pipe buffer is still draining when the call returns, and exiting
        // before it drains would truncate the tail this case is about.
        `process.stderr.write('e'.repeat(${Exec.stderrTailLimit * 2}) + 'STDERR-END', () => process.exit(3));`
    ))

    expect(error.exitCode).toBe(3)
    expect(error.stdout.endsWith("STDOUT-END")).toBe(true)
    expect(error.stderr.endsWith("STDERR-END")).toBe(true)
    expect(error.stderr.length).toBeLessThanOrEqual(Exec.stderrTailLimit)
  })

  it("keeps an astral code point whole at the tail boundary too", async () => {
    const error = await failed(payload(
      `process.stderr.write('\\u{1D4B3}'.repeat(${Exec.stderrTailLimit}));` +
        `process.exit(1)`
    ))

    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(error.stderr)).toBe(false)
    expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(error.stderr)).toBe(false)
  })
})

describe("exit reporting", () => {
  it("accepts an exit code the payload expects", async () => {
    const result = await succeeded(payload("process.exit(7)", { expectedExitCodes: [0, 7] }))
    expect(result.exitCode).toBe(7)
  })

  it("fails on an exit code the payload does not expect", async () => {
    expect((await failed(payload("process.exit(2)"))).exitCode).toBe(2)
  })

  /**
   * The regression: `close` reported `exitCode ?? -1` and dropped the signal,
   * so a tool the kernel killed was indistinguishable from one that failed to
   * spawn, and a payload that expected -1 would have called it a success.
   */
  it("names the signal that killed the tool", async () => {
    const error = await failed(payload(
      "process.kill(process.pid, 'SIGKILL'); setTimeout(() => {}, 5000)"
    ))

    expect(error.stderr).toContain("terminated by SIGKILL")
  })

  /**
   * The regression: a spawn that fails emits `error` and then `close`, and
   * both resumed the same callback. The second resume is a defect rather than
   * a second answer, so the run reported one failure and then poisoned the
   * fiber with an unrelated one.
   */
  it("settles once when the executable does not exist", async () => {
    const rejections: Array<unknown> = []
    const record = (cause: unknown): void => void rejections.push(cause)
    process.on("unhandledRejection", record)
    try {
      const exit = await Effect.runPromiseExit(Exec.run({ workspaceRoot: root }, {
        cwd: ".",
        argv: ["smthrs-no-such-executable"],
        env: {},
        secrets: [],
        expectedExitCodes: [0],
        timeoutMs: Exec.defaultTimeoutMs
      }))
      // The `close` that follows a failed spawn would resume a second time.
      await new Promise((resolve) => setTimeout(resolve, 100))

      if (Exit.isSuccess(exit)) throw new Error("expected a failure")
      const rendered = JSON.stringify(exit.cause)
      expect(rendered).toContain("ENOENT")
      expect(rendered).not.toContain("Die")
      expect(rejections).toEqual([])
    } finally {
      process.off("unhandledRejection", record)
    }
  })
})

describe("payload and environment boundary", () => {
  it("exposes only the bootstrap environment plus explicitly declared values", async () => {
    const previousSecret = process.env["SMITHERS_EXEC_AMBIENT_SECRET"]
    const previousCache = process.env["SMITHERS_CACHE_TOKEN"]
    process.env["SMITHERS_EXEC_AMBIENT_SECRET"] = "must-not-leak"
    process.env["SMITHERS_CACHE_TOKEN"] = "must-not-leak-either"
    try {
      const result = await succeeded(payload(
        "process.stdout.write(JSON.stringify({" +
          "ambient: process.env.SMITHERS_EXEC_AMBIENT_SECRET," +
          "cache: process.env.SMITHERS_CACHE_TOKEN," +
          "declared: process.env.SMITHERS_DECLARED," +
          "path: typeof process.env.PATH" +
          "}))",
        { env: { SMITHERS_DECLARED: "visible" } }
      ))
      expect(JSON.parse(result.stdout)).toEqual({ declared: "visible", path: "string" })
      expect(result).not.toHaveProperty("durationMs")
    } finally {
      if (previousSecret === undefined) delete process.env["SMITHERS_EXEC_AMBIENT_SECRET"]
      else process.env["SMITHERS_EXEC_AMBIENT_SECRET"] = previousSecret
      if (previousCache === undefined) delete process.env["SMITHERS_CACHE_TOKEN"]
      else process.env["SMITHERS_CACHE_TOKEN"] = previousCache
    }
  })

  it("inherits the native toolchain's SDK location, which a C compiler cannot find without it", async () => {
    // A cargo target that compiles a `-sys` crate spawns the host `cc`. On
    // macOS a toolchain clang reached through PATH resolves its sysroot from
    // `SDKROOT`/`DEVELOPER_DIR` and from nothing else, so withholding them
    // fails the build with `'stdlib.h' file not found`, a host-configuration
    // error reported as a compile error three processes down.
    const previousSdk = process.env["SDKROOT"]
    const previousDeveloper = process.env["DEVELOPER_DIR"]
    const previousHelper = process.env["SMITHERS_WORKSPACE_JJ_EXPORT_BINARY"]
    process.env["SDKROOT"] = "/smthrs/test/MacOSX.sdk"
    process.env["DEVELOPER_DIR"] = "/smthrs/test/Developer"
    process.env["SMITHERS_WORKSPACE_JJ_EXPORT_BINARY"] = "/smthrs/test/native-helper"
    try {
      const result = await succeeded(payload(
        "process.stdout.write(JSON.stringify({" +
          "sdk: process.env.SDKROOT," +
          "developer: process.env.DEVELOPER_DIR," +
          "helper: process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY" +
          "}))"
      ))
      expect(JSON.parse(result.stdout)).toEqual({
        sdk: "/smthrs/test/MacOSX.sdk",
        developer: "/smthrs/test/Developer",
        helper: "/smthrs/test/native-helper"
      })
    } finally {
      if (previousSdk === undefined) delete process.env["SDKROOT"]
      else process.env["SDKROOT"] = previousSdk
      if (previousDeveloper === undefined) delete process.env["DEVELOPER_DIR"]
      else process.env["DEVELOPER_DIR"] = previousDeveloper
      if (previousHelper === undefined) delete process.env["SMITHERS_WORKSPACE_JJ_EXPORT_BINARY"]
      else process.env["SMITHERS_WORKSPACE_JJ_EXPORT_BINARY"] = previousHelper
    }
  })

  it("removes a sensitive value even when the payload tries to add it back", async () => {
    const value = payload(
      "process.stdout.write(String(process.env.SMITHERS_PRIVATE_VALUE))",
      { env: { SMITHERS_PRIVATE_VALUE: "declared-secret" } }
    )
    const exit = await Effect.runPromiseExit(
      Exec.run({ workspaceRoot: root, sensitiveEnv: ["SMITHERS_PRIVATE_VALUE"] }, value)
    )
    if (!Exit.isSuccess(exit)) throw new Error("expected success")
    expect(exit.value.stdout).toBe("undefined")
  })

  it.each([
    ["a negative expected exit", { expectedExitCodes: [-1] }],
    ["a duplicate expected exit", { expectedExitCodes: [0, 0] }],
    ["a zero timeout", { timeoutMs: 0 }],
    ["a fractional timeout", { timeoutMs: 1.5 }],
    ["an environment name with equals", { env: { "BAD=NAME": "x" } }],
    ["an environment value with NUL", { env: { BAD_VALUE: "x\0y" } }]
  ])("rejects %s before spawning", async (_description, override) => {
    const marker = NodePath.join(root, "invalid-payload-ran")
    const value = {
      ...payload(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`),
      ...override
    } as Exec.Payload
    const error = await failed(value)
    expect(error.exitCode).toBe(-1)
    await expect(Fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("bounds the number of declared environment entries", async () => {
    const env = Object.fromEntries(Array.from({ length: 4_097 }, (_, index) => [`VALUE_${index}`, "x"]))
    const error = await failed(payload("process.exit(0)", { env }))

    expect(error.code).toBe("invalid_payload")
    expect(error.stderr).toContain("exec environment has more than 4096 entries")
  })

  it("bounds the aggregate argv bytes before spawning", async () => {
    const marker = NodePath.join(root, "oversize-argv-ran")
    const error = await failed({
      ...payload("process.exit(0)"),
      argv: [
        process.execPath,
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`,
        "x".repeat(2 * 1024 * 1024 + 1)
      ]
    })

    expect(error.code).toBe("invalid_payload")
    expect(error.exitCode).toBe(-1)
    await expect(Fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("kills a tool when its declared timeout expires", async () => {
    const error = await failed(payload("setInterval(() => undefined, 1000)", { timeoutMs: 25 }))
    expect(error.exitCode).toBe(-1)
    expect(error.stderr).toContain("timed out after 25ms")
  })

  it.skipIf(process.platform === "win32")("kills a timed-out tool's descendants", async () => {
    const pidFile = NodePath.join(root, "timeout-pids.txt")
    const child = "process.send(process.pid); setInterval(() => {}, 1000)"
    const program = `const fs = require('node:fs');` +
      `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], ` +
      `{ stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });` +
      `child.on('message', pid => fs.writeFileSync(${JSON.stringify(pidFile)}, process.pid + ' ' + pid));` +
      `setInterval(() => {}, 1000)`

    // A delayed parent timeout can lose a race with a grandchild's marker
    // timer even when the process group is killed correctly. Wait for both
    // processes to be ready, then observe their termination after the timeout.
    const fiber = Effect.runFork(Exec.run({ workspaceRoot: root }, payload(program, { timeoutMs: 30_000 })))
    let pids: Array<number> = []
    try {
      pids = await until(async () => {
        const text = await Fs.readFile(pidFile, "utf8").catch(() => undefined)
        const parsed = text?.trim().split(" ").map(Number)
        return parsed?.length === 2 && parsed.every((pid) => Number.isInteger(pid) && pid > 0) ? parsed : undefined
      })
      expect(pids.map(alive)).toEqual([true, true])
      const error = await Effect.runPromise(Effect.flip(Fiber.join(fiber)))
      expect(error.code).toBe("timed_out")
      await until(async () => pids.every((pid) => !alive(pid)) ? true : undefined)
      expect(pids.map(alive)).toEqual([false, false])
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber))
      // A failing regression must not leave the grandchild running.
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL")
        } catch {
          // Successful termination has already removed the process.
        }
      }
    }
  }, 65_000)
})

describe("cancellation", () => {
  /**
   * The child is spawned detached so it leads a process group. Interrupting
   * the fiber signals the group, so a tool that started its own children takes
   * them with it instead of leaving them writing into the workspace after the
   * build has moved on.
   */
  it("kills the child and its own children when the fiber is interrupted", async () => {
    const pidFile = NodePath.join(root, "pids.txt")
    const program = `const fs = require('node:fs');` +
      `const { spawn } = require('node:child_process');` +
      `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });` +
      `fs.writeFileSync(${JSON.stringify(pidFile)}, process.pid + ' ' + child.pid);` +
      `setInterval(() => {}, 1000)`

    const fiber = Effect.runFork(Exec.run({ workspaceRoot: root }, payload(program)))
    const pids = await until(async () => {
      const text = await Fs.readFile(pidFile, "utf8").catch(() => undefined)
      const parsed = text?.trim().split(" ").map(Number)
      return parsed?.length === 2 && parsed.every((pid) => Number.isInteger(pid) && pid > 0) ? parsed : undefined
    })

    await Effect.runPromise(Fiber.interrupt(fiber))
    await until(async () => pids.every((pid) => !alive(pid)) ? true : undefined)

    expect(pids.map(alive)).toEqual([false, false])
  })
})
