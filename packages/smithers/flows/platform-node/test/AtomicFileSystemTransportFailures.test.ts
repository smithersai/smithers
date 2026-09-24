import { Effect } from "effect"
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"
import { defaultLimits } from "../src/AtomicFileSystem.ts"
import { frameHeaderBytes } from "../src/internal/AtomicFileSystemProtocol.ts"
import { spawnHelper } from "../src/internal/AtomicFileSystemTransport.ts"

vi.mock("node:child_process", () => ({ spawn: vi.fn() }))
afterEach(() => vi.resetAllMocks())

const frame = (value: unknown) => {
  const body = JSON.stringify(value)
  return Buffer.from(`flows-atomic/1 ${Buffer.byteLength(body)}\n${body}`)
}
const invoke = async (events: (child: ChildProcessWithoutNullStreams) => void) => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn()
  }) as unknown as ChildProcessWithoutNullStreams
  vi.mocked(spawn).mockImplementation(() => {
    queueMicrotask(() => events(child))
    return child
  })
  const result = await Effect.runPromise(Effect.flip(spawnHelper(
    { operation: "exists", path: "/a" },
    "/helper",
    Buffer.from("request"),
    { limits: { ...defaultLimits, response: 256, stderr: 8 }, timeoutMs: 1000 }
  )))
  expect(child.stdin.destroyed).toBe(true)
  expect(child.stdout.destroyed).toBe(true)
  expect(child.stderr.destroyed).toBe(true)
  expect(child.kill).toHaveBeenCalledWith("SIGKILL")
  return result
}

describe("atomic helper transport event ordering", () => {
  it.each(["error", "overflow", "deadline", "cancel"] as const)("waits for process close after %s", async (reason) => {
    let reportKilled!: () => void
    const killed = new Promise<void>((resolve) => {
      reportKilled = resolve
    })
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => {
        reportKilled()
        return true
      })
    }) as unknown as ChildProcessWithoutNullStreams
    vi.mocked(spawn).mockReturnValue(child)
    const controller = new AbortController()
    let completed = false
    const result = Effect.runPromiseExit(
      spawnHelper(
        { operation: "exists", path: "/a" },
        "/helper",
        Buffer.from("request"),
        { limits: { ...defaultLimits, response: 256 }, timeoutMs: reason === "deadline" ? 1 : 1000 }
      ),
      { signal: controller.signal }
    ).then((exit) => {
      completed = true
      return exit
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    if (reason === "error") child.emit("error", new Error("launch failed"))
    if (reason === "overflow") child.stdout.emit("data", Buffer.alloc(257 + frameHeaderBytes))
    if (reason === "cancel") controller.abort()
    await killed
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(completed).toBe(false)
    child.emit("close", -1)
    expect((await result)._tag).toBe("Failure")
    expect(completed).toBe(true)
    expect(child.kill).toHaveBeenCalledWith("SIGKILL")
  })

  it("settles once when an asynchronous launch failure is followed by close", async () => {
    const error = await invoke((child) => {
      child.emit("error", new Error("launch failed"))
      child.emit("close", -1)
    })
    expect(error.reason).toMatchObject({
      _tag: "PermissionDenied",
      description: expect.stringContaining("launch failed")
    })
  })

  it("retains a broken request pipe when no helper rejection arrived", async () => {
    const error = await invoke((child) => {
      child.stdin.emit("error", new Error("EPIPE: request interrupted"))
      child.emit("close", 1)
    })
    expect(error.reason).toMatchObject({ description: expect.stringContaining("EPIPE") })
  })

  it("preserves a typed helper rejection over broken stdin and a failed exit", async () => {
    const error = await invoke((child) => {
      child.stdin.emit("error", new Error("EPIPE"))
      child.stdout.emit("data", frame({ ok: false, code: "ENOENT" }))
      child.emit("close", 1)
    })
    expect(error.reason).toMatchObject({ _tag: "NotFound" })
    expect(error.cause).toMatchObject({ code: "ENOENT", cause: { message: "atomic helper rejected the operation" } })
  })

  it("preserves a short diagnostic without claiming truncation", async () => {
    const error = await invoke((child) => {
      child.stderr.emit("data", Buffer.from("denied"))
      child.emit("close", 7)
    })
    expect(error.cause).toMatchObject({ message: "atomic helper exited 7: denied" })
  })

  it("caps diagnostic retention and reports truncation", async () => {
    const error = await invoke((child) => {
      child.stderr.emit("data", Buffer.from("123456789ignored"))
      child.emit("close", 7)
    })
    expect(error.reason).toMatchObject({ description: expect.stringContaining("12345678 (truncated)") })
    expect(String(error.reason)).not.toContain("ignored")
  })

  it("refuses extra stdout after exactly exhausting the response budget", async () => {
    const error = await invoke((child) => {
      child.stdout.emit("data", Buffer.alloc(256 + frameHeaderBytes))
      child.stdout.emit("data", Buffer.from("overflow"))
      child.emit("close", 0)
    })
    expect(error.reason).toMatchObject({ description: expect.stringContaining("more than 256 response bytes") })
  })

  it("refuses a nonzero exit even with a valid success envelope", async () => {
    const error = await invoke((child) => {
      child.stdout.emit("data", frame({ ok: true, value: true }))
      child.emit("close", 9)
    })
    expect(error.reason).toMatchObject({ description: expect.stringContaining("atomic helper exited 9") })
  })
})
