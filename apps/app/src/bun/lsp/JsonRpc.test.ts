import { expect, test } from "bun:test"
import { createJsonRpc, type JsonRpcIo } from "./JsonRpc"

const encoder = new TextEncoder()

/** A stdio pair whose stdout is fed by hand and never ends on its own. */
const harness = () => {
  let push!: (bytes: Uint8Array) => void
  let cancelled = false
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (bytes) => controller.enqueue(bytes)
    },
    cancel() {
      cancelled = true
    }
  })
  const written: Array<string> = []
  const io: JsonRpcIo = {
    stdin: { write: (chunk) => written.push(chunk), flush: () => 0, end: () => undefined },
    stdout
  }
  const frame = (body: unknown): Uint8Array => {
    const text = JSON.stringify(body)
    return encoder.encode(`Content-Length: ${encoder.encode(text).byteLength}\r\n\r\n${text}`)
  }
  return { io, stdout, written, push: (bytes: Uint8Array) => push(bytes), frame, cancelled: () => cancelled }
}

const within = async (promise: Promise<unknown>, ms: number, what: string): Promise<void> => {
  const late = Symbol("late")
  const raced = await Promise.race([promise.then(() => undefined), Bun.sleep(ms).then(() => late)])
  if (raced === late) throw new Error(`${what} did not settle within ${ms} ms`)
}

test("close cancels the stdout reader and unlocks the stream", async () => {
  const held = harness()
  const rpc = createJsonRpc(held.io, { onNotification: () => {} })
  const pending = rpc.request("textDocument/hover", {}, 5_000)
  pending.catch(() => {})
  await Bun.sleep(10)
  rpc.close()
  await within(rpc.closed, 1_000, "rpc.closed")
  expect(held.cancelled()).toBe(true)
  expect(held.stdout.locked).toBe(false)
  await expect(pending).rejects.toMatchObject({ kind: "closed" })
})

test("a header that never terminates retires the transport", async () => {
  const held = harness()
  const lines: Array<string> = []
  const rpc = createJsonRpc(held.io, { onNotification: () => {}, log: (line) => lines.push(line) })
  for (let sent = 0; sent < 64; sent += 1) held.push(encoder.encode("x".repeat(4096)))
  await within(rpc.closed, 1_000, "rpc.closed")
  expect(lines.some((line) => line.includes("header"))).toBe(true)
})

test("an oversized declared Content-Length retires the transport", async () => {
  const held = harness()
  const lines: Array<string> = []
  const rpc = createJsonRpc(held.io, { onNotification: () => {}, log: (line) => lines.push(line) })
  held.push(encoder.encode("Content-Length: 99999999999999999999\r\n\r\n"))
  await within(rpc.closed, 1_000, "rpc.closed")
  expect(lines.some((line) => line.includes("99999999999999999999"))).toBe(true)
})

test("frames split across chunk boundaries still dispatch", async () => {
  const held = harness()
  const seen: Array<string> = []
  let noticed!: () => void
  const notified = new Promise<void>((resolve) => {
    noticed = resolve
  })
  const rpc = createJsonRpc(held.io, {
    onNotification: (method) => {
      seen.push(method)
      noticed()
    }
  })
  const answer = rpc.request<{ ok: boolean }>("textDocument/hover", {}, 5_000)
  const bytes = held.frame({ jsonrpc: "2.0", id: 1, result: { ok: true } })
  const notice = held.frame({ jsonrpc: "2.0", method: "window/logMessage", params: {} })
  for (let at = 0; at < bytes.byteLength; at += 7) held.push(bytes.subarray(at, at + 7))
  held.push(notice)
  expect(await answer).toEqual({ ok: true })
  await within(notified, 1_000, "the notification")
  expect(seen).toEqual(["window/logMessage"])
  rpc.close()
  await within(rpc.closed, 1_000, "rpc.closed")
})
