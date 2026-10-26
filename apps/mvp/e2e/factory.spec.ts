import { expect, type Page, type TestInfo } from "@playwright/test"
import { strictTest as test } from "./watch"
import { recordActions, step, themeOf, writeManifest } from "./fixtures"
import { requires, scriptedAgent } from "./target"

// The coding factory, end to end (decision 0016, the factory simplified; docs/features/todos.md#the-run): a person asks
// Smithers for a TODO and commits it; the `todo` run takes it to a mergeable pull request on GitHub. Everything is real
// but the chat agent that drafts the TODO, the scripted one in the browser's engine worker (`/app?agent=todo-draft`,
// src/test/scriptedAgent.ts), so the draft is the same every run. The run itself is the deployment's: the branch on
// GitHub, the agent writing the change on the branch's machine with the real model, the commit and the pull request.
// On the way it shows ruling TODO-3 (the Working TODO blinks and links to its run, watched live from Cloudflare) and
// ruling GH-9 (beside Merge into the default branch, the pull request says merging deploys it).
//
// It writes to GitHub, so it runs only against a live instance with the GitHub App and `TODO_RUNS` on, whose
// GITHUB_REPOSITORY is a scratch repository the test account administers with the App installed, named in
// E2E_FACTORY_REPOSITORY (`factoryRepository`, e2e/target.ts). The scripted agent needs a dev build: `alchemy dev` on
// this machine, signing in through GitHub, run as a deployment (`E2E_TARGET=deployment BASE_URL=<its URL>`), so the
// setup project signs the test account in (e2e/deployment/sign-in.setup.ts). It never runs against production, and
// never merges: a person merges, and the pull request stays open for one.

const started = new WeakMap<TestInfo, number>()
const repo = process.env.E2E_FACTORY_REPOSITORY ?? ""

test.beforeEach(async ({ page }, info) => {
  started.set(info, Date.now())
  // The setup signed the test account in and read its role; every context here starts from that session.
  requires("factoryRepository", "scriptedAgent", "member")
  await page.emulateMedia({ colorScheme: themeOf(info) })
  await recordActions(page, info, "Maya")
})

test.afterEach(async ({}, info) => {
  // Playwright saves the page's video beside the manifest as video.webm once the test ends; a relative path names it there.
  await writeManifest(info, "flow.json", started.get(info) ?? Date.now(), [{ name: "Maya", video: "video.webm", openedAt: 0 }])
})

/** The stack page's row of the TODO whose title has `word`. */
const row = (page: Page, word: string) =>
  page.getByRole("region", { name: `${repo} stack` }).locator("[data-slot=issues-row]", { hasText: word })

/** The page of the TODO titled `title`. */
const todoPage = (page: Page, title: string) => page.getByRole("article", { name: new RegExp(title) })

test("factory: a TODO runs to a mergeable pull request", {
  annotation: { type: "summary", description: "Commit a TODO; it blinks while Smithers works, you watch the agent, and its pull request is mergeable, with checks and a deploy warning." },
}, async ({ page }) => {
  test.setTimeout(30 * 60_000)
  const word = `f${Date.now().toString(36)}`
  const title = `Greet in the README ${word}`

  await step("Ask Smithers for a TODO", async () => {
    await page.goto(scriptedAgent("todo-draft"))
    await expect(page.getByRole("main", { name: "App" })).toBeVisible({ timeout: 60_000 })
    const composer = page.getByRole("textbox", { name: "Message Smithers" })
    if (await composer.isHidden()) await page.keyboard.press("ControlOrMeta+k")
    await expect(page.locator('form[data-slot="chat-composer"]')).toHaveAttribute("data-status", "ready", { timeout: 60_000 })
    await composer.fill(`todo-draft ${repo} ${word}`)
    await composer.press("Enter")
  })

  await step("Edit the draft and commit it", async () => {
    const draft = page.getByRole("form", { name: "TODO draft" })
    await expect(draft).toBeVisible({ timeout: 120_000 })
    await draft.getByLabel("Title").fill(title)
    await draft.getByRole("button", { name: "Commit" }).click()
    await expect(page).toHaveURL(new RegExp(`/${repo}/stack$`), { timeout: 30_000 })
    await expect(row(page, word)).toContainText(/T\d+/, { timeout: 60_000 })
  })

  const number = (await row(page, word).textContent())!.match(/T(\d+)/)![1]!

  await step("Smithers starts working on it: the TODO blinks", async () => {
    await expect(row(page, word)).toHaveAttribute("data-status", "running", { timeout: 120_000 })
    await expect(row(page, word).locator("[data-live]"), "a Working TODO's icon blinks (ruling TODO-3)").toBeVisible()
    // Each step is a chapter the recording holds long enough to read (e2e/frames.ts), so nothing here waits for the eye.
    await expect(row(page, word).getByRole("link", { name: title }), "the row links to its TODO").toBeVisible()
    await row(page, word).getByRole("link", { name: title }).click()
    await expect(page).toHaveURL(new RegExp(`/${repo}/stack/${number}$`))
    await expect(todoPage(page, title)).toHaveAttribute("data-status", /running|in_review/, { timeout: 60_000 })
    await expect(todoPage(page, title).getByRole("link", { name: "Watch", exact: true }), "a working TODO links to its run").toBeVisible()
  })

  await step("Watch the agent work on Cloudflare", async () => {
    await todoPage(page, title).getByRole("link", { name: "Watch", exact: true }).click()
    await expect(page).toHaveURL(/\/app\/runs\/todo%3A|\/app\/runs\/todo:/)
    await expect(page.getByText("Cloud", { exact: true }).first(), "the run page reads the run from Cloudflare").toBeVisible({ timeout: 60_000 })
    await expect(page.getByText(/todo\/Implement/).first(), "the agent's step shows").toBeVisible({ timeout: 5 * 60_000 })
    const implement = page.getByRole("listbox", { name: "Steps" }).getByRole("option").filter({ hasText: /todo\/Implement/ }).first()
    await expect(implement, "the agent is at work on the branch's machine, or done").toHaveAttribute("data-state", /^(running|completed)$/, {
      timeout: 5 * 60_000,
    })
  })

  await step("The agent writes the change and opens a pull request", async () => {
    await page.goBack()
    await expect(todoPage(page, title)).toHaveAttribute("data-status", "in_review", { timeout: 25 * 60_000 })
    await expect(todoPage(page, title).locator("[data-live]"), "In review waits on a person, so it doesn't blink").toHaveCount(0)
  })

  const pull = await step("The pull request is open and mergeable on GitHub", async () => {
    const link = page.getByRole("link", { name: /^#\d+$/ })
    await expect(link).toBeVisible({ timeout: 60_000 })
    const prNumber = Number((await link.textContent())!.slice(1))
    const response = await page.request.get(`https://api.github.com/repos/${repo}/pulls/${prNumber}`)
    expect(response.status()).toBe(200)
    const body = await response.json() as { state: string; merged: boolean; head: { ref: string }; base: { ref: string } }
    expect(body.state).toBe("open")
    expect(body.merged).toBe(false)
    expect(body.head.ref).toMatch(new RegExp(`^smithers/t${number}-`))
    return { prNumber, link, base: body.base.ref }
  })

  await step("Open the pull request: Merge warns that merging deploys", async () => {
    await pull.link.click()
    await expect(page).toHaveURL(new RegExp(`/${repo}/pull/${pull.prNumber}$`))
    await expect(page.getByRole("button", { name: "Squash and merge" })).toBeVisible({ timeout: 60_000 })
    await expect(page.getByRole("note"), "ruling GH-9").toHaveText(`Merging into ${pull.base} deploys it.`, { timeout: 60_000 })
    await expect(page.getByRole("link", { name: /^Checks/ }), "the pull request has a Checks tab").toBeVisible()
  })

  await step("Its checks are Smithers runs", async () => {
    await page.getByRole("link", { name: /^Checks/ }).click()
    // The review check runs the model on the pull request's diff; the tab counts it once it passed.
    await expect(page.getByRole("link", { name: /^Checks (\d+)\/\1$/ })).toBeVisible({ timeout: 10 * 60_000 })
    await expect(page.getByRole("link", { name: "Conversation" }), "one tab is current").not.toHaveAttribute("aria-current", "page")
    await expect(page.getByRole("link", { name: /^Files/ }), "the pull request has a Files tab").toBeVisible()
  })

  await step("Its files: the README line the agent wrote", async () => {
    await page.getByRole("link", { name: /^Files/ }).click()
    await expect(page.getByRole("region", { name: "Files" })).toContainText("README.md", { timeout: 60_000 })
    await expect(page.getByRole("region", { name: "Files" })).toContainText(word)
    await expect(page.getByRole("link", { name: /^Files/ }), "Files is the current tab").toHaveAttribute("aria-current", "page")
  })
  expect(pull.prNumber).toBeGreaterThan(0)
})
