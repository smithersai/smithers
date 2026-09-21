import { describe, expect, test } from "vitest"
import { resolveApplicationTarget, startsOwnedBackend } from "../src/ApplicationTarget"

const PAGE = "https://app.example.test"

describe("application target matrix", () => {
  test.each([
    ["web-selfhost", "", "session", "owner", "none"],
    ["web-plue", "", "session", "plue", "none"],
    ["local-own", "http://127.0.0.1:4100", "token", "owner", "connect"],
    ["local-plue", "https://plue.example.test", "bearer", "plue", "none"],
    ["native-own", "http://127.0.0.1:4200", "session", "owner", "supervisor"],
    ["native-plue", "https://plue.example.test", "bearer", "plue", "none"]
  ] as const)("resolves %s without mode-specific product behavior", (mode, apiOrigin, auth, ownership, launch) => {
    const external = apiOrigin !== "" && apiOrigin !== PAGE
    const target = resolveApplicationTarget({
      apiVersion: 1,
      mode,
      apiOrigin,
      auth: { kind: auth },
      cors: external && mode.endsWith("plue") ? "credentialed" : "same-origin",
      developerExternal: mode === "web-plue" && external
    }, PAGE)
    expect({ ownership: target.ownership, launch: target.launch }).toEqual({ ownership, launch })
    expect(startsOwnedBackend(target)).toBe(mode === "native-own")
  })

  test("remote modes never select the supervisor", () => {
    for (const mode of ["web-plue", "local-plue", "native-plue"] as const) {
      const target = resolveApplicationTarget({
        apiVersion: 1,
        mode,
        apiOrigin: mode === "web-plue" ? "" : "https://plue.example.test",
        auth: { kind: mode === "web-plue" ? "session" : "bearer" },
        cors: mode === "web-plue" ? "same-origin" : "credentialed",
        developerExternal: false
      }, PAGE)
      expect(startsOwnedBackend(target)).toBe(false)
    }
  })

  test("rejects implicit cross-origin Plue and missing owned launch handshakes", () => {
    expect(() => resolveApplicationTarget({
      apiVersion: 1,
      mode: "web-plue",
      apiOrigin: "https://plue.example.test",
      auth: { kind: "bearer" }
    }, PAGE)).toThrow("developerExternal")
    expect(() => resolveApplicationTarget({
      apiVersion: 1,
      mode: "native-own",
      apiOrigin: "",
      auth: { kind: "session" }
    }, PAGE)).toThrow("launch handshake")
  })
})
