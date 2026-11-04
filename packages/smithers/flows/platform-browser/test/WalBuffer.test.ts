import { SQLITE_IOERR, SQLITE_OK, SQLITE_OPEN_WAL } from "@journeyapps/wa-sqlite"
import {
  closeSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { bufferWalWrites, type Vfs } from "../src/internal/WalBuffer.ts"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const close of cleanups.splice(0)) close()
})

/** Real files, with a faulty host write/sync available for the failure cases. */
const files = () => {
  const directory = mkdtempSync(join(tmpdir(), "wal-buffer-"))
  const handles = new Map<number, number>()
  const calls: Array<{ file: number; offset: number; size: number }> = []
  let flushes = 0
  let fault: "none" | "short" | "throw" | "sync" | "open" | "close" = "none"
  const dispose = () => {
    for (const fd of handles.values()) closeSync(fd)
    handles.clear()
  }
  cleanups.push(() => {
    dispose()
    rmSync(directory, { recursive: true, force: true })
  })
  const host: Vfs = {
    jOpen: (_name, file) => {
      if (fault === "open") return SQLITE_IOERR
      handles.set(file, openSync(join(directory, String(file)), "w+"))
      return SQLITE_OK
    },
    jWrite: (file, bytes, offset) => {
      calls.push({ file, offset, size: bytes.length })
      if (fault === "throw") throw new Error("private host detail")
      writeSync(handles.get(file)!, bytes, 0, fault === "short" ? Math.floor(bytes.length / 2) : bytes.length, offset)
      return fault === "short" ? SQLITE_IOERR : SQLITE_OK
    },
    jRead: (file, bytes, offset) => {
      bytes.fill(0)
      readSync(handles.get(file)!, bytes, 0, bytes.length, offset)
      return SQLITE_OK
    },
    jSync: (file) => {
      flushes++
      fsyncSync(handles.get(file)!)
      return fault === "sync" ? SQLITE_IOERR : SQLITE_OK
    },
    jFileSize: (file, output) => {
      output.setBigInt64(0, BigInt(fstatSync(handles.get(file)!).size), true)
      return SQLITE_OK
    },
    jTruncate: (file, size) => {
      ftruncateSync(handles.get(file)!, size)
      return SQLITE_OK
    },
    jClose: (file) => {
      closeSync(handles.get(file)!)
      handles.delete(file)
      return fault === "close" ? SQLITE_IOERR : SQLITE_OK
    },
    jDelete: (name) => {
      rmSync(join(directory, name))
      return SQLITE_OK
    },
    close: async () => dispose()
  }
  const vfs = bufferWalWrites(host)
  const open = (file = 1, flags: number = SQLITE_OPEN_WAL) =>
    vfs.jOpen(String(file), file, flags, new DataView(new ArrayBuffer(4)))
  return {
    vfs,
    open,
    calls,
    handles,
    bytes: (file = 1) => readFileSync(join(directory, String(file))),
    flushes: () => flushes,
    fault: (value: typeof fault) => {
      fault = value
    }
  }
}

it("coalesces adjacent bytes, copies reused WASM views, and still flushes every requested sync", () => {
  const f = files()
  f.open()
  const bytes = new Uint8Array([1, 2, 3])
  expect(f.vfs.jWrite(1, bytes.subarray(1), 0)).toBe(SQLITE_OK)
  bytes.fill(9)
  expect(f.vfs.jWrite(1, bytes, 2)).toBe(SQLITE_OK)
  expect(f.calls).toEqual([])
  expect(f.vfs.jSync(1, 0)).toBe(SQLITE_OK)
  expect([...f.bytes()]).toEqual([2, 3, 9, 9, 9])
  expect(f.calls).toEqual([{ file: 1, offset: 0, size: 5 }])
  expect(f.vfs.jSync(1, 0)).toBe(SQLITE_OK)
  expect(f.flushes()).toBe(2)
})

it("bounds memory and preserves overlaps, gaps, oversized writes and interleaved files", async () => {
  const f = files()
  f.open()
  f.open(2)
  f.open(3, 0)
  const block = new Uint8Array(65536).fill(7)
  f.vfs.jWrite(1, block, 0)
  f.vfs.jWrite(1, new Uint8Array([8]), block.length)
  expect(f.calls).toHaveLength(1)
  f.vfs.jWrite(2, new Uint8Array([4]), 0)
  f.vfs.jWrite(1, new Uint8Array([9]), 0)
  f.vfs.jWrite(1, new Uint8Array(65537).fill(5), 65538)
  f.vfs.jWrite(3, new Uint8Array([6]), 0)
  expect([...f.bytes(3)]).toEqual([6])
  expect(f.vfs.jSync(3, 0)).toBe(SQLITE_OK)
  expect(f.vfs.jClose(1)).toBe(SQLITE_OK)
  expect(f.vfs.jClose(2)).toBe(SQLITE_OK)
  await f.vfs.close()
  const expected = Buffer.alloc(131075, 0)
  expected.fill(7, 0, 65536)
  expected[0] = 9
  expected[65536] = 8
  expected.fill(5, 65538)
  expect(f.bytes()).toEqual(expected)
  expect([...f.bytes(2)]).toEqual([4])
  expect(f.calls.every((c) => c.size <= 65536 || c.size === 65537)).toBe(true)
  expect(f.handles.size).toBe(0)
})

it("drains before reads, size checks, truncation, close and deletion", () => {
  const f = files()
  f.open()
  f.open(2)
  f.vfs.jWrite(1, new Uint8Array([1, 2, 3]), 0)
  const read = new Uint8Array(3)
  expect(f.vfs.jRead(1, read, 0)).toBe(SQLITE_OK)
  expect([...read]).toEqual([1, 2, 3])
  f.vfs.jWrite(1, new Uint8Array([4]), 3)
  const size = new DataView(new ArrayBuffer(8))
  expect(f.vfs.jFileSize(1, size)).toBe(SQLITE_OK)
  expect(size.getBigInt64(0, true)).toBe(4n)
  f.vfs.jWrite(1, new Uint8Array([5]), 4)
  expect(f.vfs.jTruncate(1, 2)).toBe(SQLITE_OK)
  expect([...f.bytes()]).toEqual([1, 2])
  f.vfs.jWrite(1, new Uint8Array([6]), 2)
  expect(f.vfs.jClose(1)).toBe(SQLITE_OK)
  expect([...f.bytes()]).toEqual([1, 2, 6])
  f.vfs.jWrite(2, new Uint8Array([7]), 0)
  expect(f.vfs.jDelete("1", 1)).toBe(SQLITE_OK)
  expect([...f.bytes(2)]).toEqual([7])
})

it.each(["short", "throw"] as const)(
  "a %s write fails closed at every boundary and close releases the file",
  async (fault) => {
    const f = files()
    f.open()
    f.open(2)
    f.vfs.jWrite(1, new Uint8Array([1, 2]), 0)
    f.fault(fault)
    expect(f.vfs.jSync(1, 0)).toBe(SQLITE_IOERR)
    f.fault("none")
    expect(f.vfs.jWrite(1, new Uint8Array([3]), 2)).toBe(SQLITE_IOERR)
    expect(f.vfs.jRead(1, new Uint8Array(2), 0)).toBe(SQLITE_IOERR)
    expect(f.vfs.jFileSize(1, new DataView(new ArrayBuffer(8)))).toBe(SQLITE_IOERR)
    expect(f.vfs.jTruncate(1, 0)).toBe(SQLITE_IOERR)
    expect(f.vfs.jDelete("2", 0)).toBe(SQLITE_IOERR)
    expect(f.flushes()).toBe(0)
    expect(f.calls).toHaveLength(1)
    expect(f.vfs.jClose(1)).toBe(SQLITE_IOERR)
    expect(f.handles.has(1)).toBe(false)
    expect(f.open()).toBe(SQLITE_OK)
    expect(f.vfs.jWrite(1, new Uint8Array([8]), 0)).toBe(SQLITE_OK)
    expect(f.vfs.jSync(1, 0)).toBe(SQLITE_OK)
    await f.vfs.close()
    expect([...f.bytes()]).toEqual([8])
  }
)

it.each(["short", "throw"] as const)("refuses a %s drain forced by a nonadjacent or oversized write", (fault) => {
  const f = files()
  f.open()
  f.fault(fault)
  f.vfs.jWrite(1, new Uint8Array([1]), 0)
  expect(f.vfs.jWrite(1, new Uint8Array([2]), 4)).toBe(SQLITE_IOERR)
  f.fault("none")
  f.vfs.jClose(1)
  f.open()
  f.fault(fault)
  expect(f.vfs.jWrite(1, new Uint8Array(65537), 0)).toBe(SQLITE_IOERR)
})

it("reports open, sync and close failures and discards unsynced tails on pool disposal", async () => {
  const f = files()
  f.fault("open")
  expect(f.open()).toBe(SQLITE_IOERR)
  f.fault("none")
  f.open()
  f.vfs.jWrite(1, new Uint8Array([1]), 0)
  f.fault("sync")
  expect(f.vfs.jSync(1, 0)).toBe(SQLITE_IOERR)
  f.fault("close")
  expect(f.vfs.jClose(1)).toBe(SQLITE_IOERR)
  f.fault("none")
  f.open()
  f.vfs.jWrite(1, new Uint8Array([2]), 0)
  f.fault("short")
  await f.vfs.close()
  expect([...f.bytes()]).toEqual([])
  expect(f.handles.size).toBe(0)
})
