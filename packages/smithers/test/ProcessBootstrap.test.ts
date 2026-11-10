import { PassThrough } from "node:stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Host } from "../src/cli/Entry.vibe"

const { audience, install, main } = vi.hoisted(() => ({
  audience: vi.fn(),
  install: vi.fn(),
  main: vi.fn<(host: Host) => Promise<void>>()
}))
vi.mock("@smthrs/build-cli/Audience", () => ({ fromArguments: audience }))
vi.mock("@smthrs/build-cli/effect-resolution", () => ({ installEffectResolution: install }))
vi.mock("../src/cli/Entry.vibe", () => ({ main }))

const originalArgv = [...process.argv]
const originalExitCode = process.exitCode
let input: PassThrough
let stderr: string
let legacy: Array<string> | undefined

beforeEach(() => {
  vi.resetModules()
  audience.mockReset().mockReturnValue({ audience: "human" })
  install.mockReset()
  main.mockReset().mockResolvedValue(undefined)
  input = new PassThrough()
  stderr = ""
  legacy = undefined
  process.exitCode = undefined
  // The adapter uses only Readable events/state. Never allocate a real TTY
  // fixture, whose destruction could close the test runner's input descriptor.
  vi.spyOn(process, "stdin", "get").mockReturnValue(input as unknown as typeof process.stdin)
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk)
    return true
  })
  vi.doMock("../src/cli/LegacyBin.vibe", () => {
    legacy = process.argv.slice(2)
    return {}
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  input.destroy()
  process.argv.splice(0, process.argv.length, ...originalArgv)
  process.exitCode = originalExitCode
})

const boot = async (args: Array<string> = ["--help"]) => {
  process.argv.splice(2, process.argv.length - 2, ...args)
  await import("../src/bin.ts")
  await vi.dynamicImportSettled()
}
const host = (): Host => {
  expect(main).toHaveBeenCalledTimes(1)
  return main.mock.calls[0]![0]
}
const disconnected = (signal: AbortSignal) => host().waitForDisconnect!(signal)
const noInputListeners = () => {
  expect(input.listenerCount("end")).toBe(0)
  expect(input.listenerCount("close")).toBe(0)
}

describe("public executable bootstrap", () => {
  it("installs shared identity resolution before invoking the canonical command entry", async () => {
    main.mockImplementation(async (runtime) => {
      expect(install).toHaveBeenCalledTimes(2)
      expect(install).toHaveBeenNthCalledWith(1, expect.any(Object), { deferTypeScript: false })
      expect(install).toHaveBeenNthCalledWith(2)
      expect(runtime.argv).toEqual(["targets", "--json"])
    })
    await boot(["targets", "--json"])
    const runtime = host()
    expect(runtime.env).toBe(process.env)
    expect(runtime.stdout).toBe(process.stdout)
    expect(runtime.stderr).toBe(process.stderr)
    expect(legacy).toBeUndefined()
    expect(stderr).toBe("")
    expect(process.exitCode).toBeUndefined()
  })

  it("keeps explicit legacy output contracts on the legacy entry", async () => {
    audience.mockReturnValue({ audience: "agent" })
    await boot(["--json", "ps"])
    expect(legacy).toEqual(["--json", "ps"])
    expect(main).not.toHaveBeenCalled()
    expect(install).toHaveBeenNthCalledWith(1, {
      "@smthrs/agent": new URL("../src/bin.ts", import.meta.url).href,
      "@smthrs/integrations": new URL("../src/bin.ts", import.meta.url).href,
      "@smthrs/patterns": new URL("../src/bin.ts", import.meta.url).href,
      "@smthrs/registry/Prompt/jsx-runtime": new URL("../src/bin.ts", import.meta.url).href
    }, { deferTypeScript: false })
    expect(install).toHaveBeenNthCalledWith(2)
  })

  it("maps agent aliases without rewriting the process's original arguments", async () => {
    audience.mockReturnValue({ audience: "agent" })
    await boot(["up", "hello", "--silent"])
    expect(host().argv).toEqual(["flow", "start", "hello", "--silent"])
    expect(process.argv.slice(2)).toEqual(["up", "hello", "--silent"])
    expect(legacy).toBeUndefined()
  })

  it("rewrites internal legacy routing before importing that entry", async () => {
    await boot(["internal", "claude", "tick"])
    expect(legacy).toEqual(["claude", "tick"])
    expect(process.argv.slice(2)).toEqual(["claude", "tick"])
    expect(main).not.toHaveBeenCalled()
  })

  it.each([["targets"], ["ps"]])(
    "lets the selected entry report invalid audience configuration for %s",
    async (...args) => {
      audience.mockImplementation(() => {
        throw new Error("invalid presentation")
      })
      await boot(args)
      if (args[0] === "ps") expect(legacy).toEqual(args)
      else expect(host().argv).toEqual(args)
      expect(stderr).toBe("")
    }
  )

  it("forwards listener ownership and exit status without delivering an actual process signal", async () => {
    await boot()
    const runtime = host()
    const listener = () => {}
    const before = process.listenerCount("SIGTERM")
    try {
      runtime.on("SIGTERM", listener)
      expect(process.listeners("SIGTERM")).toContain(listener)
      expect(process.listenerCount("SIGTERM")).toBe(before + 1)
      runtime.removeListener("SIGTERM", listener)
      expect(process.listenerCount("SIGTERM")).toBe(before)
      runtime.setExitCode(143)
      expect(process.exitCode).toBe(143)
    } finally {
      process.removeListener("SIGTERM", listener)
    }
  })

  it.each([
    new Error("Authorization: Bearer fixture-bootstrap-secret"),
    "Authorization: Bearer fixture-bootstrap-secret"
  ])(
    "redacts failed command startup and sets a failing exit code (%s)",
    async (failure) => {
      main.mockRejectedValue(failure)
      await boot()
      expect(process.exitCode).toBe(1)
      expect(stderr).toEqual(
        failure instanceof Error
          ? "Authorization: Bearer [REDACTED_TOKEN]\n"
          : expect.stringContaining("Diagnostics: ")
      )
      expect(stderr).not.toContain("fixture-bootstrap-secret")
    }
  )

  it("does not load commands after shared resolution setup fails", async () => {
    install.mockImplementation(() => {
      throw new Error("bootstrap refused")
    })
    await boot()
    expect(main).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(stderr).toBe("bootstrap refused\n")
  })

  it("retains a diagnostic receipt when command startup throws a runtime error", async () => {
    main.mockRejectedValue(new TypeError("Cannot load removed scorer module"))
    await boot()
    expect(process.exitCode).toBe(1)
    expect(stderr).toContain("TypeError: Cannot load removed scorer module")
    expect(stderr).toContain("Diagnostics: ")
  })
})

describe("process stdin disconnect ownership", () => {
  it.each(["end", "close"])("releases stream and abort listeners on %s", async (event) => {
    await boot(["--mcp"])
    const controller = new AbortController()
    const removed = vi.spyOn(controller.signal, "removeEventListener")
    const destroy = vi.spyOn(input, "destroy")
    const waiting = disconnected(controller.signal)
    expect(input.listenerCount("end")).toBe(1)
    expect(input.listenerCount("close")).toBe(1)
    input.emit(event)
    await waiting
    noInputListeners()
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function))
    controller.abort()
    expect(destroy).not.toHaveBeenCalled()
  })

  it.each([true, false])(
    "destroys only the owned input on cancellation (already aborted: %s)",
    async (alreadyAborted) => {
      await boot(["--mcp"])
      const controller = new AbortController()
      if (alreadyAborted) controller.abort()
      const waiting = disconnected(controller.signal)
      if (!alreadyAborted) controller.abort()
      await waiting
      expect(input.destroyed).toBe(true)
      noInputListeners()
    }
  )

  it.each(["ended", "destroyed"])("does not wait on %s input or register an abort listener", async (state) => {
    await boot(["--mcp"])
    if (state === "ended") Object.defineProperty(input, "readableEnded", { value: true })
    else input.destroy()
    const controller = new AbortController()
    const added = vi.spyOn(controller.signal, "addEventListener")
    await disconnected(controller.signal)
    expect(added).not.toHaveBeenCalled()
    noInputListeners()
  })
})
