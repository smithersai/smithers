import { describe, expect, it } from "vitest"
import * as Policy from "../src/internal/HttpProxyPolicy.ts"

describe("HTTP proxy boundary policy", () => {
  it("normalizes all Connection fields and strips blank or duplicate names", () => {
    expect(Policy.connectionHeaderNames([" Keep-Alive, X-Private ", "x-private,, Upgrade"]))
      .toEqual(new Set(["keep-alive", "x-private", "upgrade"]))
    expect(Policy.connectionHeaderNames(" CLOSE , X-Internal ")).toEqual(new Set(["close", "x-internal"]))
    expect(Policy.connectionHeaderNames(undefined)).toEqual(new Set())
    expect(Policy.connectionHeaderNames([])).toEqual(new Set())
  })

  it("does not echo arbitrary upstream error code text", () => {
    for (const code of [undefined, 42, "private-value", "E" + "X".repeat(64), ""]) {
      expect(Policy.upstreamFailure({ code })).toBe("upstream request failed")
    }
    expect(Policy.upstreamFailure({ code: "ECONNRESET" })).toBe("upstream request failed: ECONNRESET")
  })

  it("routes default HTTP and HTTPS ports and preserves explicit ports", () => {
    expect(Policy.destinationPort(new URL("http://example.test/path"))).toBe(80)
    expect(Policy.destinationPort(new URL("https://example.test/path"))).toBe(443)
    expect(Policy.destinationPort(new URL("https://example.test:8443/path"))).toBe("8443")
  })
})

it("uses fixed defaults only for absent native request and response metadata", () => {
  expect(Policy.requestTarget(undefined)).toBe("")
  expect(Policy.requestTarget("/x?y=1")).toBe("/x?y=1")
  expect(Policy.upstreamStatus(undefined)).toBe(502)
  expect(Policy.upstreamStatus(204)).toBe(204)
})

it("reports HTTP representation failures by declaration name alone", () => {
  expect(Policy.unrepresentableRequest([])).toBe("the request could not be represented as an http request")
  expect(Policy.unrepresentableRequest(["TOKEN", "DESTINATION"]))
    .toBe("the declared secret TOKEN, DESTINATION produced an invalid request target")
})

it("refuses brokered paths whose URL normalization changes the origin", () => {
  for (const path of ["*", "//elsewhere.invalid/x", "/\\elsewhere.invalid/x"]) {
    expect(Policy.brokeredTarget("https://example.test", path))
      .toBe("brokered origin requires an origin-form request target")
  }
  const target = Policy.brokeredTarget("https://example.test", "/a?b=1")
  expect(target).toBeInstanceOf(URL)
  expect((target as URL).href).toBe("https://example.test/a?b=1")
})

it("drops retained upload bytes at first overflow and ignores every subsequent chunk", () => {
  const state = { bytes: 0, rejected: false }
  const chunks: Array<Uint8Array> = []
  const accepted = Uint8Array.of(1, 2, 3)
  expect(Policy.appendUploadChunk(state, chunks, accepted, 3)).toBe(false)
  expect(state).toEqual({ bytes: 3, rejected: false })
  expect(chunks).toEqual([accepted])
  expect(Policy.appendUploadChunk(state, chunks, Uint8Array.of(4), 3)).toBe(true)
  expect(state).toEqual({ bytes: 4, rejected: true })
  expect(chunks).toEqual([])
  expect(Policy.appendUploadChunk(state, chunks, Uint8Array.of(5, 6), 3)).toBe(false)
  expect(state).toEqual({ bytes: 4, rejected: true })
  expect(chunks).toEqual([])
})
