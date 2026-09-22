import { describe, expect, test } from "bun:test"
import { nativeBackendConfig } from "./NativeBackendConfig"

describe("native backend handshake", () => {
  test("own consumes the supervisor origin", () => {
    expect(nativeBackendConfig({}, {
      mode: "own",
      origin: "http://127.0.0.1:4400",
      bootstrapToken: "native-bootstrap",
      failure: undefined,
      stop: async () => {}
    }))
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
        token: null,
        bootstrapToken: "native-bootstrap"
      })
  })

  test("Plue never requests an owned backend launch", () => {
    const config = nativeBackendConfig({
      SMITHERS_API_ORIGIN: "https://plue.example.test",
      SMITHERS_RENDERER_ORIGIN: "http://127.0.0.1:5173",
      SMITHERS_API_TOKEN: "secret"
    }, { mode: "plue", origin: undefined, bootstrapToken: undefined, failure: undefined, stop: async () => {} })
    expect(config.target).toMatchObject({
      mode: "native-plue",
      auth: { kind: "bearer" },
      cors: "credentialed",
      developerExternal: false
    })
    expect(config.token).toBe("secret")
    expect(config.bootstrapToken).toBeNull()
  })

  test("missing supervisor and remote origins fail before opening the app", () => {
    expect(() => nativeBackendConfig({}, {
      mode: "own", origin: "", bootstrapToken: undefined, failure: undefined, stop: async () => {}
    })).toThrow("owned backend origin is required")
    expect(() => nativeBackendConfig({}, {
      mode: "plue", origin: undefined, bootstrapToken: undefined, failure: undefined, stop: async () => {}
    })).toThrow("SMITHERS_API_ORIGIN is required")
  })
})
