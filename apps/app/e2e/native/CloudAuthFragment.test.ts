import { expect, test } from "bun:test"
import { chromium } from "playwright"
import { createCloudAuth } from "../../src/bun/CloudAuth"

test("interactive browser login verifies fragment state and refuses foreign or legacy callbacks", async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    for (const supportsState of [true, false]) {
      let destination = ""
      let probes = 0
      let saved: string | null = null
      const credentials = { token: "smithers_browser_fixture", username: "native-user", email: "native@example.test", expires_at: "2099-01-01T00:00:00Z" }
      const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(`<form action="${destination}"><button>Authorize</button></form>`, { headers: { "content-type": "text/html" } }) })
      let callback = ""
      let state = ""
      const api = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => {
        const url = new URL(request.url)
        if (url.pathname === "/api/auth/github/cli") {
          callback = `http://127.0.0.1:${url.searchParams.get("callback_port")}/callback`
          state = url.searchParams.get("callback_state") ?? ""
          return Response.redirect(`http://localhost:${provider.port}/authorize`)
        }
        const fragment = new URLSearchParams(credentials)
        if (supportsState) fragment.set("callback_state", state)
        return Response.redirect(`${callback}#${fragment}`)
      } })
      destination = `http://127.0.0.1:${api.port}/complete`
      const auth = await createCloudAuth({ api: `http://127.0.0.1:${api.port}`,
        keychain: { read: async () => null, write: async (_service, _account, value) => { saved = value }, remove: async () => { saved = null } },
        fetchImpl: async () => { probes++; return new Response("[]") }
      })
      const context = await browser.newContext()
      const page = await context.newPage()
      let foreign: ReturnType<typeof Bun.serve> | undefined
      try {
        const start = await auth.start()
        if (!("url" in start)) throw new Error(start.error)
        const login = new URL(start.url)
        callback = `http://127.0.0.1:${login.searchParams.get("callback_port")}/callback`
        const fakeFragment = new URLSearchParams({ ...credentials, callback_state: "A".repeat(43) })
        foreign = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(`<a href="${callback}#${fakeFragment}">Continue</a>`, { headers: { "content-type": "text/html" } }) })
        await page.goto(`http://localhost:${foreign.port}`)
        await page.getByRole("link", { name: "Continue" }).click()
        await page.getByText("Sign-in could not be verified.", { exact: false }).waitFor()
        expect(page.url()).toBe(callback)
        expect(auth.session().state).toBe("signing-in")
        expect(probes).toBe(0)
        expect(saved).toBeNull()
        const bridge = await fetch(callback)
        expect(bridge.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
        expect(await bridge.text()).not.toContain(login.searchParams.get("callback_state")!)

        await page.goto(start.url)
        await page.getByRole("button", { name: "Authorize" }).click()
        await page.getByText(supportsState ? "Return to Smithers to finish signing in." : "Sign-in could not be verified.", { exact: false }).waitFor()
        expect(page.url()).toBe(callback)
        const deadline = Date.now() + 2000
        while (supportsState && saved === null && Date.now() < deadline) await Bun.sleep(10)
        expect(auth.token()).toBe(supportsState ? credentials.token : undefined)
        expect(probes).toBe(supportsState ? 1 : 0)
        if (supportsState) expect(JSON.parse(saved!)).toMatchObject({ token: credentials.token, expiresAt: credentials.expires_at })
        else expect(saved).toBeNull()
      } finally {
        await context.close()
        await auth.stop()
        foreign?.stop(true)
        provider.stop(true)
        api.stop(true)
      }
    }
  } finally {
    await browser.close()
  }
}, 30_000)
