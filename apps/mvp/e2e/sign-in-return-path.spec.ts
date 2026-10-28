import { CALLBACK_ROUTE, SIGN_IN } from "../src/features/auth/contract"
import { signInPrompt } from "./firstRun"
import { expect, step, test } from "./fixtures"
import { baseURL, requires, signedOut } from "./target"

// Fresh visitor cookies only. The real worker stores and consumes an attempt; a denial never redeems a GitHub code.
test.use({ ...signedOut })

test("sign-in return paths: declining GitHub stays on Smithers after URL normalization", {
  annotation: { type: "summary", description: "An unsafe return address sends the visitor home after declining sign-in." },
}, async ({ page }) => {
  requires("githubSignIn")
  const origin = new URL(baseURL).origin
  for (const target of [
    "/.//first.example/.//second.example", "/a/..//evil.example", "/%2e//evil.example",
    "/a/%2e%2e//evil.example", "/.\\/evil.example", "/.\t//evil.example",
    "/\\evil.example", "/\t/evil.example",
  ]) {
    await step("Decline sign-in with an unsafe return address", async () => {
      const started = await page.request.get(`/api/auth/sign-in?return=${encodeURIComponent(target)}`, { maxRedirects: 0 })
      expect(started.status()).toBe(302)
      const authorize = new URL(started.headers().location!)
      expect(`${authorize.origin}${authorize.pathname}`).toBe("https://github.com/login/oauth/authorize")
      expect(authorize.searchParams.get("redirect_uri")).toBe(`${origin}${CALLBACK_ROUTE}`)
      const state = authorize.searchParams.get("state")!
      expect(state).not.toBeNull()
      const response = await page.request.get(`${CALLBACK_ROUTE}?${new URLSearchParams({ state, error: "access_denied" })}`, { maxRedirects: 0 })
      expect(response.status()).toBe(303)
      expect(response.headers().location, target).toBe("/?sign_in=failed")
      expect(new URL(response.headers().location!, origin).origin).toBe(origin)
    })
  }
  await step("The visitor stays signed out on Smithers", async () => {
    const response = await page.request.get("/api/auth/session")
    expect(response.status()).toBe(200)
    expect(await response.json()).toMatchObject({ signedIn: false })
    await page.goto("/app")
    expect(new URL(page.url()).origin).toBe(origin)
    await expect(signInPrompt(page)).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole("link", { name: SIGN_IN }).first()).toBeVisible()
  })
})
