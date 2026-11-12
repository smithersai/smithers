import { Effect } from "effect"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { defaultLimits, helperSpawns } from "../src/AtomicFileSystem.ts"
import { frameHeaderBytes } from "../src/internal/AtomicFileSystemProtocol.ts"
import { spawnHelper } from "../src/internal/AtomicFileSystemTransport.ts"
import { atomicHelperProgram } from "./helpers/atomicHelperProgram.ts"

const program = atomicHelperProgram()
const directories: Array<string> = []
const temporary = async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "smithers-transport-")))
  directories.push(directory)
  return directory
}
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

const request = { operation: "exists", path: "/a" } as const
const limits = { ...defaultLimits, response: 256, stderr: 8 }
const frame = (value: unknown) => {
  const body = JSON.stringify(value)
  return `flows-atomic/1 ${Buffer.byteLength(body)}\n${body}`
}
/** A helper written as Node source that never reads its request. */
const helper = async (body: string) => program(await temporary(), body)
/** Large enough that the request write outlives a helper that exits without reading it. */
const unread = Buffer.alloc(2 * 1024 * 1024)
const refusal = (executable: string, payload = Buffer.from("request")) =>
  Effect.runPromise(Effect.flip(spawnHelper(request, executable, payload, { limits, timeoutMs: 10_000 })))
/** Whether `pid` names a process this host has not yet reaped. */
const unreaped = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    throw error
  }
}
const until = async (ready: () => boolean) => {
  while (!ready()) await new Promise<void>((resolve) => setTimeout(resolve, 10))
}

describe("atomic helper transport event ordering", () => {
  it.each(["overflow", "deadline", "cancel"] as const)(
    "settles only after the killed helper's process has closed on %s",
    async (reason) => {
      const directory = await temporary()
      const pidFile = join(directory, "pid")
      const overflow = reason === "overflow"
        ? `process.stdout.write(Buffer.alloc(${limits.response + 1 + frameHeaderBytes}));`
        : ""
      const executable = await program(
        directory,
        // Renamed into place, so the pid file never exists half-written.
        `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(`${pidFile}.tmp`)},String(process.pid));` +
          `fs.renameSync(${JSON.stringify(`${pidFile}.tmp`)},${JSON.stringify(pidFile)});${overflow}` +
          "setInterval(()=>{},1000)"
      )
      const controller = new AbortController()
      const result = Effect.runPromiseExit(
        spawnHelper(request, executable, Buffer.from("request"), {
          limits,
          timeoutMs: reason === "deadline" ? 3_000 : 60_000
        }),
        { signal: controller.signal }
      )
      await until(() => existsSync(pidFile))
      const pid = Number(await readFile(pidFile, "utf8"))
      if (reason === "cancel") controller.abort()
      expect((await result)._tag).toBe("Failure")
      // The helper was killed and its exit collected before the request settled.
      expect(unreaped(pid)).toBe(false)
    },
    30_000
  )

  it("settles once when an asynchronous launch failure is followed by close", async () => {
    const before = helperSpawns()
    const error = await refusal(join(await temporary(), "missing-helper"))
    expect(error.reason).toMatchObject({
      _tag: "PermissionDenied",
      description: expect.stringContaining("ENOENT")
    })
    expect(helperSpawns() - before).toBe(1)
  })

  it("fails closed when the launch throws before any helper child exists", async () => {
    const before = helperSpawns()
    const error = await Effect.runPromise(Effect.flip(spawnHelper(
      request,
      "/helper",
      Buffer.from("request"),
      { limits, timeoutMs: 1000 },
      () => {
        throw new Error("synchronous spawn failure")
      }
    )))
    expect(error.reason).toMatchObject({
      _tag: "PermissionDenied",
      description: expect.stringContaining("synchronous spawn failure")
    })
    expect(helperSpawns()).toBe(before)
  })

  it("retains a broken request pipe when no helper rejection arrived", async () => {
    const error = await refusal(await helper("process.exit(1)"), unread)
    expect(error.reason).toMatchObject({ description: expect.stringContaining("EPIPE") })
  })

  it("preserves a typed helper rejection over broken stdin and a failed exit", async () => {
    const error = await refusal(
      await helper(
        `const fs=require('node:fs');fs.closeSync(0);` +
          `fs.writeSync(1,${JSON.stringify(frame({ ok: false, code: "ENOENT" }))});process.exit(1)`
      ),
      unread
    )
    expect(error.reason).toMatchObject({ _tag: "NotFound" })
    expect(error.cause).toMatchObject({ code: "ENOENT", cause: { message: "atomic helper rejected the operation" } })
  })

  it("preserves a short diagnostic without claiming truncation", async () => {
    const error = await refusal(await helper("process.stderr.write('denied',()=>process.exit(7))"))
    expect(error.cause).toMatchObject({ message: "atomic helper exited 7: denied" })
  })

  it("caps diagnostic retention and reports truncation", async () => {
    const error = await refusal(await helper("process.stderr.write('123456789ignored',()=>process.exit(7))"))
    expect(error.reason).toMatchObject({ description: expect.stringContaining("12345678 (truncated)") })
    expect(String(error.reason)).not.toContain("ignored")
  })

  it("refuses extra stdout after exactly exhausting the response budget", async () => {
    // The pause lets the host read the full budget as its own chunk first.
    const error = await refusal(
      await helper(
        `process.stdout.write(Buffer.alloc(${limits.response + frameHeaderBytes}),()=>setTimeout(()=>` +
          "process.stdout.write('overflow',()=>process.exit(0)),500))"
      )
    )
    expect(error.reason).toMatchObject({ description: expect.stringContaining("more than 256 response bytes") })
  })

  it("refuses a nonzero exit even with a valid success envelope", async () => {
    const error = await refusal(
      await helper(`process.stdout.write(${JSON.stringify(frame({ ok: true, value: true }))},()=>process.exit(9))`)
    )
    expect(error.reason).toMatchObject({ description: expect.stringContaining("atomic helper exited 9") })
  })
})
