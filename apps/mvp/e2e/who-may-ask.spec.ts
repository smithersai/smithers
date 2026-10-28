import { MEMBERS_ASK, OPEN_SETTINGS, SIGN_IN } from "../src/features/auth/contract"
import { DONE, OPEN, REPOSITORY_FIELD } from "../src/features/first-run/contract"
import { expect, test } from "./devices"
import { step, test as pageTest } from "./fixtures"
import { firstRun, firstRunStep } from "./firstRun"
import { fillYourModel } from "./personal-model"
import { requires, scriptedAgent } from "./target"
import { expectServerError } from "./watch"

// Who may ask Smithers (ruling AUTH-8, decision 0122): anyone signed in, with their own model, in a conversation on a
// repository where they are a Member or above, never by their role on the deployment's own. Locally, as brand-new
// people with no role on the dev server's repository (worker/DevChatApi.ts `owner-` and `reader-`): an `owner-` is the
// Admin of octocat/Spoon-Knife, as a person who installed the App on their own repository is, and a `reader-` its Guest.
// The scripted `hello` agent answers (src/test/scriptedAgent.ts); GitHub is the real one, read with no credential.

const REPOSITORY = "octocat/Spoon-Knife"

/** A step's ✓: its mark says Done to assistive technology. */
const done = (page: Parameters<typeof firstRunStep>[0], title: string) => firstRunStep(page, title).getByRole("img", { name: DONE })

test("who may ask: a new person who is Admin of their own repository signs in, adds their model, opens it, and gets an answer there", {
  annotation: {
    type: "summary",
    description: "A stranger to the deployment's repository is walked to their own repository and asks there, never stopped at Members can ask Smithers.",
  },
}, async ({ devices }) => {
  requires("devPeople", "devSignIn", "scriptedAgent")
  test.setTimeout(300_000)
  const word = devices.word
  const [a] = await devices.openVisitorAs(`owner-${word}`, "Owner")
  const page = a.page

  await step("Sign in from the first step: Add your model is next, never Members can ask Smithers.", async () => {
    await page.goto(scriptedAgent("hello"))
    await a.ready()
    await firstRun(page).getByRole("link", { name: SIGN_IN }).click()
    await expect(done(page, "Sign in")).toBeVisible({ timeout: 30_000 })
    await expect(firstRunStep(page, "Add your model")).toHaveAttribute("aria-current", "step")
    await expect(firstRunStep(page, "Open your repository")).toHaveAttribute("data-state", "later")
    await expect(page.getByText(MEMBERS_ASK)).toHaveCount(0)
  })

  await step("Open settings and save their own model", async () => {
    await firstRunStep(page, "Add your model").getByRole("button", { name: OPEN_SETTINGS }).click()
    const section = page.getByRole("region", { name: "Your model" })
    await expect(section).toBeVisible({ timeout: 30_000 })
    await fillYourModel(section, page, {
      protocol: "openai-chat",
      baseUrl: "https://api.openai.com/v1",
      key: `sk-who-may-ask-${word}-0123456789`,
      tiers: { fast: "gpt-test" },
    })
    await expect(section.getByLabel(/compatible Key$/).first()).toHaveAttribute("placeholder", /^····/, { timeout: 30_000 })
  })

  await step("Back to chat: Open your repository is next", async () => {
    await page.getByRole("link", { name: "Back to chat" }).click()
    await expect(done(page, "Add your model")).toBeVisible({ timeout: 30_000 })
    await expect(firstRunStep(page, "Open your repository")).toHaveAttribute("aria-current", "step")
  })

  await step(`Open ${REPOSITORY}: its page`, async () => {
    const opening = firstRunStep(page, "Open your repository")
    await opening.getByRole("textbox", { name: REPOSITORY_FIELD }).fill(REPOSITORY)
    await opening.getByRole("button", { name: OPEN }).click()
    await expect(page).toHaveURL(new RegExp(`/${REPOSITORY}$`), { timeout: 30_000 })
    await expect(page.locator('header[aria-label="Repository"]')).toContainText("octocat / Spoon-Knife", { timeout: 30_000 })
  })

  await step("Open its README: the branch's workspace, the person's own conversation, the composer theirs", async () => {
    await page.getByRole("link", { name: "README.md" }).first().click()
    await expect(page.getByRole("navigation", { name: "Branch" })).toContainText("main", { timeout: 60_000 })
    await expect(page.locator(".branch-screen-conversation")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(MEMBERS_ASK)).toHaveCount(0)
  })

  const question = `Say hello to ${word}`
  await step("Ask Smithers there, and it answers", async () => {
    await a.ask(question)
    await a.expectAnswered(question, `Hello, ${word}.`, 90_000)
  })

  expectServerError(403, "/api/terminals")
  await step("A stranger can converse but cannot run a machine", async () => {
    await page.getByRole("navigation", { name: "Branch" }).getByRole("link", { name: "Terminal" }).click()
    const open = page.getByRole("button", { name: "Open terminal" })
    const refused = page.getByText("Members can run machines.", { exact: true })
    await expect(open.or(refused)).toBeVisible({ timeout: 30_000 })
    if (await open.isVisible()) await open.click()
    await expect(refused).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole("button", { name: "Open terminal" })).toHaveCount(0)
    await expect(page.locator('iframe[title="Terminal"]')).toHaveCount(0)
  })
})

test("who may ask: a Guest of a repository is never stopped on /app, and sees Members can ask Smithers. on that repository's branch", {
  annotation: {
    type: "summary",
    description: "A reader of a repository is shown the way to their own on /app; on the repository they only read, the page says only Members ask.",
  },
}, async ({ devices }) => {
  requires("devPeople")
  test.setTimeout(180_000)
  // Tracking a branch, and the branch's shapes, refuse a Guest there (worker/branch/Branches.ts): the honest refusal.
  expectServerError(403, "/api/branches")
  expectServerError(403, "/api/shapes/*")
  const [a] = await devices.openAs(`reader-${devices.word}`, "Reader")
  const page = a.page

  await step("On /app: Sign in done and the way to their own repository, no dead end", async () => {
    await page.goto("/app")
    await a.ready()
    await expect(done(page, "Sign in")).toBeVisible({ timeout: 30_000 })
    await expect(firstRunStep(page, "Add your model")).toHaveAttribute("aria-current", "step")
    await expect(firstRunStep(page, "Open your repository")).toBeVisible()
    await expect(page.getByText(MEMBERS_ASK)).toHaveCount(0)
  })

  await step(`On ${REPOSITORY}'s main, which they only read: Members can ask Smithers., and no composer`, async () => {
    await page.goto(`/${REPOSITORY}/tree/main`)
    await expect(page.getByText(MEMBERS_ASK)).toBeVisible({ timeout: 60_000 })
    await expect(a.composer).toHaveCount(0)
  })
})

pageTest("who may ask: on a repository the account only reads, the branch says Members can ask Smithers., whatever its role on the deployment's own", {
  annotation: {
    type: "summary",
    description: "A Member of the deployment's repository who only reads another repository with the App gets no composer there.",
  },
}, async ({ page }) => {
  requires("member")
  // smithersai/vibelang has the App, and the test account only reads it on a deployment; where it is a Member there,
  // as local development's developer is, there is nothing to refuse.
  const role = ((await (await page.request.get("/api/repos/smithersai/vibelang/role")).json()) as { role?: string | null }).role
  pageTest.skip(role === "admin" || role === "maintainer" || role === "member", "the account is a Member or above on smithersai/vibelang here")
  expectServerError(403, "/api/branches")
  expectServerError(403, "/api/shapes/*")
  await step("Open smithersai/vibelang's main: Members can ask Smithers., and no composer", async () => {
    await page.goto("/smithersai/vibelang/tree/main")
    await expect(page.getByText(MEMBERS_ASK)).toBeVisible({ timeout: 60_000 })
    await expect(page.getByRole("textbox", { name: "Message Smithers" })).toHaveCount(0)
  })
})
