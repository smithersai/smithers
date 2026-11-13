import { Effect } from "effect"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { afterEach, describe, expect, it } from "vitest"
import { auth, browserLogin } from "../src/internal/backend/Auth.ts"
import { Client, object } from "../src/internal/backend/Client.ts"
import { CredentialProcess, Session } from "../src/internal/backend/Session.ts"
import { backendFixture } from "./support/backend-fixture.ts"
import { isolatedKeyring } from "./support/isolated-keyring.ts"
const dirs: string[] = []
const keyrings: Array<ReturnType<typeof isolatedKeyring>> = []
const hosts: Array<Awaited<ReturnType<typeof backendFixture>>> = []
const input = Object.getOwnPropertyDescriptor(process, "stdin")!
const platform = Object.getOwnPropertyDescriptor(process, "platform")!
afterEach(async () => {
  Object.defineProperty(process, "stdin", input)
  Object.defineProperty(process, "platform", platform)
  for (const keyring of keyrings.splice(0)) keyring.close()
  for (const host of hosts.splice(0).reverse()) await host.close()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
const fixture = async (env: Record<string, string> = {}) => {
  const home = await mkdtemp(join(tmpdir(), "one-cli-auth-"))
  dirs.push(home)
  const controller = new AbortController()
  const c = new Client({
    environment: {
      HOME: home,
      XDG_CONFIG_HOME: home,
      SMITHERS_AUTH_FILE: join(home, "auth.json"),
      SMITHERS_API_ORIGIN: "https://api.example.test",
      SMITHERS_DISABLE_SYSTEM_KEYRING: "1",
      ...env
    },
    signal: controller.signal,
    stderr: { write: () => {}, isTTY: false, columns: 80 }
  })
  return { c, home, controller }
}
const callback = (url: string) => {
  const params = new URL(url).searchParams
  return { params, url: `http://127.0.0.1:${params.get("callback_port")}/callback` }
}
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", origin: new URL(url).origin, ...headers },
    body: JSON.stringify(body)
  })

describe("browser consent", () => {
  it("validates callback method, route, media type and state before saving a login", async () => {
    const { c } = await fixture()
    let complete!: Promise<void>
    const login = browserLogin(c, "https://api.example.test", true, "30m", (url) => {
      complete = (async () => {
        const { url: destination, params } = callback(url)
        expect(params.get("admin")).toBe("1")
        expect(params.get("ttl")).toBe("30m")
        expect((await fetch(destination.replace("callback", "other"))).status).toBe(404)
        expect((await fetch(destination, { method: "PUT" })).status).toBe(405)
        expect((await post(destination, {}, { "content-type": "text/plain" })).status).toBe(415)
        expect((await post(destination, { callback_state: "bad" })).status).toBe(403)
        expect(
          (await post(destination, {
            callback_state: params.get("callback_state"),
            token: "admin-secret",
            expires_at: new Date(Date.now() + 60_000).toISOString()
          })).status
        ).toBe(200)
      })()
    })
    expect(await login).toMatchObject({ token: "admin-secret" })
    await complete
  })
  it("refuses a DNS-rebinding page's Host or Origin even with the callback state", async () => {
    const { c } = await fixture()
    let complete!: Promise<void>
    const login = browserLogin(c, "https://api.example.test", false, "", (url) => {
      complete = (async () => {
        const { url: destination, params } = callback(url), state = params.get("callback_state")!
        const port = Number(new URL(destination).port)
        const rebound = (method: string, body?: string) =>
          new Promise<number>((resolve, reject) => {
            const req = httpRequest({
              host: "127.0.0.1",
              port,
              path: "/callback",
              method,
              headers: { host: `evil.example:${port}`, "content-type": "application/json" }
            }, (res) => {
              res.resume()
              resolve(res.statusCode ?? 0)
            })
            req.once("error", reject)
            req.end(body)
          })
        expect(await rebound("GET")).toBe(403)
        expect(await rebound("POST", JSON.stringify({ callback_state: state, token: "stolen" }))).toBe(403)
        expect(
          (await post(destination, { callback_state: state, token: "stolen" }, {
            origin: `http://evil.example:${port}`
          }))
            .status
        ).toBe(403)
        expect((await post(destination, { callback_state: state, token: "browser-secret" })).status).toBe(200)
      })()
    })
    expect(await login).toMatchObject({ token: "browser-secret" })
    await complete
  })
  it.each([{ token: " " }, { token: "a b" }, { token: "secret", expires_at: "2000-01-01" }])(
    "refuses invalid admin callback %j",
    async (value) => {
      const { c } = await fixture()
      let submitted!: Promise<Response>
      const login = browserLogin(c, "https://api.example.test", true, "", (url) => {
        const target = callback(url)
        submitted = post(target.url, { callback_state: target.params.get("callback_state"), ...value })
      })
      await expect(login).rejects.toThrow()
      expect((await submitted).status).toBe(400)
    }
  )
  it("expires an unresolved browser login", async () => {
    const { c } = await fixture()
    await expect(browserLogin(c, "https://api.example.test", false, "", () => {}, 1)).rejects.toThrow("Timed out")
  })
  it("cancels a pending browser login", async () => {
    const { c, controller } = await fixture()
    await expect(browserLogin(c, "https://api.example.test", false, "", () => controller.abort())).rejects.toThrow(
      "cancelled"
    )
  })
  it("refuses an Observe login before browser consent when observe_url is not configured", async () => {
    const f = await backendFixture()
    hosts.push(f)
    await expect(auth["auth login"]!(f.c, {}, { observe: true })).rejects.toThrow("observe_url is not configured")
    expect(f.exec.calls).toEqual([])
    expect(f.received).toEqual([])
  })
  it.each([false, true])("uses a one-time Observe handoff after browser consent (bad ticket=%s)", async (badTicket) => {
    const f = await backendFixture({ SMITHERS_TOKEN: "" })
    hosts.push(f)
    const observe = await backendFixture()
    hosts.push(observe)
    const { c } = f, origin = observe.origin
    c.session.saveConfig({ observe_url: origin })
    observe.allow("observe-secret")
    observe.request.respond({ ticket: badTicket ? "invalid" : "t".repeat(43) })
    const launched: string[] = []
    f.browser(async (url) => {
      launched.push(url)
      if (url.includes("/api/auth/github/cli")) {
        const target = callback(url)
        expect(target.params.get("admin")).toBe("1")
        expect(target.params.get("ttl")).toBe("1h30m")
        expect(
          (await post(target.url, {
            callback_state: target.params.get("callback_state"),
            token: "observe-secret",
            expires_at: new Date(Date.now() + 60_000).toISOString()
          })).status
        ).toBe(200)
        return
      }
      const params = new URLSearchParams(new URL(url).hash.slice(1)),
        loopback = `http://127.0.0.1:${params.get("port")}`,
        destination = loopback + "/observe"
      expect((await fetch(loopback + "/wrong")).status).toBe(403)
      expect((await fetch(destination)).headers.get("referrer-policy")).toBe("no-referrer")
      expect((await post(destination, {})).status).toBe(403)
      expect((await post(destination, { state: "wrong", challenge: "c".repeat(43) })).status).toBe(403)
      const response = await post(destination, { state: params.get("state"), challenge: "c".repeat(43) })
      expect(response.status).toBe(badTicket ? 502 : 200)
      if (!badTicket) {
        const data = object(await response.json())
        expect(data.url).toBe(
          `${origin}/login/cli#${new URLSearchParams({ state: params.get("state")!, ticket: "t".repeat(43) })}`
        )
        expect(data.url).not.toContain("observe-secret")
      }
    })
    const login = auth["auth login"]!(c, {}, { observe: true, ttl: "1h30m" })
    if (badTicket) await expect(login).rejects.toThrow("Observe sign-in failed")
    else expect(await login).toMatchObject({ status: "logged_in", admin: true })
    await f.browserDone()
    expect(launched).toHaveLength(2)
    expect(f.received).toEqual([])
    expect(observe.received).toEqual([{
      method: "POST",
      path: "/api/v1/auth/browser-handoff",
      authorization: "token observe-secret",
      body: { challenge: "c".repeat(43) }
    }])
    expect((await c.session.require(f.origin))?.token).toBe("observe-secret")
  })
})

describe("subscription storage and owner input", () => {
  it("refuses Claude subscription logins and unsupported providers", async () => {
    const { c, home } = await fixture()
    Object.defineProperty(process, "stdin", { configurable: true, value: Readable.from(["API-key"]) })
    await expect(auth["auth connect"]!(c, { provider: "claude" }, { "api-key": true })).rejects.toThrow("API key")
    await writeFile(join(home, ".credentials.json"), "{}")
    await expect(auth["auth connect"]!(c, { provider: "claude" }, { "config-dir": home })).rejects.toThrow(
      "never stored"
    )
    await expect(auth["auth connect"]!(c, { provider: "other" }, {})).rejects.toThrow("Provider")
  })
  it("never reads the Claude keychain entry", async () => {
    const f = await backendFixture()
    hosts.push(f)
    await expect(auth["auth connect"]!(f.c, { provider: "claude" }, { "config-dir": f.home })).rejects.toThrow(
      "never stored"
    )
    expect(f.exec.calls).toEqual([])
    expect(f.received).toEqual([])
  })
  it("deletes the legacy Claude setup token entry without reading it (#2777)", async () => {
    const keyring = isolatedKeyring()
    keyrings.push(keyring)
    const f = await backendFixture()
    hosts.push(f)
    const environment = { ...f.environment, ...keyring.environment, SMITHERS_DISABLE_SYSTEM_KEYRING: "" }
    const calls: Array<Parameters<typeof CredentialProcess.live.run>> = []
    let failed = false
    const commands = CredentialProcess.of({
      run: (...args) =>
        Effect.suspend(() => {
          calls.push(args)
          return failed
            ? Effect.fail(new Error("Secure credential storage delete failed"))
            : CredentialProcess.live.run(...args)
        })
    })
    const c = new Client({ environment }, false, new Session(environment, commands))
    await c.session.keyring("delete", "claude.subscription-token")
    const legacyAccount = calls[0]![2].env.SMITHERS_CRED_HOST
    calls.length = 0
    Object.defineProperty(process, "stdin", { configurable: true, value: Readable.from(["sk-ant-api03-key"]) })
    f.request.respond({ id: "conn-1" })
    await auth["auth connect"]!(c, { provider: "claude" }, { "api-key": true })
    await expect(auth["auth connect"]!(c, { provider: "claude" }, {})).rejects.toThrow("never stored")
    expect(await auth["auth logout"]!(c, {}, {})).toMatchObject({ status: "logged_out" })
    const legacy = () => calls.filter(([, , options]) => options.env.SMITHERS_CRED_HOST === legacyAccount)
    expect(legacy()).toHaveLength(3)
    expect(
      legacy().every(([, args]) =>
        args[0] === (process.platform === "darwin" ? "delete-generic-password" : "clear") ||
        process.platform === "win32"
      )
    ).toBe(true)
    expect(f.received).toHaveLength(1)

    calls.length = 0
    failed = true
    expect(await auth["auth logout"]!(c, {}, {})).toMatchObject({ status: "logged_out" })
    await auth["auth connect"]!(c, { provider: "codex" }, { "config-dir": "missing" }).catch(() => undefined)
    expect(legacy()).toHaveLength(1)
  })
  it.each(["hello", "", " ", "x".repeat(4 * 1024 * 1024 + 1)].map((value) => ({ value, size: value.length })))(
    "bounds stdin input ($size bytes)",
    async ({ value }) => {
      const { c } = await fixture()
      Object.defineProperty(process, "stdin", { configurable: true, value: Readable.from([value]) })
      if (!value.trim() || value.length > 4 * 1024 * 1024) await expect(c.stdin("Secret")).rejects.toThrow()
      else expect(await c.stdin("Secret")).toBe(value)
    }
  )
})
