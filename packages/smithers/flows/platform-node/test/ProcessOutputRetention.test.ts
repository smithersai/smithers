import { Effect, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import * as PipedProcess from "../src/internal/PipedProcess.ts"
import { Control } from "../src/internal/ProcessSupervisor.ts"
import * as ScopedProcess from "../src/ScopedProcess.ts"

const text = (stream: ChildProcessHandle["stdout"]) => stream.pipe(Stream.decodeText(), Stream.mkString)

describe("process output retention", () => {
  it("retains actual native stdout, stderr and custom output until a delayed consumer subscribes", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const handle = yield* PipedProcess.spawn(
          ChildProcess.make(process.execPath, [
            "-e",
            "const fs=require('node:fs');fs.writeSync(1,'stdout bytes');fs.writeSync(2,'stderr bytes');fs.writeSync(3,'custom bytes')"
          ], { stdin: "ignore", additionalFds: { fd3: { type: "output" } } }),
          undefined
        )
        expect(yield* handle.exitCode).toBe(0)
        // The native child has completed before the consumer is scheduled. Its
        // successful exit must not silently discard already-written pipe bytes.
        yield* Effect.sleep(100)
        return yield* Effect.all([text(handle.stdout), text(handle.stderr), text(handle.getOutputFd(3))], {
          concurrency: "unbounded"
        })
      })).pipe(Effect.timeout("15 seconds"))
    )
    expect(result).toEqual(["stdout bytes", "stderr bytes", "custom bytes"])
  })

  it("retains a fast target's output when its activation acknowledgment reaches the caller after cleanup", async () => {
    const original = Control.prototype.write
    const write = vi.spyOn(Control.prototype, "write").mockImplementation(function(this: Control, message) {
      const delivered = original.call(this, message)
      // The real start reaches the real helper. Delay only this host-side
      // acknowledgment until the target and its supervisor have finished, a
      // schedule equivalent to the calling fiber being descheduled at startup.
      if (typeof message === "object" && message !== null && "type" in message && message.type === "start") {
        this.started.promise = this.started.promise.then(() => this.ended.promise)
      }
      return delivered
    })
    try {
      const result = await Effect.runPromise(
        Effect.scoped(Effect.gen(function*() {
          const handle = yield* ScopedProcess.spawn({
            command: process.execPath,
            args: ["-e", "process.stdout.write('fast stdout');process.stderr.write('fast stderr')"],
            forceKillAfter: 80
          })
          // The caller starts consumption immediately after the public spawn.
          return yield* Effect.all([text(handle.stdout), text(handle.stderr), ScopedProcess.status(handle)], {
            concurrency: "unbounded"
          })
        })).pipe(Effect.timeout("15 seconds"))
      )
      expect(result).toEqual(["fast stdout", "fast stderr", { code: 0, signal: null }])
    } finally {
      write.mockRestore()
    }
  })

  it.each([1, 3])("preserves backpressure on fd%i until its output consumer starts", async (fd) => {
    const directory = mkdtempSync(join(tmpdir(), "smthrs-output-pressure-"))
    const blocked = join(directory, "blocked")
    const finished = join(directory, "finished")
    const chunkBytes = 16 * 1024
    const chunks = 512
    const expected = createHash("sha256")
    for (let index = 0; index < chunks; index++) expected.update(Buffer.alloc(chunkBytes, 0xa5))
    try {
      const result = await Effect.runPromise(
        Effect.scoped(Effect.gen(function*() {
          const handle = yield* PipedProcess.spawn(
            ChildProcess.make(process.execPath, [
              "-e",
              [
                "const fs=require('node:fs')",
                // process.stdout is synchronous for Windows pipes: it blocks
                // before the child can publish its backpressure marker. Use
                // the same async writer for both actual output descriptors.
                `const output=fs.createWriteStream('',{fd:${fd}})`,
                `const chunk=Buffer.alloc(${chunkBytes},0xa5);let count=0`,
                `function pump(){while(count<${chunks}){count++;if(!output.write(chunk)){fs.writeFileSync(${
                  JSON.stringify(blocked)
                },String(count));output.once('drain',pump);return}}fs.writeFileSync(${
                  JSON.stringify(finished)
                },String(count));output.end()}`,
                "pump()"
              ].join(";")
            ], {
              stdin: "ignore",
              additionalFds: fd === 3 ? { fd3: { type: "output" } } : undefined
            }),
            undefined
          )
          while (!existsSync(blocked)) yield* Effect.sleep(10)
          yield* Effect.sleep(100)
          // An eager unbounded collector could preserve bytes while silently
          // removing backpressure. The producer must remain blocked here.
          expect(yield* handle.isRunning).toBe(true)
          expect(existsSync(finished)).toBe(false)
          let received = 0
          const digest = createHash("sha256")
          const [, code] = yield* Effect.all([
            Stream.runForEach(fd === 1 ? handle.stdout : handle.getOutputFd(fd), (chunk) =>
              Effect.sync(() => {
                received += chunk.byteLength
                digest.update(chunk)
              })),
            handle.exitCode
          ], { concurrency: "unbounded" })
          return { code, received, digest: digest.digest("hex"), finished: existsSync(finished) }
        })).pipe(Effect.timeout("15 seconds"))
      )
      expect(result).toEqual({
        code: 0,
        received: chunkBytes * chunks,
        digest: expected.digest("hex"),
        finished: true
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
