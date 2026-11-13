/** Directory sync faults are injected without changing the host filesystem or platform. */
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as SafeFs from "../src/SafeFs.ts"

let root: string

beforeEach(async () => {
  root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-safefs-sync-"))
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

/** Each invocation owns its fault and records the operations that actually ran. */
const directoryIo = (faults: { readonly open?: Error; readonly sync?: Error; readonly close?: Error } = {}) => {
  const events: Array<string> = []
  const io: SafeFs.DirectorySyncIo = {
    open: async (path, flags) => {
      expect(flags).toBe("r")
      events.push(`open:${path}`)
      if (faults.open !== undefined) throw faults.open
      return {
        sync: async () => {
          events.push("sync")
          if (faults.sync !== undefined) throw faults.sync
        },
        close: async () => {
          events.push("close")
          if (faults.close !== undefined) throw faults.close
        }
      }
    }
  }
  return { io, events }
}

describe("SafeFs.syncDirectory", () => {
  it.skipIf(process.platform === "win32")("flushes a real directory", async () => {
    await expect(SafeFs.syncDirectory(root)).resolves.toBeUndefined()
  })

  it("opens nothing where the platform has no directory descriptor", async () => {
    const { io, events } = directoryIo()
    await expect(SafeFs.syncDirectory(root, io, "win32")).resolves.toBeUndefined()
    expect(events).toEqual([])
  })

  it.skipIf(process.platform === "win32")("reports a directory it cannot open", async () => {
    await expect(SafeFs.syncDirectory(NodePath.join(root, "absent"))).rejects.toThrow(/ENOENT/)
  })

  it("opens, syncs and closes through the supplied operations", async () => {
    const { io, events } = directoryIo()
    await expect(SafeFs.syncDirectory(root, io, "linux")).resolves.toBeUndefined()
    expect(events).toEqual([`open:${root}`, "sync", "close"])
  })

  it("reports an injected open failure without syncing or closing", async () => {
    const open = new Error("directory open failed")
    const { io, events } = directoryIo({ open })
    await expect(SafeFs.syncDirectory(root, io, "linux")).rejects.toBe(open)
    expect(events).toEqual([`open:${root}`])
  })

  it.each(["ENOTSUP", "EOPNOTSUPP", "EINVAL", "ENOSYS"])(
    "tolerates %s from directory sync and still closes the handle",
    async (code) => {
      const { io, events } = directoryIo({ sync: Object.assign(new Error("unsupported"), { code }) })
      await expect(SafeFs.syncDirectory(root, io, "linux")).resolves.toBeUndefined()
      expect(events).toEqual([`open:${root}`, "sync", "close"])
    }
  )

  it.each(["ENOTSUP", "EOPNOTSUPP", "EINVAL", "ENOSYS"])(
    "reports a close failure after an unsupported %s sync",
    async (code) => {
      const close = new Error("directory close failed")
      const { io, events } = directoryIo({ sync: Object.assign(new Error("unsupported"), { code }), close })
      await expect(SafeFs.syncDirectory(root, io, "linux")).rejects.toBe(close)
      expect(events).toEqual([`open:${root}`, "sync", "close"])
    }
  )

  it.each(
    [
      ["a sync that fails outright", Object.assign(new Error("directory sync failed"), { code: "EIO" })],
      ["a sync failure that carries no code", new Error("directory sync failed")]
    ] as const
  )("reports %s before any close failure", async (_case, sync) => {
    for (const close of [undefined, new Error("directory close failed")]) {
      const { io, events } = directoryIo({ sync, ...(close === undefined ? {} : { close }) })
      await expect(SafeFs.syncDirectory(root, io, "linux")).rejects.toBe(sync)
      expect(events).toEqual([`open:${root}`, "sync", "close"])
    }
  })

  it("reports a handle that will not close after a successful sync", async () => {
    const close = new Error("directory close failed")
    const { io, events } = directoryIo({ close })
    await expect(SafeFs.syncDirectory(root, io, "linux")).rejects.toBe(close)
    expect(events).toEqual([`open:${root}`, "sync", "close"])
  })
})
