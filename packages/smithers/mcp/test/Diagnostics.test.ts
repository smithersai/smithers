import { NodeServices } from "@effect/platform-node"
import { Effect, Redacted, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Diagnostics from "../src/Diagnostics.ts"
import * as Reporter from "../src/internal/DiagnosticReporter.ts"
import * as McpClient from "../src/McpClient.ts"
import { McpError } from "../src/McpError.ts"
import * as FixtureServer from "./fixtures/FixtureServer.ts"

const secret = "synthetic-private-value-DO-NOT-PUBLISH"

describe("MCP diagnostic privacy", () => {
  it.each(
    [
      ["stderr", "connection_closed"],
      ["version", "protocol_error"],
      ["duplicate", "invalid_response"],
      ["cursor", "invalid_response"],
      ["schema", "invalid_response"],
      ["remote", "tool_failed"]
    ] as const
  )(
    "does not expose %s details through a typed/encoded error or ordinary observer serialization",
    async (mode, expectedCode) => {
      const events: Array<Diagnostics.Event> = []
      const error = await Effect.runPromise(Effect.scoped(
        Effect.gen(function*() {
          return yield* Effect.flip(Effect.gen(function*() {
            const client = yield* McpClient.connect({
              server: "private-test",
              command: process.execPath,
              args: ["-e", FixtureServer.source, `private-${mode}`],
              env: { MCP_DIAGNOSTIC_TEST_SECRET: secret },
              // Truncation can remove the credential prefix. The remainder must
              // still never be attached to an outward error.
              maxStderrBytes: secret.length + 1,
              handshakeTimeoutMs: McpClient.defaultHandshakeTimeoutMs,
              requestTimeoutMs: McpClient.defaultHandshakeTimeoutMs
            })
            return yield* client.callTool("probe", {})
          }))
        }).pipe(Effect.provide(NodeServices.layer), Effect.provide(Diagnostics.layer((event) => events.push(event))))
      ))
      expect(error).toBeInstanceOf(McpError)
      const encoded = Schema.encodeSync(McpError)(error)
      expect(error.code, JSON.stringify(encoded)).toBe(expectedCode)
      for (const display of [String(error), JSON.stringify(error), JSON.stringify(encoded), JSON.stringify(events)]) {
        expect(display).not.toContain(secret)
        expect(display).not.toContain("short-private-pin")
      }
      expect(events.length).toBeGreaterThan(0)
      expect(events.some((event) => Redacted.value(event.detail).includes(secret))).toBe(true)
    }
  )

  it("bounds private details, preserves UTF-8, and isolates observer and serialization defects", async () => {
    const events: Array<Diagnostics.Event> = []
    await Effect.runPromise(
      Effect.gen(function*() {
        const report = yield* Reporter.make("host")
        report("stderr", "x".repeat(16_383) + "😀" + secret)
        const circular: Record<string, unknown> = {}
        circular.self = circular
        report("invalid-response", circular)
        report("remote-error", { code: -32_000, message: secret })
      }).pipe(Effect.provide(Diagnostics.layer((event) => {
        events.push(event)
        if (event.source === "remote-error") throw new Error(secret)
      })))
    )
    expect(events).toHaveLength(2)
    expect(events[0]!.truncated).toBe(true)
    expect(Redacted.value(events[0]!.detail)).toBe("x".repeat(16_383))
    expect(events[1]!.truncated).toBe(false)
    expect(JSON.stringify(events)).not.toContain(secret)
  })

  it("discards details when no trusted host receiver is configured", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const report = yield* Reporter.make("host")
      report("stderr", secret)
    }))
  })
})
