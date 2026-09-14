import { expect, test, type Page } from "@playwright/test"
import { SCOPED_TEST_USER, SCOPED_TEST_USER_CLOUD_SESSION } from "./identity"

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) })
const slash = async (page: Page, command: string) => {
  if (await page.locator(".guide-shell").getAttribute("data-conversation-open") !== "true") await page.keyboard.press("Control+k")
  await page.getByTestId("composer-input").fill(command)
  await page.keyboard.press("Enter")
}
async function setup(page: Page, local = false, refused = false) {
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
  return hostedReads
}
for (const door of ["issues", "prs"]) {
  const step = 1
  test(`/${door} reads selected repository on an empty response`, async ({ page }) => {
    await setup(page)
    await slash(page, `/${door}`)
    await expect(page.locator(".guide-transcript").getByTestId(`card-${door}-will/repo`)).toBeVisible()
    await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", String(door === "issues" ? step + 1 : step))
  })
  test(`/${door} auth refusal does not check`, async ({ page }) => {
    await setup(page, false, true)
    await slash(page, `/${door}`)
    await expect(page.locator(".guide-transcript").getByRole("button", { name: "Sign in with GitHub", exact: true })).toBeVisible()
    await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", String(step))
  })
  test(`/${door} local-only repository stays local`, async ({ page }) => {
    const calls = await setup(page, true)
    await slash(page, `/${door}`)
    await expect(page.locator(".guide-transcript").getByTestId(`card-${door}-/tmp/play`)).toContainText("local-only repository")
    await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", String(door === "issues" ? step + 1 : step))
    expect(calls).toEqual([])
  })
}

import { signedOutVisitor } from "./identity"

test("practice Add flow opens its form and keeps a refused submit in the card", async ({ page }) => {
  await signedOutVisitor(page)
  await page.goto("/")
  await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "1")
  await page.keyboard.press("i")
  await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "2")
  await page.keyboard.press("r")
  const chip = page.locator(".guide-transcript").getByRole("button", { name: "Add flow", exact: true })
  await chip.focus()
  await page.keyboard.press("Enter")
  const form = page.locator(".guide-transcript").getByTestId("card-form-issue.add-flow")
  await expect(form).toBeVisible()
  await form.getByLabel("What should this issue flow do?").fill("Research error responses")
  await page.keyboard.press("Tab")
  await form.getByRole("button", { name: "Submit", exact: true }).click()
  await expect(form).toContainText("Practice repositories can't take new flows yet.")
  await expect(page.locator('[data-testid^="toast-"][data-status="failed"]')).toHaveCount(0)
})

test("practice Linear link renders the sign-in prompt; bridge retains the chrome door", async ({ page }) => {
  await signedOutVisitor(page)
  await page.goto("/")
  await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "1")
  await page.keyboard.press("i")
  await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "2")
  await page.keyboard.press("r")
  await page.locator(".guide-transcript").getByRole("button", { name: "Link to Linear…", exact: true }).click()
  await expect(page.locator(".guide-transcript").getByRole("button", { name: "Sign in with GitHub", exact: true })).toBeVisible()
  await page.keyboard.press("q")
  await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "10")
  await expect(page.getByTestId("chrome-sign-in")).toBeVisible()
})
