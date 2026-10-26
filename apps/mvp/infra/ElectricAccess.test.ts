// The Electric gateway's access check (infra/ElectricAccess.ts) on Web requests as the gateway Worker receives them, and
// the gateway's own settings: no public URL, so ChatApi's service binding is the only way in.
import { HttpServerRequest } from "effect/http"
import { describe, expect, test } from "vitest"
import { admit } from "./ElectricAccess.ts"
import * as ElectricGateway from "./ElectricGateway.ts"

const GATEWAY = "http://electric-gateway"

const request = (path: string, init: RequestInit = {}) => HttpServerRequest.fromWeb(new Request(`${GATEWAY}${path}`, init))
const shape = "/v1/shape?table=messages&offset=-1&handle=h-1"

describe("admit", () => {
  test("lets a shape request through as a new GET to the same URL with its headers", () => {
    const admission = admit(request(shape, { headers: { accept: "application/json" } }))
    expect(admission._tag).toBe("Admitted")
    const forwarded = admission._tag === "Admitted" ? admission.request : undefined
    expect(forwarded?.originalUrl).toBe(`${GATEWAY}${shape}`)
    expect(forwarded?.method).toBe("GET")
    expect(forwarded?.headers).toEqual({ accept: "application/json" })
  })

  test("refuses anything but GET /v1/shape with 404", () => {
    expect(admit(request("/v1/health"))).toEqual({ _tag: "Refused", status: 404 })
    expect(admit(request(shape, { method: "DELETE" }))).toEqual({ _tag: "Refused", status: 404 })
  })
})

describe("the gateway Worker", () => {
  test("has no public URL: no workers.dev, no previews, no domain and no routes", () => {
    const props: Record<string, unknown> = ElectricGateway.props
    expect(ElectricGateway.props.workersDev).toEqual({ enabled: false, previewsEnabled: false })
    expect(props["domain"]).toBeUndefined()
    expect(props["domains"]).toBeUndefined()
    expect(props["routes"]).toBeUndefined()
  })
})
