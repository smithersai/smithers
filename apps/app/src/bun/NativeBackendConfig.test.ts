import { describe, expect, test } from "bun:test"
import { nativeBackendConfig } from "./NativeBackendConfig"

describe("native backend handshake", () => {
  test("own consumes the supervisor origin", () => {
    expect(nativeBackendConfig({ SMITHERS_BACKEND_MODE: "own", SMITHERS_BACKEND_ORIGIN: "http://127.0.0.1:4400" }))
      .toEqual({
        rendererOrigin: "http://127.0.0.1:4400",
        target: {
          apiVersion: 1,
          mode: "native-own",
          apiOrigin: "http://127.0.0.1:4400",
          auth: { kind: "session" },
          cors: "same-origin",
          developerExternal: false
        },
        token: null
      })
  })

  test("Plue never requests an owned backend launch", () => {
    const config = nativeBackendConfig({
      SMITHERS_BACKEND_MODE: "plue",
      SMITHERS_API_ORIGIN: "https://plue.example.test",
      SMITHERS_RENDERER_ORIGIN: "http://127.0.0.1:5173",
      SMITHERS_API_TOKEN: "secret"
    })
    expect(config.target).toMatchObject({
      mode: "native-plue",
      auth: { kind: "bearer" },
      cors: "credentialed",
      developerExternal: false
    })
    expect(config.token).toBe("secret")
  })

  test("missing supervisor and remote origins fail before opening the app", () => {
    expect(() => nativeBackendConfig({ SMITHERS_BACKEND_MODE: "own" })).toThrow("SMITHERS_BACKEND_ORIGIN is required")
    expect(() => nativeBackendConfig({ SMITHERS_BACKEND_MODE: "plue" })).toThrow("SMITHERS_API_ORIGIN is required")
  })
})
