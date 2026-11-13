import * as FastCheck from "fast-check"
import { expect, it } from "vitest"
import { rpcUrl, websocketUrl } from "../src/internal/RemoteUrl.ts"

it.each(["", "/", "/rpc", "/rpc/", "/rpc///", "/prefix", "/prefix/", "/prefix/rpc", "/prefix/rpc/"])(
  "shares an RPC base for HTTP and WebSocket URLs at %s",
  (path) => {
    const base = path.startsWith("/prefix") ? "/prefix/rpc" : "/rpc"
    expect(rpcUrl(`https://control.example.test${path}?mode=test#detail`))
      .toBe(`https://control.example.test${base}?mode=test#detail`)
    expect(websocketUrl(`https://control.example.test${path}?mode=test#detail`))
      .toBe(`https://control.example.test${base}/ws`)
  }
)

it("normalizes arbitrary trailing slash counts on explicit RPC URLs", () => {
  FastCheck.assert(FastCheck.property(
    FastCheck.integer({ min: 0, max: 64 }),
    FastCheck.boolean(),
    (count, prefixed) => {
      const base = prefixed ? "/prefix/rpc" : "/rpc"
      const remote = `http://control.example.test${base}${"/".repeat(count)}`
      expect(rpcUrl(remote)).toBe(`http://control.example.test${base}`)
      expect(websocketUrl(remote)).toBe(`http://control.example.test${base}/ws`)
    }
  ))
})
