import { Effect, Redacted } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import { describe, expect, it } from "vitest"
import * as HttpTransport from "../src/internal/HttpTransport.ts"
import * as McpClient from "../src/McpClient.ts"
import * as McpFlows from "../src/McpFlows.ts"

describe("Streamable HTTP credential policy", () => {
  it.each([
    "http://mcp.example.test/mcp?key=synthetic-secret",
    "http://192.168.1.2/mcp",
    "http://0.0.0.0/mcp",
    "http://128.0.0.1/mcp",
    "http://126.255.255.255/mcp",
    "http://127.example.test/mcp",
    "http://localhost.example.test/mcp",
    "http://[::]/mcp",
    "http://[::ffff:127.0.0.1]/mcp"
  ])("refuses credentials for %s before reading the token or sending a request", async (url) => {
    let tokens = 0
    let requests = 0
    const http = HttpClient.make(() => {
      requests += 1
      return Effect.die("HTTP must not run for a refused endpoint")
    })
    const options = {
      server: "remote",
      url,
      authProvider: {
        token: Effect.sync(() => {
          tokens += 1
          return Redacted.make("synthetic-bearer-secret")
        })
      }
    }
    for (
      const attempt of [
        McpClient.connect(options).pipe(Effect.asVoid),
        McpFlows.connected(options).pipe(Effect.asVoid)
      ]
    ) {
      const error = await Effect.runPromise(
        Effect.scoped(Effect.flip(attempt)).pipe(Effect.provideService(HttpClient.HttpClient, http))
      )
      expect(error).toMatchObject({
        code: "protocol_error",
        server: "remote",
        message: "MCP server \"remote\" bearer credentials require HTTPS except on loopback"
      })
      expect(JSON.stringify(error)).not.toContain("synthetic")
      expect(tokens).toBe(0)
      expect(requests).toBe(0)
    }
  })

  it.each([
    "https://mcp.example.test/mcp",
    "https://192.168.1.2/mcp",
    "http://localhost:1234/mcp",
    "http://LOCALHOST:1234/mcp",
    "http://127.0.0.1:1234/mcp",
    "http://127.0.0.0:1234/mcp",
    "http://127.255.255.255:1234/mcp",
    "http://127.1:1234/mcp",
    "http://2130706433:1234/mcp",
    "http://[::1]:1234/mcp"
  ])("passes credentials for %s to the host egress service", async (url) => {
    const authorizations: Array<string | undefined> = []
    const http = HttpClient.make((request) => {
      authorizations.push(request.headers.authorization)
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause: new Error("egress unavailable") })
        })
      )
    })
    const error = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const transport = yield* HttpTransport.connect({
          server: "remote",
          url,
          authProvider: { token: Effect.succeed(Redacted.make("synthetic-token")) }
        })
        return yield* Effect.flip(transport.request("initialize", {}))
      })).pipe(Effect.provideService(HttpClient.HttpClient, http))
    )
    expect(error.code).toBe("connection_closed")
    expect(authorizations).toEqual(["Bearer synthetic-token"])
  })

  it("keeps non-loopback HTTP available without a credential provider", async () => {
    const authorizations: Array<string | undefined> = []
    const http = HttpClient.make((request) => {
      authorizations.push(request.headers.authorization)
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause: new Error("egress unavailable") })
        })
      )
    })
    const error = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const transport = yield* HttpTransport.connect({ server: "remote", url: "http://mcp.example.test/mcp" })
        return yield* Effect.flip(transport.request("initialize", {}))
      })).pipe(Effect.provideService(HttpClient.HttpClient, http))
    )
    expect(error.code).toBe("connection_closed")
    expect(authorizations).toEqual([undefined])
  })
})
