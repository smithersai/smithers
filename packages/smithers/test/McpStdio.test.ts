import { once } from "node:events"
import { PassThrough, Writable } from "node:stream"
import { setImmediate, setTimeout } from "node:timers/promises"
import { expect, it } from "vitest"
import * as McpStdio from "../src/cli/McpStdio.ts"

it("preserves valid UTF-8 and CRLF frames across chunks and bounds unterminated input", async () => {
  const output = new PassThrough()
  let responses = ""
  output.on("data", (bytes) => {
    responses += bytes
  })
  const input = McpStdio.input(output)
  const received: Array<Buffer> = []
  input.on("data", (bytes) => received.push(bytes))
  const bytes = Buffer.from("{\"text\":\"😀\"}\r\n{bad\n{\"ok\":true}\n")
  const ended = once(input, "end")
  input.write(bytes.subarray(0, 11))
  input.end(bytes.subarray(11))
  await ended
  expect(Buffer.concat(received).toString()).toBe("{\"text\":\"😀\"}\r\n{\"ok\":true}\n")
  expect(JSON.parse(responses)).toMatchObject({ id: null, error: { code: -32700 } })
  const bounded = McpStdio.input(output, 4)
  const failed = once(bounded, "error")
  bounded.write("12345")
  expect((await failed)[0]).toMatchObject({
    code: "mcp_input_too_large",
    message: "MCP stdio input exceeds its buffer limit"
  })
})

it("waits for parse-error output backpressure and propagates output failures", async () => {
  let release: ((error?: Error | null) => void) | undefined
  const output = new Writable({
    highWaterMark: 1,
    write(_bytes, _encoding, done) {
      release = done
    }
  })
  const input = McpStdio.input(output)
  const forwarded: Array<Buffer> = []
  input.on("data", (bytes) => forwarded.push(bytes))
  input.write("bad\n{}\n")
  expect(forwarded).toEqual([])
  const ended = once(input, "end")
  release!()
  input.end()
  await ended
  expect(Buffer.concat(forwarded).toString()).toBe("{}\n")
  const failedOutput = new PassThrough()
  const finished = once(failedOutput, "finish")
  failedOutput.end()
  await finished
  const failing = McpStdio.input(failedOutput)
  const failed = once(failing, "error")
  failing.write("bad\n")
  expect((await failed)[0].code).toBe("ERR_STREAM_WRITE_AFTER_END")
})

it("abandons a backpressured parse-error reply when the session is cancelled", async () => {
  const written: Array<string> = []
  let release: (() => void) | undefined
  const output = new Writable({
    highWaterMark: 1,
    write(bytes, _encoding, done) {
      written.push(String(bytes))
      release = () => done()
    }
  })
  const input = McpStdio.input(output)
  const errors: Array<Error> = []
  input.on("error", (error) => errors.push(error))
  input.write("bad\nbad\n")
  await setImmediate()
  expect(written).toHaveLength(1)
  const closed = once(input, "close")
  input.destroy()
  await closed
  expect(output.listenerCount("drain")).toBe(0)
  expect(output.listenerCount("close")).toBe(0)
  release!()
  await setImmediate()
  expect(written).toHaveLength(1)
  expect(errors).toEqual([])
})

it.each(["while waiting", "before writing"])("fails instead of waiting when output closes %s", async (when) => {
  const output = new Writable({
    highWaterMark: 1,
    write() {}
  })
  if (when === "before writing") {
    output.destroy()
    await once(output, "close")
  }
  const input = McpStdio.input(output)
  const failed = once(input, "error")
  input.write("bad\n")
  if (when === "while waiting") {
    await setImmediate()
    output.destroy()
  }
  const outcome = await Promise.race([failed, setTimeout(2_000, "still waiting")])
  expect(outcome).toMatchObject([{ code: "ERR_STREAM_PREMATURE_CLOSE" }])
  expect(output.listenerCount("drain")).toBe(0)
  expect(output.listenerCount("close")).toBe(0)
})
