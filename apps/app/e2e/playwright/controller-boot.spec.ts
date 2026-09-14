import { expect, test } from "@playwright/test"

test("fresh cloud tutorial controls work while identity is still loading", async ({ page }) => {
  let release!: () => void
  let reached!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const requested = new Promise<void>(resolve => { reached = resolve })
  let bootstrapReads = 0
  let identityReads = 0
  await page.route("**/api/bootstrap", route => {
    bootstrapReads++
    return route.fulfill({ json: {
      apiVersion: 1, host: "cloud", version: "test", buildSha: "test",
      capabilities: ["identity"], authFlow: "redirect", sandbox: null,
    } })
  })
  await page.route("**/api/auth/session", async route => {
    identityReads++
    reached()
    await held
    await route.fulfill({ json: { status: "signed-out" } })
  })
  try {
    await page.goto("/", { waitUntil: "domcontentloaded" })
    await requested
    await expect(page.getByRole("button", { name: "Show issues", exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: "Skip tutorial", exact: true })).toBeVisible()
    await page.getByRole("button", { name: "Show issues", exact: true }).click()
    await expect(page.locator('.guide-transcript [data-kind="issue-list"]')).toBeVisible()
    expect(bootstrapReads).toBe(1)
    expect(identityReads).toBe(1)
  } finally {
    release()
  }
})

for (const repo of ["nope/nope", "smithersai/smithres"]) {
  test(`a signed-out repository deep link names ${repo} and keeps a keyboard sign-in path`, async ({ page }) => {
    await page.route("**/api/bootstrap", route => route.fulfill({ json: {
      apiVersion: 1, host: "cloud", version: "test", buildSha: "test",
      capabilities: ["identity"], authFlow: "redirect", sandbox: null,
    } }))
    await page.route("**/api/auth/session", route => route.fulfill({ json: { status: "signed-out" } }))
    await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [{ name: "smithersai/smithers" }] } }))
    await page.route("**/api/auth/github/start*", route => route.fulfill({ contentType: "text/html", body: "<p>GitHub sign-in route reached</p>" }))
    await page.goto(`/${repo}/`)
    const welcome = page.locator(".smithers-chat-message").filter({ hasText: `${repo} isn't on Smithers yet.` })
    await expect(welcome).toContainText("Sign in with GitHub to open your own repositories, or pick one below.")
    const link = welcome.getByRole("link", { name: "smithersai/smithers", exact: true })
    await expect(link).toHaveAttribute("href", "/smithersai/smithers/")
    await link.focus()
    await expect(link).toBeFocused()
    await page.reload()
    await expect(welcome).toBeVisible()
    const signIn = welcome.getByRole("button", { name: "Sign in with GitHub", exact: true })
    await signIn.focus()
    await page.keyboard.press("Enter")
    await expect(page).toHaveURL(url => url.pathname === "/api/auth/github/start" && url.searchParams.get("return_to") === `/${repo}/`)
  })
}
