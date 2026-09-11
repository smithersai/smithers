import { expect, test, type Page } from "@playwright/test"
import { SCOPED_TEST_USER, SCOPED_TEST_USER_CLOUD_SESSION } from "./identity"

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) })
const slash = async (page: Page, command: string) => {
  if (await page.locator(".guide-shell").getAttribute("data-conversation-open") !== "true") await page.keyboard.press("Control+k")
  await page.getByTestId("composer-input").fill(command)
  await page.keyboard.press("Enter")
}
async function setup(page: Page, door: string, local = false, refused = false) {
  const hostedReads: string[] = []
  await page.route("**/api/**", route => route.fulfill(json({ message: "Unavailable test route" }, 404)))
  await page.route("**/api/bootstrap", route => route.fulfill(json({ apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["identity", "cloud", "cloud.pat", "local.repositories"], authFlow: "none", sandbox: { platform: "darwin", mode: "trusted-only" } })))
  await page.route("**/api/auth/session", route => route.fulfill(json(SCOPED_TEST_USER)))
  await page.route("**/api/cloud-auth/session", route => route.fulfill(json(SCOPED_TEST_USER_CLOUD_SESSION)))
  await page.route("**/api/repos", route => route.fulfill(json({ repos: local ? [{ id: "play", name: "play", path: "/tmp/play", git: { branch: "main", remote: null }, warnings: [], smithers: { detected: false, workspaceFile: "", declarationFiles: [], reason: "none", workspaces: [] } }] : [] })))
  await page.route("**/api/user/repos", route => route.fulfill(json({ repos: local ? [] : [{ owner: "will", name: "repo", full_name: "will/repo", default_bookmark: "main" }] })))
  await page.route("**/bookmarks", route => route.fulfill(json({ bookmarks: [] })))
  await page.route("**/api/user/workspaces", route => route.fulfill(json({ workspaces: [] })))
  await page.route("**/api/user/orgs", route => route.fulfill(json({ orgs: [] })))
  await page.route(/\/api\/.*(?:issues|landings)(?:\?|$)/, route => {
    hostedReads.push(route.request().url())
    return route.fulfill(refused ? json({ message: "Sign in to read this repository" }, 401) : json([]))
  })
  await page.goto("/")
  await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "1")
  await slash(page, `/repo.select ${local ? "local:/tmp/play" : "will/repo"}`)
  // Script v4: issues are beat 1, pull requests beat 3. Earlier beats are fixtures; the door's own lesson MUST use its real producer.
  if (door === "prs") {
    for (const [signal, next] of [["issues.opened", "2"], ["issue.opened", "3"]] as const) {
      await slash(page, `/onboarding.act signal ${signal}`)
      await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", next)
    }
  }
  return hostedReads
}
for (const door of ["issues", "prs"]) {
  const step = door === "issues" ? 1 : 3
  test(`/${door} reads selected repository and completes on an empty response`, async ({ page }) => {
    await setup(page, door)
    await slash(page, `/${door}`)
    await expect(page.locator(".guide-transcript").getByTestId(`card-${door}-will/repo`)).toBeVisible()
    await expect(page.locator(`[data-message-step="${step}"] .guide-step-done`)).toBeVisible()
    await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", String(step + 1))
  })
  test(`/${door} auth refusal does not check`, async ({ page }) => {
    await setup(page, door, false, true)
    await slash(page, `/${door}`)
    await expect(page.getByText("Sign in to read this repository", { exact: false }).first()).toBeVisible()
    await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", String(step))
    await expect(page.locator(`[data-message-step="${step}"] .guide-step-done`)).toHaveCount(0)
  })
  test(`/${door} local-only repository stays local`, async ({ page }) => {
    const calls = await setup(page, door, true)
    await slash(page, `/${door}`)
    await expect(page.locator(".guide-transcript").getByTestId(`card-${door}-/tmp/play`)).toContainText("local-only repository")
    await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", String(step + 1))
    expect(calls).toEqual([])
  })
}
