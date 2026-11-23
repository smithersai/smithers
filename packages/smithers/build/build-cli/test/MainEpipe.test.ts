import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import { installEpipeHandler } from "../src/Reporter.ts"

describe("installEpipeHandler", () => {
  it("invokes onPipeClose cleanly on EPIPE errors", () => {
    const stream = new EventEmitter()
    const onPipeClose = vi.fn()
    installEpipeHandler(stream as unknown as NodeJS.WriteStream, onPipeClose)
    const err = Object.assign(new Error("write EPIPE"), { code: "EPIPE" })
    stream.emit("error", err)
    expect(onPipeClose).toHaveBeenCalledTimes(1)
  })

  it("rethrows non-EPIPE stream errors", () => {
    const stream = new EventEmitter()
    const onPipeClose = vi.fn()
    installEpipeHandler(stream as unknown as NodeJS.WriteStream, onPipeClose)
    const err = Object.assign(new Error("ENOSPC"), { code: "ENOSPC" })
    expect(() => stream.emit("error", err)).toThrow("ENOSPC")
    expect(onPipeClose).not.toHaveBeenCalled()
  })
})
