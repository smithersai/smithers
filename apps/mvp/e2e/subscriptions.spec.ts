import { expect, type Locator, type Page } from "@playwright/test"
import { chooseIssue } from "./todoDraft"
import { CLAUDE_TOKEN_PREFIX } from "../src/features/personal-model/contract"
import { connectionRows, openAdd, restorePersonalModel } from "./personal-model"
import { test } from "./devices"
import { step } from "./fixtures"
import { requires, stackRepository } from "./target"
import { expectServerError } from "./watch"

// Subscriptions, end to end against a deployment (decision 0132, ruling AUTH-10, docs/features/personal-model.md#subscriptions):
// the test account adds a Claude or Codex subscription in Settings exactly as a person does, Checks Access where the
// kind has a check, commits a TODO on its scratch stack, and the vendor's own CLI (`todo/ImplementCli`, not the Smithers
// agent's `todo/Implement`) writes the change in the branch's box, which the App pushes and opens a pull request for.
// The subscription goes again at the end, so no later run is routed to a vendor's CLI.
//
// Claude: E2E_CLAUDE_SUBSCRIPTION_TOKEN is what `claude setup-token` printed for a plan with headroom.
// Codex: OpenAI's device code needs a person signed in to ChatGPT, so a person links it once in Settings (Add, Codex
// subscription, Link, type the code at OpenAI) and runs this with E2E_CODEX_SUBSCRIPTION=linked; the spec never unlinks it.
requires("member", "writableStack", "ownConversation")
// A trace keeps what was typed, the token included.
test.use({ trace: "off" })
test.afterEach(async ({ request }) => {
  await restorePersonalModel(request)
})

/** A save lands once `model/Put` ran and Electric brought the row back. */
const SAVED_WITHIN = 30_000

const yourModel = async (page: Page, from: string) => {
  const section = page.getByRole("region", { name: "Your model" })
  await page.goto(new URL("/app/settings", from).href)
  await expect(section).toBeVisible({ timeout: 30_000 })
  return section
}

/** Removes every row of `kind`'s label, as a person does. */
const removeKind = async (section: Locator, label: string) => {
  const rows = connectionRows(section).filter({ hasText: label })
  while ((await rows.count()) > 0) {
    const left = await rows.count()
    await rows.first().getByRole("button", { name: "Remove" }).click()
    await expect(rows).toHaveCount(left - 1, { timeout: SAVED_WITHIN })
  }
}

/**
 * Commits a TODO asking for one line in NOTES.md, waits for In review, and returns its pull request's files after
 * checking the run's agent step was the vendor's CLI.
 */
const runTodo = async (page: Page, word: string, agentLabel: string) => {
  const repository = stackRepository()
  const title = `${agentLabel} subscription ${word}`
  const line = `${agentLabel.toLowerCase().replace(/\s+/g, "-")} ${word}`
  const stack = page.getByRole("region", { name: `${repository} stack` })
  const row = stack.locator("[data-slot=issues-row]", { hasText: title })
  await step("Commit a TODO on the scratch stack", async () => {
    await page.goto(`/${repository}/stack`)
    await expect(stack).toBeVisible({ timeout: 60_000 })
    await page.getByRole("button", { name: "New TODO" }).click()
    const draft = page.getByRole("form", { name: "TODO draft" }).first()
    await draft.getByLabel("Title").fill(title)
    await draft.getByLabel("Prompt").fill(
      `Append exactly one line to the end of NOTES.md, creating the file if it is missing: ${line}\nChange no other file.`,
    )
    await chooseIssue(draft)
    await draft.getByRole("button", { name: "Commit" }).click()
    await expect(row).toContainText(/T\d+/, { timeout: 60_000 })
  })
  const number = (await row.textContent())!.match(/T(\d+)/)![1]!
  const todo = page.getByRole("article", { name: new RegExp(title) })
  await step("The run's agent step is the vendor's CLI", async () => {
    await expect(row).toHaveAttribute("data-status", /running|in_review/, { timeout: 5 * 60_000 })
    await row.getByRole("link", { name: title }).click()
    // A TODO's row says Working a moment before its run on Cloudflare can be read: Watch's first read may be 404
    // (`not_started`), and the run page reads again.
    expectServerError(404, "/api/remote-runs/*")
    await todo.getByRole("link", { name: "Watch", exact: true }).click()
    // The run graph names each step `<flow>, <state>`; the Smithers agent's `todo/Implement` stays Queued.
    const steps = page.getByRole("tabpanel", { name: /^Steps/ })
    await expect(
      steps.getByRole("button", { name: /^todo\/ImplementCli, (Working|Done)$/ }),
      "todo/ImplementCli, the vendor's CLI in the box",
    ).toBeVisible({ timeout: 5 * 60_000 })
    await expect(steps.getByRole("button", { name: "todo/Implement, Queued", exact: true })).toBeVisible()
  })
  return await step("In review: the pull request has the CLI's line", async () => {
    await page.goto(`/${repository}/stack/${number}`)
    await expect(todo).toHaveAttribute("data-status", "in_review", { timeout: 40 * 60_000 })
    const link = page.getByRole("link", { name: /^#\d+$/ })
    await expect(link).toBeVisible({ timeout: 60_000 })
    const pr = Number((await link.textContent())!.slice(1))
    const files = await (await page.request.get(`https://api.github.com/repos/${repository}/pulls/${pr}/files`)).json() as Array<
      { filename: string; patch?: string }
    >
    expect(files.map((file) => file.filename)).toEqual(["NOTES.md"])
    expect(files[0]!.patch).toContain(`+${line}`)
    return { number, pr }
  })
}

test("subscriptions: a Claude subscription's TODO is written by Claude Code and opens a pull request", {
  annotation: {
    type: "summary",
    description: "Add a claude setup-token in Settings; a committed TODO runs todo/ImplementCli and its pull request has the line.",
  },
}, async ({ devices }) => {
  requires("claudeSubscription")
  test.setTimeout(50 * 60_000)
  const [a] = await devices.open("A")
  const page = a.page
  const from = page.url()
  const section = await yourModel(page, from)
  await removeKind(section, "Claude subscription")
  try {
    await step("Add the Claude subscription: paste the setup-token, Save", async () => {
      const dialog = await openAdd(section, page, "claude_subscription")
      await expect(dialog).toContainText("claude setup-token")
      const token = process.env.E2E_CLAUDE_SUBSCRIPTION_TOKEN!
      expect(token.startsWith(CLAUDE_TOKEN_PREFIX), "a setup-token").toBe(true)
      await dialog.getByLabel("Token", { exact: true }).fill(token)
      await dialog.getByRole("button", { name: "Save" }).click()
      await expect(dialog).toHaveCount(0, { timeout: SAVED_WITHIN })
      const row = connectionRows(section).filter({ hasText: "Claude subscription" })
      await expect(row).toHaveCount(1, { timeout: SAVED_WITHIN })
      // Only Claude Code may use the token (decision 0132): its row has no Test, and its first run is the check.
      await expect(row.getByRole("button", { name: "Test" })).toHaveCount(0)
    })
    await runTodo(page, devices.word, "Claude Code")
  } finally {
    await removeKind(await yourModel(page, from), "Claude subscription")
  }
})

test("subscriptions: a linked Codex subscription passes Check Access and its TODO is written by Codex", {
  annotation: {
    type: "summary",
    description: "With Codex linked in Settings, Test refreshes its token; a committed TODO runs todo/ImplementCli and its pull request has the line.",
  },
}, async ({ devices }) => {
  requires("codexSubscription")
  test.setTimeout(50 * 60_000)
  const [a] = await devices.open("A")
  const page = a.page
  const from = page.url()
  const section = await yourModel(page, from)
  // A Claude subscription above it would write the TODO instead.
  await removeKind(section, "Claude subscription")
  await step("Check Access on the linked Codex subscription", async () => {
    const row = connectionRows(section).filter({ hasText: "Codex subscription" })
    await expect(row).toHaveCount(1, { timeout: SAVED_WITHIN })
    await row.getByRole("button", { name: "Test" }).click()
    await expect(row).toContainText(/OK/, { timeout: 60_000 })
  })
  await runTodo(page, devices.word, "Codex")
})
