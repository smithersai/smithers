/**
 * The webhook sink over a host's own HTTP client, against real HTTP on
 * loopback.
 *
 * A host that sends its outbound requests through one guarded client composes
 * `Alerts.layerWebhookClient`, and the page goes through that client or not
 * at all: a client that denies the endpoint denies the page, and no request
 * reaches the receiver some other way.
 */
import { Effect, Layer } from "effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import * as Alerts from "../src/Alerts.ts"

/** One request a receiver got. */
interface Received {
  readonly method: string | undefined
  readonly path: string | undefined
  readonly authorization: string | undefined
  readonly idempotencyKey: string | undefined
  readonly body: unknown
}

/** A receiver on loopback that answers every request the way `answer` says. */
const receiver = (answer: () => { readonly status: number; readonly location?: string }) => {
  const received: Array<Received> = []
  const server: Server = createServer((request, response) => {
    let raw = ""
    request.setEncoding("utf8")
    request.on("data", (chunk: string) => (raw += chunk))
    request.on("end", () => {
      received.push({
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        idempotencyKey: request.headers["idempotency-key"] as string | undefined,
        body: raw === "" ? undefined : JSON.parse(raw)
      })
      const { location, status } = answer()
      response.writeHead(status, location === undefined ? {} : { location })
      response.end()
    })
  })
  return {
    received,
    origin: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    open: () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

let redirectTo: string | undefined
const pager = receiver(() => redirectTo === undefined ? { status: 204 } : { status: 307, location: redirectTo })
const collector = receiver(() => ({ status: 204 }))

beforeAll(() => Promise.all([pager.open(), collector.open()]))
afterAll(() => Promise.all([pager.close(), collector.close()]))
beforeEach(() => {
  redirectTo = undefined
  pager.received.length = 0
  collector.received.length = 0
})

const alert: Alerts.Alert = {
  runId: "run-1",
  condition: "stalled",
  since: 0,
  opening: 7,
  firedAt: 0,
  severity: "critical",
  coalescingKey: Alerts.coalescingKey("run-1", "stalled")
}

/** One delivery through `Alerts.layerWebhookClient` over the client `host` provides. */
const deliver = (host: Layer.Layer<HttpClient.HttpClient>) =>
  Effect.runPromise(
    Effect.flatMap(Alerts.Sink, (sink) => Effect.result(sink.deliver(alert))).pipe(
      Effect.provide(
        Alerts.layerWebhookClient({
          url: `${pager.origin()}/alerts`,
          headers: { authorization: "Bearer SYNTHETIC_PAGER_TOKEN" }
        }).pipe(Layer.provide(host))
      )
    )
  )

/** A host's client: the real fetch transport, with every request it was asked to make recorded. */
const hostClient = (attempts: Array<string>) =>
  Layer.effect(HttpClient.HttpClient)(
    Effect.map(
      HttpClient.HttpClient,
      HttpClient.tapRequest((request) => Effect.sync(() => void attempts.push(request.url)))
    )
  ).pipe(Layer.provide(FetchHttpClient.layer))

describe("Alerts.layerWebhookClient", () => {
  it("pages through the client the host provides", async () => {
    const attempts: Array<string> = []
    const result = await deliver(hostClient(attempts))

    expect(result._tag).toBe("Success")
    expect(attempts).toEqual([`${pager.origin()}/alerts`])
    expect(pager.received).toEqual([{
      method: "POST",
      path: "/alerts",
      authorization: "Bearer SYNTHETIC_PAGER_TOKEN",
      idempotencyKey: Alerts.alertId(alert),
      body: { ...alert, alertId: Alerts.alertId(alert) }
    }])
  })

  it("reports a host client's denial, and sends the page nowhere else", async () => {
    const attempts: Array<string> = []
    // A host's destination policy, failing the way the kernel's guarded client fails a request it may not make.
    const denying = Layer.succeed(HttpClient.HttpClient)(
      HttpClient.make((request) => {
        attempts.push(request.url)
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, description: "destination denied by host policy" })
          })
        )
      })
    )
    const result = await deliver(denying)

    expect(result._tag === "Failure" ? result.failure : result).toMatchObject({
      _tag: "/notifications/AlertError",
      code: "sink_unreachable",
      reason: "TransportError"
    })
    // The host saw one attempt, and no request reached the receiver around it.
    expect(attempts).toEqual([`${pager.origin()}/alerts`])
    expect(pager.received).toEqual([])
    // The refusal names neither the endpoint nor the credential.
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_PAGER_TOKEN")
    expect(JSON.stringify(result)).not.toContain(pager.origin())
  })

  it("calls a redirect a refusal, and the place it points to receives nothing", async () => {
    redirectTo = `${collector.origin()}/stolen`
    const attempts: Array<string> = []
    const result = await deliver(hostClient(attempts))

    expect(result._tag === "Failure" ? result.failure : result).toMatchObject({ code: "sink_rejected", status: 307 })
    expect(pager.received).toHaveLength(1)
    // The request carried a credential. Following the 307 would hand it to another origin.
    expect(collector.received).toEqual([])
    expect(attempts).toEqual([`${pager.origin()}/alerts`])
  })
})
