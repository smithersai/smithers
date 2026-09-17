import { Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { describe, expect, it } from "vitest"
import * as Auth from "../src/Auth.ts"

const credentials: Auth.Credentials = { username: "opencode", password: "hunter2" }
const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`

const served = (auth: Auth.Credentials | undefined) =>
  HttpRouter.toWebHandler(
    Layer.mergeAll(
      HttpRouter.add("GET", "/global/health", HttpServerResponse.text("ok")),
      HttpRouter.add("GET", "/session", HttpServerResponse.text("sessions")),
      Auth.layer(auth)
    ),
    { disableLogger: true }
  )

describe("Auth", () => {
  it("reads the credentials the environment configures", () => {
    expect(Auth.fromEnvironment({})).toBeUndefined()
    expect(Auth.fromEnvironment({ OPENCODE_SERVER_PASSWORD: "" })).toBeUndefined()
    expect(Auth.fromEnvironment({ OPENCODE_SERVER_PASSWORD: "pw" })).toEqual({ username: "opencode", password: "pw" })
    expect(Auth.fromEnvironment({ OPENCODE_SERVER_PASSWORD: "pw", OPENCODE_SERVER_USERNAME: "" })).toEqual({
      username: "opencode",
      password: "pw"
    })
    expect(Auth.fromEnvironment({ OPENCODE_SERVER_PASSWORD: "pw", OPENCODE_SERVER_USERNAME: "will" })).toEqual({
      username: "will",
      password: "pw"
    })
  })

  it("accepts exactly the configured basic credentials", () => {
    expect(Auth.authorizes(basic("opencode", "hunter2"), credentials)).toBe(true)
    expect(Auth.authorizes(basic("opencode", "wrong"), credentials)).toBe(false)
    expect(Auth.authorizes("Bearer token", credentials)).toBe(false)
    expect(Auth.authorizes("Basic", credentials)).toBe(false)
    expect(Auth.authorizes(undefined, credentials)).toBe(false)
  })

  it("is inert without a password", async () => {
    const { dispose, handler } = served(undefined)
    try {
      const response = await handler(new Request("http://test/session"))
      expect(response.status).toBe(200)
    } finally {
      await dispose()
    }
  })

  it("keeps health open, lets preflights through, and refuses the rest without the credentials", async () => {
    const { dispose, handler } = served(credentials)
    try {
      expect((await handler(new Request("http://test/global/health"))).status).toBe(200)
      expect((await handler(new Request("http://test/session", { method: "OPTIONS" }))).status).toBe(404)
      const refused = await handler(new Request("http://test/session?directory=x"))
      expect(refused.status).toBe(401)
      expect(refused.headers.get("www-authenticate")).toContain("Basic")
      expect(await refused.json()).toEqual({ name: "UnauthorizedError", data: { message: "Unauthorized" } })
      const accepted = await handler(
        new Request("http://test/session", { headers: { authorization: basic("opencode", "hunter2") } })
      )
      expect(accepted.status).toBe(200)
    } finally {
      await dispose()
    }
  })
})
