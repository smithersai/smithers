import { expect,test } from "@playwright/test"

/*
 * The boot-blocking regression (the local app stuck on "Smithers is starting
 * your session." while /api/auth/session pended on the remote identity seam):
 * first paint — the entrance wordmark, then the guide shell — must never wait
 * on that seam.
 * The T1 host stubs identity out entirely, so this spec boots its own origin
 * (identity-hang-host.ts) with the seam behind a socket that never answers.
 */


import { SCOPED_TEST_USER,signedOutVisitor } from "./identity"

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

/*
 * CT089: a bare repository command typed before first run has chosen its
 * target parks and resumes into the practice list. Both identity reads are on
 * the critical path (state/controller/auth-billing.ts dispatchSignedOut), so
 * both are held here; releasing only the session read leaves a second hop.
 */
test("a bare issues.list during first-run identity resumes into the practice list", async ({ page }) => {
  await signedOutVisitor(page)
  let releaseSession!: () => void, releaseScopes!: () => void
  const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) })
  const held = [
    new Promise<void>(resolve => { releaseSession = resolve }),
    new Promise<void>(resolve => { releaseScopes = resolve })
  ]
  await page.route("**/api/auth/session", async route => { await held[0]; await route.fulfill(json({ status: "signed-out" })) })
  await page.route("**/api/auth/scopes", async route => { await held[1]; await route.fulfill(json({ scopes: [] })) })
  const errors: string[] = []
  const issueReads: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("request", request => { if (/\/api\/.*issues/.test(request.url())) issueReads.push(request.url()) })

  await page.goto("/")
  await page.getByRole("link", { name: "Start Here" }).click()
  await expect(page.getByRole("button", { name: "Chat" })).toBeVisible()
  await page.keyboard.press("Meta+k")
  await page.getByTestId("composer-input").fill("/issues.list")
  await page.getByTestId("composer-input").press("Enter")
  // Chat answers now: the command parks, it does not ask for a repository.
  await expect(page.getByTestId("composer-input")).toBeHidden({ timeout: 300 })
  await expect(page.locator('[data-kind="flow-form"]')).toHaveCount(0)

  releaseSession()
  releaseScopes()
  await expect(page.locator("#card-practice-issues")).toContainText("smithersai/hello-server")
  await expect(page.locator('[data-kind="issue-list"]')).toHaveCount(1)
  await expect(page.getByRole("textbox", { name: "Repo" })).toHaveCount(0)
  expect(errors).toEqual([])
  expect(issueReads).toEqual([])
})

test("CONTROL: a persisted private selection resolves against that repo, never practice", async ({ page }) => {
  await signedOutVisitor(page)
  const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) })
  let releaseSession!: () => void, releaseScopes!: () => void
  const held = [
    new Promise<void>(resolve => { releaseSession = resolve }),
    new Promise<void>(resolve => { releaseScopes = resolve })
  ]
  await page.route("**/api/auth/session", async route => { await held[0]; await route.fulfill(json({ status: "signed-in", ...SCOPED_TEST_USER })) })
  await page.route("**/api/auth/scopes", async route => { await held[1]; await route.fulfill(json({ scopes: [] })) })
  await page.route("**/api/user/repos", route => route.fulfill(json({ repos: [{ id: "scoped/private", org: "scoped", name: "private", ownerKind: "user", head: null }] })))
  await page.route(/\/api\/repos\/scoped\/private\/issues/, route => route.fulfill(json([{ number: 7, title: "Private only", state: "open", author: { login: SCOPED_TEST_USER.login }, comment_count: 0, updated_at: null }])))

  await page.goto("/scoped/private/")
  await page.keyboard.press("Meta+k")
  await page.getByTestId("composer-input").fill("/issues.list")
  await page.getByTestId("composer-input").press("Enter")
  releaseSession()
  releaseScopes()
  // A repository path entry is a target: firstRunTargetPending is false, so nothing parks.
  await expect(page.getByText("Continuing:")).toHaveCount(0)
  await expect(page.locator('[data-kind="flow-form"]')).toHaveCount(0)
  await expect(page.locator("#card-practice-issues")).toHaveCount(0)
  await expect(page.locator('[data-kind="issue-list"]')).toContainText("scoped/private")
})
