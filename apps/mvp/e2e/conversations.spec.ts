import type { Page } from "@playwright/test"
import { NEW_BRANCH_PREFIX } from "../src/features/conversations/contract"
import { expect, test } from "./devices"
import { step } from "./fixtures"
import { requires } from "./target"

// Your conversations (decision 0013 decision 2, docs/features/conversations.md), end to end against the real app,
// Worker, Postgres and Electric, on two devices of one person side by side: each branch is one conversation; the
// branches you open are your list, on every device; Archive hides one from your own list on all your devices, and
// opening its branch brings it back; `/new` starts a fresh conversation on a new branch. The fixture is the public
// `octocat/Spoon-Knife`, whose `test-branch` and `change-the-title` GitHub already has; nothing is written to GitHub.
// Opening a branch tracks it, which only a Member or above may (worker/branch/Branches.ts).

requires("member")

const REPO = "/octocat/Spoon-Knife"

const listOf = (page: Page) => page.getByRole("list", { name: "Conversations" })
const rowOf = (page: Page, branch: string) =>
  listOf(page).getByRole("listitem").filter({ has: page.getByRole("link", { name: new RegExp(`^${branch} `) }) })

/** Opens a branch's page and waits for its workspace: the branch's name in its chrome. */
const openBranch = (page: Page, branch: string) =>
  step(`Open branch ${branch}`, async () => {
    await page.goto(`${REPO}/tree/${branch}`)
    await expect(page.getByRole("navigation", { name: "Branch" })).toContainText(branch, { timeout: 30_000 })
  })

/** Opens the list from home's header, on the Open or the Archived side. */
const openList = (page: Page, side: "Open" | "Archived" = "Open") =>
  step(side === "Open" ? "Open Conversations" : "Open the archived conversations", async () => {
    if (!page.url().endsWith("/app/conversations")) {
      await page.goto("/app")
      await page.getByRole("navigation", { name: "Pages" }).getByRole("link", { name: "Conversations" }).click()
      await expect(page).toHaveURL(/\/app\/conversations$/)
    }
    await page.getByRole("radio", { name: side }).click()
  })

/** Searches the list for `text`. */
const search = (page: Page, text: string) =>
  step(`Search "${text}"`, () => page.getByRole("searchbox", { name: "Search" }).fill(text))

test("history: the branches you open are your conversations, on every device, searchable", {
  annotation: { type: "summary", description: "Each branch you open is one conversation in your list, on every device you use, found by repository or branch." },
}, async ({ devices }) => {
  test.setTimeout(3 * 60_000)
  const [laptop, phone] = await devices.open("Laptop", "Phone")
  const [a, b] = [laptop!.page, phone!.page]

  await openBranch(a, "test-branch")
  await openBranch(a, "change-the-title")
  await openList(a)
  await expect(rowOf(a, "change-the-title")).toBeVisible({ timeout: 30_000 })
  await expect(rowOf(a, "test-branch")).toBeVisible()

  await step("The phone lists them too", async () => {
    await openList(b)
    await expect(rowOf(b, "change-the-title")).toBeVisible({ timeout: 30_000 })
    await expect(rowOf(b, "test-branch")).toBeVisible()
  })

  await search(b, "spoon title")
  await expect(rowOf(b, "change-the-title")).toBeVisible()
  await expect(rowOf(b, "test-branch")).toHaveCount(0)
  await search(b, "")
  await expect(rowOf(b, "test-branch")).toBeVisible()

  await step("A row opens its branch", async () => {
    await rowOf(b, "test-branch").getByRole("link").click()
    await expect(b).toHaveURL(new RegExp(`${REPO}/tree/test-branch$`, "i"))
    await expect(b.getByRole("navigation", { name: "Branch" })).toContainText("test-branch", { timeout: 30_000 })
  })
})

test("archive: Archive hides a conversation on all your devices; opening its branch brings it back", {
  annotation: { type: "summary", description: "Archive is yours alone and follows you to every device; opening the branch, anywhere, brings the conversation back." },
}, async ({ devices }) => {
  test.setTimeout(3 * 60_000)
  const [laptop, phone] = await devices.open("Laptop", "Phone")
  const [a, b] = [laptop!.page, phone!.page]

  // Opening it puts it in the list, unarchived, whatever an earlier run left.
  await openBranch(a, "test-branch")
  await openList(a)
  await openList(b)
  await expect(rowOf(b, "test-branch")).toBeVisible({ timeout: 30_000 })

  await step("Archive it on the laptop", async () => {
    await rowOf(a, "test-branch").getByRole("button", { name: "Archive test-branch" }).click()
    await expect(rowOf(a, "test-branch")).toHaveCount(0)
  })
  await step("It leaves the phone's list too", () => expect(rowOf(b, "test-branch")).toHaveCount(0, { timeout: 30_000 }))
  await step("Reloaded, the laptop still has it archived", async () => {
    await a.reload()
    await expect(listOf(a).or(a.getByText("No conversations"))).toBeVisible({ timeout: 30_000 })
    await expect(rowOf(a, "test-branch")).toHaveCount(0)
  })

  await openList(b, "Archived")
  await expect(rowOf(b, "test-branch")).toBeVisible({ timeout: 30_000 })
  await expect(rowOf(b, "test-branch").getByRole("button", { name: "Restore test-branch" })).toBeVisible()

  await step("Opening the branch on the phone brings it back", async () => {
    await rowOf(b, "test-branch").getByRole("link").click()
    await expect(b.getByRole("navigation", { name: "Branch" })).toContainText("test-branch", { timeout: 30_000 })
  })
  await step("The laptop lists it again", () => expect(rowOf(a, "test-branch")).toBeVisible({ timeout: 30_000 }))

  await step("Archive, then Restore from the archived list", async () => {
    await rowOf(a, "test-branch").getByRole("button", { name: "Archive test-branch" }).click()
    await openList(a, "Archived")
    await rowOf(a, "test-branch").getByRole("button", { name: "Restore test-branch" }).click()
    await expect(rowOf(a, "test-branch")).toHaveCount(0)
    await openList(a)
    await expect(rowOf(a, "test-branch")).toBeVisible()
  })
})

test.describe("a new conversation", () => {
  // A new branch is made on Code Storage's mirror, which the local dev server reaches only when configured.
  requires("codeStorage")

  test("new: /new starts a fresh conversation on a new branch, opens it, and lists it on your other device", {
    annotation: { type: "summary", description: "A fresh conversation is a new branch: /new makes one, opens its page, and it joins your list everywhere." },
  }, async ({ devices }) => {
    test.setTimeout(4 * 60_000)
    const [laptop, phone] = await devices.open("Laptop", "Phone")
    const [a, b] = [laptop!.page, phone!.page]

    const branch = await step("Type /new in the composer", async () => {
      const composer = a.getByRole("textbox", { name: "Message Smithers" })
      if (!(await composer.isVisible())) await a.getByRole("button", { name: /Chat/ }).click()
      await composer.fill("/new roninjin10/smithers-github-tests")
      await composer.press("Enter")
      await expect(a).toHaveURL(new RegExp(`/tree/${NEW_BRANCH_PREFIX}[0-9a-f]{6}$`), { timeout: 120_000 })
      return new URL(a.url()).pathname.split("/").at(-1)!
    })
    await expect(a.getByRole("navigation", { name: "Branch" })).toContainText(branch, { timeout: 60_000 })
    await openList(b)
    await expect(rowOf(b, branch)).toBeVisible({ timeout: 30_000 })
  })
})
