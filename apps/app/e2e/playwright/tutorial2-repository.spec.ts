import { expect, test, type Page } from "@playwright/test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
const slash = async (page: Page, command: string) => {
  if (await page.locator(".guide-shell").getAttribute("data-conversation-open") !== "true") await page.keyboard.press("Control+k")
  await page.getByTestId("composer-input").fill(command)
  await page.keyboard.press("Enter")
}
/** The identity capability the login lane's producer reads before it can validate a session. */
const identityHost = (page: Page) => page.route("**/api/bootstrap", route => route.fulfill({ json: {
  apiVersion: 1, host: "local", version: "test", buildSha: "test",
  capabilities: ["identity", "local.repositories", "local.targets", "local.terminal", "local.harnesses"],
  authFlow: "both", sandbox: null
} }))
const enterRepositoryLesson = async (page: Page, signedIn = false) => {
  await page.goto("/")
  if (signedIn) { await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "2"); return }
  // Stage 0 is the greeting: leave it before the login signal can be the current lesson.
  await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "1")
  // Only the preceding login lane is stubbed; repository.ready is never injected.
  await slash(page, "/onboarding.act signal identity.signed-in")
  await page.keyboard.press("Escape")
  await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "2")
}
test("rank authored commits, keyboard choose and retain selected repository across reload", async ({ page }) => {
  await identityHost(page)
  await page.route("**/api/auth/session", route => route.fulfill({ json: { status: "signed-in", login: "will", allowlisted: true, admin: false } }))
  await page.route("**/api/user/github-repos?*", route => route.fulfill({ json: [{ full_name: "org/pushed", pushed_at: new Date().toISOString() }, { full_name: "org/authored", pushed_at: "2020-01-01" }] }))
  await page.route("**/api/user/github-repos/*/*/commits?*", route => {
    const shas = route.request().url().includes("/authored/") ? ["a", "b", "b"] : ["c"]
    return route.fulfill({ json: shas.map(sha => ({ sha, author: { login: "will" }, commit: { author: { date: new Date().toISOString() } } })) })
  })
  await enterRepositoryLesson(page, true)
  await slash(page, "/repo.choose")
  const card = page.locator("[data-tutorial-cards]").getByTestId("repository-choice")
  await expect(card.locator("ol button").first()).toHaveText("org/authored")
  await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "2")
  await card.getByRole("button", { name: "org/authored", exact: true }).focus()
  await page.keyboard.press("Enter")
  await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "3")
  await page.reload()
  await expect(card.getByRole("button", { name: "org/authored", exact: true })).toHaveAttribute("aria-pressed", "true")
  await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "3")
})
test("Skip creates a real local Git repository, reports path and completes after durable adoption", async ({ page }) => {
  await enterRepositoryLesson(page)
  await slash(page, "/repo.choose")
  const card = page.locator("[data-tutorial-cards]").getByTestId("repository-choice")
  await card.getByRole("button", { name: "Skip", exact: true }).focus()
  const created = page.waitForResponse(response => response.url().endsWith("/api/repo/create") && response.request().method() === "POST")
  await page.keyboard.press("Enter")
  const response = await created
  expect(response.ok()).toBe(true)
  const { repository } = await response.json()
  expect(repository.root.startsWith("/")).toBe(true)
  expect(repository.remoteUrl).toBeNull()
  expect(await readFile(join(repository.root, ".git/HEAD"), "utf8")).toBe("ref: refs/heads/main\n")
  expect(await readFile(join(repository.root, ".git/config"), "utf8")).not.toContain("remote")
  await expect(card).toContainText(`Created ${repository.name} at ${repository.root}`)
  await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "3")
  await page.reload()
  await expect(card).toContainText(repository.root)
  await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "3")
})
