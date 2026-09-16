import { expect,test } from "@playwright/test"

/*
 * The boot-blocking regression (the local app stuck on "Smithers is starting
 * your session." while /api/auth/session pended on the remote identity seam):
 * first paint — the entrance wordmark, then the guide shell — must never wait
 * on that seam.
 * The T1 host stubs identity out entirely, so this spec boots its own origin
 * (identity-hang-host.ts) with the seam behind a socket that never answers.
 */


import { signedOutVisitor } from "./identity"

const slash = async (page: import("@playwright/test").Page, command: string) => {
  if (!await page.getByTestId("composer-input").isVisible()) await page.keyboard.press("Control+k")
  await page.getByTestId("composer-input").fill(command)
  await page.getByTestId("composer-input").press("Enter")
}

test("repository chrome sign-in is keyboard reachable without the sidebar and carries return_to", async ({ page }) => {
  await signedOutVisitor(page)
  await page.goto("/smithersai/smithers/")
  const door = page.getByTestId("chrome-sign-in")
  await expect(door).toBeVisible()
  await expect(page.locator(".session-sidebar")).toHaveCount(0)
  // Reach it from the wordmark in the native tab order, then activate with Enter.
  await page.getByRole("button", { name: "Smithers", exact: true }).focus()
  await page.keyboard.press("Tab")
  await expect(door).toBeFocused()
  const bounds = await door.boundingBox()
  expect(bounds!.x).toBeGreaterThan(page.viewportSize()!.width / 2)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(44)
  await page.route("**/api/auth/github**", route => route.fulfill({ body: "Sign-in handoff" }))
  const request = page.waitForRequest(request => new URL(request.url()).pathname === "/api/auth/github/start")
  await page.keyboard.press("Enter")
  expect(new URL((await request).url()).searchParams.get("return_to")).toBe("/smithersai/smithers/")
})

for (const command of ["/flow.run review smithersai/smithers", "/secrets.list", "/account.show", "/issues smithersai/smithers", "/prs smithersai/smithers"]) {
  test(`${command} stays in the repository transcript with a sign-in prompt`, async ({ page }) => {
    await signedOutVisitor(page)
    // Repository arguments are resolved against the loaded public catalog.
    await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [
      { name: "smithersai/smithers", title: "Smithers", url: "https://github.com/smithersai/smithers", summary: "Smithers.", stats: null },
    ] } }))
    const redirects: string[] = []
    page.on("request", request => { if (request.url().includes("/api/auth/github/start")) redirects.push(request.url()) })
    await page.goto("/smithersai/smithers/")
    await expect(page.getByTestId("chrome-sign-in")).toBeVisible()
    await expect(page.locator('[data-kind="repo-onboarding"]')).toBeVisible()
    await slash(page, command)
    const prompt = page.getByRole("article").filter({ has: page.getByRole("button", { name: "Sign in with GitHub", exact: true }) }).last()
    await expect(prompt).toContainText(command === "/flow.run review smithersai/smithers" ? "Sign in with GitHub to run review on smithersai/smithers."
      : command === "/secrets.list" ? "Sign in with GitHub to show the secrets"
      : command === "/account.show" ? "Sign in with GitHub to show the signed-in account"
      : command.startsWith("/issues") ? "Sign in with GitHub to read issues on smithersai/smithers."
      : "Sign in with GitHub to read pull requests on smithersai/smithers.")
    await expect(prompt.getByRole("button", { name: "Sign in with GitHub", exact: true })).toBeVisible()
    await expect(page.getByText(/0 Open|No open issues in/)).toHaveCount(0)
    await expect(page.locator("[data-toast-status]")).toHaveCount(0)
    expect(new URL(page.url()).pathname).toMatch(/^\/smithersai\/smithers\/?$/)
    expect(redirects).toEqual([])
    if (command === "/secrets.list") {
      await page.route("**/api/auth/github/start**", route => route.fulfill({ body: "Sign-in handoff" }))
      const request = page.waitForRequest(request => new URL(request.url()).pathname === "/api/auth/github/start")
      await prompt.getByRole("button", { name: "Sign in with GitHub", exact: true }).click()
      expect(new URL((await request).url()).searchParams.get("return_to")).toBe("/smithersai/smithers/")
    }
  })
}

test("unknown repository has one sign-in card and the web wiki has no seeded World page", async ({ page }) => {
  await signedOutVisitor(page)
  await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [] } }))
  await page.goto("/nope/nope/")
  await expect(page.getByRole("article").filter({ has: page.locator('[data-flow="auth.sign-in"]') })).toContainText("nope/nope")
  await expect(page.getByRole("article").filter({ has: page.locator('[data-flow="auth.sign-in"]') })).toHaveCount(1)
  await slash(page, "/wiki")
  await expect(page.locator(".world-card-empty")).toContainText("No Wiki yet")
  await expect(page.locator('.world-card-empty [data-flow="wiki.create"]')).toHaveText("Create Wiki")
  await expect(page.locator(".world-document-title")).toHaveCount(0)
})

test("chrome sign-in uses the shell's green action token", async ({ page }) => {
  await signedOutVisitor(page)
  await page.goto("/smithersai/smithers/")
  const door = page.getByTestId("chrome-sign-in")
  await expect(door).toBeVisible()
  expect(await door.evaluate(node => {
    const probe = document.createElement("span")
    probe.style.color = "var(--g-accent)"
    node.append(probe)
    const same = getComputedStyle(node).color === getComputedStyle(probe).color
    probe.remove()
    return same
  })).toBe(true)
})
