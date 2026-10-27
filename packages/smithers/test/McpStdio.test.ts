import { once } from "node:events"
import { PassThrough, Writable } from "node:stream"
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
