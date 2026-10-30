/** JSON framing before Incur's stdio transport, which discards syntax errors.
 * @since 1.0.0
 */

import { Context } from "effect"
import { once } from "node:events"
import { type Readable, Transform, type Writable } from "node:stream"
import { finished } from "node:stream/promises"
import * as CliError from "../CliError.ts"

/** Host-owned MCP streams, independent of command arguments.
 * @category services
 * @since 1.0.0
 */
export interface Service {
  readonly input: Readable
  readonly output: Writable
}

/** The transport supplied at the CLI process boundary.
 * @category services
 * @since 1.0.0
 */
export class Stdio extends Context.Service<Stdio, Service>()("/cli/McpStdio") {}

/** Preserve valid frames and answer syntax errors without copying their content.
 * The bound matches the pinned MCP transport's default buffer limit.
 * @category constructors
 * @since 1.0.0
 */
export const input = (output: Writable, maxBytes = 10 * 1024 * 1024): Transform => {
  let pending = Buffer.alloc(0)
  // Cancelled when this input is destroyed, so a stalled reply never outlives its session.
  let waiting: AbortController | undefined
  const drained = async () => {
    waiting = new AbortController()
    const { signal } = waiting
    try {
      // An ended, closed or failed output never drains; finished reports why.
      await Promise.race([
        once(output, "drain", { signal }),
        finished(output, { cleanup: true, readable: false, signal })
      ])
    } finally {
      waiting.abort()
      waiting = undefined
    }
  }
  return new Transform({
    destroy(error, callback) {
      waiting?.abort()
      callback(error)
    },
    transform(chunk: Buffer, _encoding, done) {
      const consume = async () => {
        if (pending.length + chunk.length > maxBytes) {
          throw new CliError.Refused({
            fault: "user",
            code: "mcp_input_too_large",
            message: "MCP stdio input exceeds its buffer limit"
          })
        }
        const bytes = Buffer.concat([pending, chunk])
        let start = 0
        for (;;) {
          const end = bytes.indexOf(10, start)
          if (end < 0) break
          const frame = bytes.subarray(start, end + 1)
          start = end + 1
          try {
            JSON.parse(frame.toString("utf8"))
          } catch {
            if (
              !output.write(
                "{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32700,\"message\":\"Parse error\"}}\n"
              )
            ) {
              await drained()
            }
            continue
          }
          this.push(frame)
        }
        pending = bytes.subarray(start)
      }
      consume().then(() => done(), done)
    }
  })
}
