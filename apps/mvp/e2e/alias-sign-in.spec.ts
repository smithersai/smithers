import { expect } from "@playwright/test"
import { ARRIVE_ROUTE, SESSION_ROUTE, SIGN_IN, SIGN_OUT } from "../src/features/auth/contract"
import { test } from "./fixtures"
import { baseURL, me, requires } from "./target"

// Sign-in at an alias (decision 0130, docs/features/sign-in.md#other-hosts): the deployment's GitHub App lists one
// callback, on APP_DOMAIN, and an alias signs in through it. The deployment project starts every test signed in at
// APP_DOMAIN (e2e/deployment/sign-in.setup.ts), so pressing Sign in at the alias comes back signed in without GitHub,
// and signing out there leaves that shared session alone.

test("an alias signs in through the home domain's one callback, and signs out on its own", { annotation: { type: "summary", description: "Signing in at an alias goes through the home domain, never carries the code in a URL, and signing out there keeps the home session." } }, async ({ page }) => {
  requires("aliasSignIn")
  const alias = new URL(process.env.E2E_ALIAS_URL!).origin
  const home = new URL(baseURL).origin
  const seen: Array<{ readonly url: string; readonly referer: string }> = []
  page.on("request", (request) => void seen.push({ url: request.url(), referer: request.headers()["referer"] ?? "" }))
  const sessionAt = async (origin: string) => (await page.request.get(`${origin}${SESSION_ROUTE}`)).json()

  await test.step("Open the alias as a visitor", async () => {
    expect(await sessionAt(home)).toMatchObject({ signedIn: true })
    expect(await sessionAt(alias)).toMatchObject({ signedIn: false })
    await page.goto(`${alias}/app`)
  })

  await test.step("Press Sign in with GitHub on the alias", async () => {
    await page.getByRole("link", { name: SIGN_IN, exact: true }).first().click()
    await page.waitForURL((url) => url.origin === alias && url.pathname === "/app", { timeout: 30_000 })
    await expect(page.getByRole("button", { name: SIGN_OUT })).toBeVisible({ timeout: 30_000 })
    expect(await sessionAt(alias)).toMatchObject({ signedIn: true, login: me().login })
  })

  await test.step("The code never reached a URL or a Referer", async () => {
    expect(seen.some((request) => request.url.startsWith(`${home}/api/auth/handoff`))).toBe(true)
    expect(seen.some((request) => request.url.startsWith(`${alias}${ARRIVE_ROUTE}`))).toBe(true)
    // GitHub was never asked: the home session handed itself over.
    expect(seen.filter((request) => new URL(request.url).hostname === "github.com")).toEqual([])
    for (const request of seen) {
      expect(request.url, request.url).not.toMatch(/[?&#]code=/)
      expect(request.referer, request.url).not.toMatch(/code=/)
    }
    expect(page.url()).not.toContain("code=")
  })

  await test.step("Sign out at the alias: the home session stays", async () => {
    await page.getByRole("button", { name: SIGN_OUT }).click()
    await expect(page.getByRole("link", { name: SIGN_IN, exact: true }).first()).toBeVisible({ timeout: 30_000 })
    expect(await sessionAt(alias)).toMatchObject({ signedIn: false })
    expect(await sessionAt(home)).toMatchObject({ signedIn: true, login: me().login })
  })
})
