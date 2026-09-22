import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { parseNativeWindowDriverEnvelope } from "./native-window"

describe("packaged native-window matrix driver", () => {
  test("resolves a secret-free CEF launch envelope for each native mode", () => {
    expect(parseNativeWindowDriverEnvelope(JSON.stringify({
      executable: "artifacts/Smithers.app/Contents/MacOS/launcher",
      cdpEndpoint: "http://127.0.0.1:9333",
      environment: { SMITHERS_BACKEND_MODE: "own" }
    }), "native-own", "/workspace")).toEqual({
      executable: resolve("/workspace/artifacts/Smithers.app/Contents/MacOS/launcher"),
      cdpEndpoint: "http://127.0.0.1:9333",
      environment: { SMITHERS_BACKEND_MODE: "own" }
    })

    expect(parseNativeWindowDriverEnvelope(JSON.stringify({
      executable: "/Applications/Smithers.app/Contents/MacOS/launcher",
      cdpEndpoint: "http://localhost:9444/",
      environment: { SMITHERS_BACKEND_MODE: "plue", SMITHERS_API_ORIGIN: "https://plue.example.test" }
    }), "native-plue", "/workspace").cdpEndpoint).toBe("http://localhost:9444")
  })

  test("rejects a web-tab substitute, fixture stub, or bridge credential override", () => {
    expect(() => parseNativeWindowDriverEnvelope(JSON.stringify({
      executable: "/tmp/launcher",
      cdpEndpoint: "https://browser.example.test:9333",
      environment: { SMITHERS_BACKEND_MODE: "own" }
    }), "native-own", "/workspace")).toThrow("loopback")
    expect(() => parseNativeWindowDriverEnvelope(JSON.stringify({
      executable: "/tmp/launcher",
      cdpEndpoint: "http://127.0.0.1:9333",
      environment: { SMITHERS_BACKEND_MODE: "plue", SMITHERS_CHAT_STUB: "1" }
    }), "native-plue", "/workspace")).toThrow("refuses the deterministic chat stub")
    expect(() => parseNativeWindowDriverEnvelope(JSON.stringify({
      executable: "/tmp/launcher",
      cdpEndpoint: "http://127.0.0.1:9333",
      environment: { SMITHERS_BACKEND_MODE: "own", SMITHERS_E2E_BRIDGE_TOKEN: "caller-token" }
    }), "native-own", "/workspace")).toThrow("reserved SMITHERS_E2E_BRIDGE_TOKEN")
  })

  test("requires mode-correct native backend ownership", () => {
    expect(() => parseNativeWindowDriverEnvelope(JSON.stringify({
      executable: "/tmp/launcher",
      cdpEndpoint: "http://127.0.0.1:9333",
      environment: { SMITHERS_BACKEND_MODE: "plue" }
    }), "native-own", "/workspace")).toThrow("SMITHERS_BACKEND_MODE=own")
  })
})
