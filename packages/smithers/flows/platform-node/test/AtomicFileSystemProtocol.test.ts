import { Effect, Option } from "effect"
import { describe, expect, it } from "vitest"
import { defaultLimits } from "../src/AtomicFileSystem.ts"
import * as Protocol from "../src/internal/AtomicFileSystemProtocol.ts"

const frame = (value: unknown): Buffer => {
  const body = JSON.stringify(value)
  return Buffer.from(`flows-atomic/1 ${Buffer.byteLength(body)}\n${body}`)
}
const convert = (operation: Protocol.FramedRequest["operation"], value: unknown) =>
  Protocol.convert({ operation, path: "/a" } as Protocol.FramedRequest, value, defaultLimits)
const info = {
  type: "File",
  mtime: 0,
  atime: 0,
  birthtime: null,
  dev: 1,
  ino: 2,
  mode: 0o600,
  nlink: 1,
  uid: 1,
  gid: 1,
  rdev: 0,
  size: 3,
  blksize: null,
  blocks: null
}

describe("atomic helper response validation", () => {
  it.each([
    ["flows-atomic/1 NaN\n{}", "non-decimal"],
    ["flows-atomic/1 99999999999999999\n{}", "out-of-range"],
    ["flows-atomic/1 3\n{}", "declared 3 response bytes and wrote 2"]
  ])("refuses malformed length headers: %s", (input, message) => {
    expect(() => Protocol.decode(Buffer.from(input), defaultLimits)).toThrow(message)
  })

  it.each([
    [null, "result envelope"],
    [{ ok: true, code: 1 }, "non-string error code"],
    [{ ok: true, syscall: 1 }, "non-string syscall"],
    [{ ok: false, badArgument: "true" }, "non-boolean badArgument"],
    [{ ok: false, message: {} }, "non-string message"]
  ])("rejects malformed envelope %j", (value, message) => {
    expect(() => Protocol.decode(frame(value), defaultLimits)).toThrow(message as string)
  })

  it.each([
    [{ type: "FutureType" }, "unknown file type"],
    [{ mtime: "now" }, "non-numeric mtime"],
    [{ mtime: 9e15 }, "out-of-range mtime"],
    [{ dev: -1 }, "out-of-range dev"],
    [{ ino: 0.5 }, "out-of-range ino"],
    [{ size: "-1" }, "non-numeric size"]
  ])("rejects corrupt stat fields %j", (patch, message) => {
    expect(() => convert("stat", { ...info, ...patch })).toThrow(message as string)
  })

  it("accepts numeric sizes and absent optional stat fields", async () => {
    const result = await Effect.runPromise(convert("stat", info))
    expect(result).toMatchObject({ size: 3n, birthtime: Option.none(), blksize: Option.none(), blocks: Option.none() })
  })

  it.each(["a", "!!!!", "a==="])("rejects malformed base64 %s", (base64) => {
    expect(() => convert("readFile", { base64 })).toThrow("malformed base64")
  })

  it("enforces the decoded content ceiling", () => {
    expect(() =>
      Protocol.convert({ operation: "readFile", path: "/a" }, { base64: "YWJj" }, {
        ...defaultLimits,
        content: 2
      })
    ).toThrow("over the 2 byte read limit")
  })

  it.each(
    [
      ["realPath", "bad\0path", "invalid realPath"],
      ["readLink", 42, "invalid readLink"],
      ["readDirectory", {}, "invalid readDirectory"],
      ["glob", ["a", "a"], "duplicate glob"],
      ["exists", "true", "non-boolean exists"],
      ["writeFileString", true, "non-null writeFileString"],
      ["link", null, "unsupported operation link"]
    ] as const
  )("rejects a malformed %s success", (operation, value, message) => {
    expect(() => convert(operation as Protocol.FramedRequest["operation"], value)).toThrow(message)
  })
})
