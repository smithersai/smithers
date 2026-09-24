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

  test("own never adopts a Plue bearer exported in the launcher shell", () => {
    const config = nativeBackendConfig({ SMITHERS_API_TOKEN: "plue-pat" }, {
      mode: "own", origin: "http://127.0.0.1:4400", bootstrapToken: "setup", failure: undefined, stop: async () => {}
    })
    expect(config.token).toBeNull()
    expect(config.target.auth).toEqual({ kind: "session" })
  })

  test("owned backend uses the packaged renderer proxy for its API", () => {
    const config = nativeBackendConfig({}, {
      mode: "own", origin: "http://127.0.0.1:4400", bootstrapToken: "setup", failure: undefined, stop: async () => {}
    }, "http://127.0.0.1:5100")
    expect(config.rendererOrigin).toBe("http://127.0.0.1:5100")
    expect(config.target).toMatchObject({ mode: "native-own", apiOrigin: "http://127.0.0.1:5100", cors: "same-origin" })
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
