import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as http from "node:http"
import type * as net from "node:net"
import { describe, expect, it } from "vitest"
import * as EgressHttpClient from "../src/EgressHttpClient.ts"
import * as FetchTransport from "../src/FetchTransport.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

describe("@smthrs/platform-node EgressHttpClient & FetchTransport fuzz invariants", () => {
  it("EgressHttpClient bypasses proxy for loopback, rejects invalid proxy URLs without leaking credentials, and resolves hosts", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" }).end("LOOPBACK_OK")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    const port = (server.address() as net.AddressInfo).port

    try {
      const arb = Arbitrary.schema(
        Schema.Struct({
          proxyKind: Schema.Literals([
            "none",
            "valid_http",
            "invalid_scheme",
            "invalid_path",
            "bad_percent",
            "wildcard_no_proxy"
          ]),
          useLowercase: Schema.Boolean,
          targetKind: Schema.Literals(["loopback", "remote_invalid_proxy"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ proxyKind, useLowercase, targetKind }) =>
            Effect.gen(function*() {
              const secret = "s3cr3tP4ssw0rd999"
              const env: Record<string, string | undefined> = {}
              const key = useLowercase ? "http_proxy" : "HTTP_PROXY"
              if (proxyKind === "valid_http") env[key] = `http://user:${secret}@127.0.0.1:1`
              else if (proxyKind === "invalid_scheme") env[key] = `ftp://user:${secret}@proxy.invalid:8080`
              else if (proxyKind === "invalid_path") env[key] = `http://user:${secret}@proxy.invalid:8080/path`
              else if (proxyKind === "bad_percent") env[key] = `http://%ZZ:${secret}@proxy.invalid:8080`
              else if (proxyKind === "wildcard_no_proxy") {
                env[key] = `http://user:${secret}@127.0.0.1:1`
                env["NO_PROXY"] = "*"
              }

              const isInvalidProxy = proxyKind === "invalid_scheme" || proxyKind === "invalid_path" ||
                proxyKind === "bad_percent"

              if (targetKind === "loopback") {
                // Loopback MUST ALWAYS succeed directly regardless of HTTP_PROXY (even invalid or unreachable proxy!)
                const body = yield* Effect.gen(function*() {
                  const client = yield* HttpClient.HttpClient
                  const resp = yield* client.execute(HttpClientRequest.get(`http://127.0.0.1:${port}/ping`))
                  return yield* resp.text
                }).pipe(Effect.provide(EgressHttpClient.layer(env)))
                if (body !== "LOOPBACK_OK") return false
              } else if (isInvalidProxy) {
                // Remote request with invalid proxy MUST fail closed and NEVER leak the proxy secret in error text
                const exit = yield* Effect.exit(
                  Effect.gen(function*() {
                    const client = yield* HttpClient.HttpClient
                    const resp = yield* client.execute(HttpClientRequest.get("http://192.0.2.1:80/test"))
                    return yield* resp.text
                  }).pipe(Effect.provide(EgressHttpClient.layer(env)))
                )
                if (exit._tag !== "Failure") return false
                const rendered = String(exit.cause)
                if (rendered.includes(secret)) return false
              }

              // resolveHost on loopback IP returns 127.0.0.1
              const addrs = yield* EgressHttpClient.resolveHost("127.0.0.1")
              if (!addrs.includes("127.0.0.1")) return false
              return true
            }),
          { seed, executions: Math.min(executions, 30) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    } finally {
      server.close()
    }
  })

  it("FetchTransport.observe attributes loopback responses, honors closed-observer silence, and is double-close safe", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" }).end("OBS_OK")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    const port = (server.address() as net.AddressInfo).port
    const origin = `http://127.0.0.1:${port}`

    try {
      const arb = Arbitrary.schema(
        Schema.Struct({
          closeBefore: Schema.Boolean,
          doubleClose: Schema.Boolean,
          pathSeg: Schema.Literals(["/a", "/b", "/status"])
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ closeBefore, doubleClose, pathSeg }) =>
            Effect.promise(async () => {
              const obs = FetchTransport.observe(origin)
              if (obs.runtime.node !== process.versions.node) return false
              if (closeBefore) {
                obs.close()
                if (doubleClose) obs.close()
              }
              const attempt = obs.begin()
              const res = await attempt.run(() => fetch(`${origin}${pathSeg}`))
              const text = await res.text()
              const fields = attempt.fields()
              if (!closeBefore) {
                obs.close()
                if (doubleClose) obs.close()
              }
              if (text !== "OBS_OK") return false
              if (closeBefore) {
                if (fields.transport !== undefined) return false
              } else {
                if (fields.transport === "none") return false
              }
              return true
            }),
          { seed: seed + 1, executions: Math.min(executions, 25) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    } finally {
      server.close()
    }
  })
})
