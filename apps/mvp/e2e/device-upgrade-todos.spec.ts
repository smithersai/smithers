import type { Page } from "@playwright/test"
import { statSync } from "node:fs"
import { join } from "node:path"
import { serveBuilds } from "./builds"
import { expect, step, test } from "./fixtures"
import { serverFaults } from "./server-faults"
import { shapeRows } from "./shape"
import { dropWord } from "./stackWrites"
import { oldBuildDir, requires, stackRepository } from "./target"
import { expectConsoleError, expectOfflineErrors, expectServerError } from "./watch"
import { chooseIssue } from "./todoDraft"

// A deploy that moved the stack's device stores a version (decision 0153: todo-requested 4 to 5, the todo-sending
// payload 2 to 3), on one device. The build production ran before it (its files in OLD_BUILD_DIR, docs/infrastructure.md
// #device-data-across-a-deploy) commits three TODOs on the stack page: one the route takes and Electric hasn't shown
// (Requested), one the route refuses (Not sent), and one queued offline in the outbox. Then this build opens on the same
// origin, so the same OPFS store and IndexedDB outbox: the queued commit is sent once, and the Requested and Not sent
// rows still show. ChatApi, its stack writer, Electric and Postgres are the dev server's, for both builds.
//
// Two things are held so the rows are the device's alone: Electric's updates to the stack's TODOs, so a Requested
// commit isn't resolved before the deploy, and one commit's answer, which the route gives as a refusal.

const OLD_BUILD = oldBuildDir(process.env)

test.use({ serviceWorkers: "block" })

/** WebKit's generic texts for requests the test ends on purpose: declared only once every assertion passed (see below). */
const WEBKIT_ENDED = [
  "Failed to load resource: Could not connect to the server.",
  "Failed to load resource: WebKit encountered an internal error",
  "Failed to load resource: The network connection was lost.",
  "due to access control checks.",
]


// What the test causes on purpose (2026-11-03, each read from the server's own answers in both browsers): it refuses one
// commit (403 forbidden), and the dev server has no summary model (409 no_route).
expectServerError(403, "/api/repos/*/stack")
expectServerError(409, "/api/model/summary")
expectOfflineErrors()

test(
  "deploy: the deployed build's queued, Requested and Not sent stack changes are this build's, and the queued one is sent once",
  {
    annotation: {
      type: "summary",
      description: "A device's stack changes survive a deploy that moved their stores a version: sent once, and still shown.",
    },
  },
  async ({ page, context, request }) => {
    requires("localServer", "oldBuild", "member", "writableStack")
    test.setTimeout(300_000)
    expect(statSync(join(OLD_BUILD, "index.html")).size, "the deployed build's index.html is empty").toBeGreaterThan(0)
    const repo = stackRepository()
    const word = `todoup-${Date.now().toString(36)}`
    const requested = `Requested before the deploy ${word}`
    const refused = `Refused before the deploy ${word}`
    const queued = `Queued offline before the deploy ${word}`
    const builds = await serveBuilds({ old: OLD_BUILD })
    const stack = page.getByRole("region", { name: `${repo} stack` })
    const row = (title: string) => stack.locator("[data-slot=issues-row]", { hasText: title })
    const notSent = page.getByRole("list", { name: "Not sent" })
    // The stack's own answer, from Postgres through its shape: how many TODOs carry `title`.
    const onServer = async (title: string) =>
      (await shapeRows<{ readonly title: string }>(request, `/api/shapes/todos?repo=${repo}&log=full`))
        .filter((todo) => todo.title === title).length
    const openStack = async () => {
      await page.goto(new URL(`/${repo}/stack`, builds.url).href)
      await expect(stack).toBeVisible({ timeout: 60_000 })
    }
    const commit = async (page: Page, title: string) => {
      await page.getByRole("button", { name: "New TODO" }).click()
      const draft = page.getByRole("form", { name: "TODO draft" }).first()
      await draft.getByLabel("Title").fill(title)
      await draft.getByLabel("Prompt").fill(`Add a line to the README: ${title}`)
      // A TODO hangs under exactly one issue (decision 0153): a build with the Issue picker waits for one before Commit.
      // A build from before 0153 has no picker and commits without one.
      if (await draft.getByLabel("Issue").count() > 0) await chooseIssue(draft)
      await draft.getByRole("button", { name: "Commit" }).click()
    }
    // Electric's live updates are held from the start, so a commit the route takes stays Requested.
    const faults = serverFaults(context)
    await faults.shapes.hold("todos-live")
    try {
      await step("Open the deployed build's stack", openStack)
      await step("Commit one the route takes: Requested, and Electric hasn't shown it", async () => {
        await commit(page, requested)
        await expect(row(requested)).toHaveAttribute("data-pending", "requested", { timeout: 30_000 })
        await expect.poll(() => onServer(requested), { timeout: 30_000 }).toBe(1)
      })
      await step("Commit one the route refuses: Not sent", async () => {
        await faults.stack.refuse()
        await commit(page, refused)
        await expect(notSent.getByRole("listitem").filter({ hasText: refused })).toContainText("Not allowed", { timeout: 30_000 })
        await faults.stack.heal()
        expect(await onServer(refused)).toBe(0)
      })
      await step("Go offline and commit one more: it waits in the outbox", async () => {
        await context.setOffline(true)
        await commit(page, queued)
        await expect(row(queued)).toHaveAttribute("data-pending", "requested", { timeout: 15_000 })
        // Leave while offline, so only the next build's outbox can send it.
        await page.goto("about:blank")
        await context.setOffline(false)
        expect(await onServer(queued)).toBe(0)
      })

      await step("Deploy: the origin serves this build, and Electric's TODO shape is held entirely", async () => {
        builds.use("new")
        await faults.shapes.hold("todos")
      })
      await step("This build sends the queued commit once, and shows all three of the device's changes", async () => {
        await openStack()
        await expect.poll(() => onServer(queued), { timeout: 60_000 }).toBe(1)
        await expect(row(requested)).toHaveAttribute("data-pending", "requested", { timeout: 30_000 })
        await expect(row(queued)).toHaveAttribute("data-pending", "requested", { timeout: 30_000 })
        await expect(notSent.getByRole("listitem").filter({ hasText: refused })).toContainText("Not allowed")
      })
      await step("With Electric's answer, both commits are numbered once, and the refused one is still Not sent", async () => {
        await faults.shapes.heal()
        await page.reload()
        await expect(stack).toBeVisible({ timeout: 60_000 })
        for (const title of [requested, queued]) {
          await expect(row(title)).toContainText(/T\d+/, { timeout: 60_000 })
          await expect(row(title)).not.toHaveAttribute("data-pending", /.+/, { timeout: 60_000 })
        }
        await expect(notSent.getByRole("listitem").filter({ hasText: refused })).toContainText("Not allowed")
        expect([await onServer(requested), await onServer(queued), await onServer(refused)]).toEqual([1, 1, 0])
      })
      // WebKit logs each request the test ends (offline, navigation away, aborted holds, teardown) as one of these generic
      // texts. e2e/problems.ts can't scope a declaration to a step: it counts problems by line, with no time, and is
      // read once the test ends. So they are declared here, after the last assertion: a run that fails before this
      // lists them, and only a run whose every step passed excuses them.
      for (const text of WEBKIT_ENDED) expectConsoleError(text)
    } finally {
      await faults.stack.heal()
      await faults.shapes.heal()
      // Off the front before it closes, so no request of the page's dies with it.
      await page.goto("about:blank").catch(() => undefined)
      await builds.close()
      await dropWord(page, repo, word).catch(() => undefined)
    }
  },
)
