import { questionIn } from "./messages"
import { statSync } from "node:fs"
import { join } from "node:path"
import { serveBuilds } from "./builds"
import { serverRows } from "./devices"
import { expect, QUEUED, step, test } from "./fixtures"
import { oldBuildDir, requires } from "./target"

// A deploy, on one device (decisions 0021 and 0023): the build production ran before it (its files, mirrored from
// production, in OLD_BUILD_DIR) makes a synced message, a question queued offline and a draft while signed in. Then
// this build opens on the same origin, so the same OPFS store and IndexedDB outbox. Its owner check finds the old
// build's confirmed login is the person signed in, makes them the device's owner and keeps everything: the queued
// question is sent once and the draft is still the draft. The owner then queues a question and saves a draft offline
// in this build; both survive reopening. ChatApi, Electric and Postgres are the dev server's, for both builds. Service
// workers are blocked, so the reload gets the build the origin serves now, as a deploy's service worker update does.
// It serves both builds from this machine (e2e/builds.ts), so it runs locally only, and the old build must be on disk.

const OLD_BUILD = oldBuildDir(process.env)

test.use({ serviceWorkers: "block" })

test(
  "deploy: the deployed build's synced message, queued question and draft are its owner's in this build, and stay",
  {
    annotation: {
      type: "summary",
      description: "A device's messages, its queued question and its draft survive a deploy, and its owner's new ones survive reload."
    }
  },
  async ({ page, context, request }) => {
    requires("localServer", "oldBuild", "member")
    // A mirror that saved the site's redirect for /index.html has an empty page (docs/infrastructure.md).
    expect(statSync(join(OLD_BUILD, "index.html")).size, "the deployed build's index.html is empty").toBeGreaterThan(0)
    const builds = await serveBuilds({ old: OLD_BUILD })
    try {
      const app = new URL("/app", builds.url).href
      const conversation = page.getByRole("region", { name: "Conversation", exact: true })
      const composer = page.getByRole("textbox", { name: "Message Smithers" })
      const question = (text: string) =>
        questionIn(conversation, text)
      const openComposer = async () => {
        if (await composer.isHidden()) await page.keyboard.press("ControlOrMeta+k")
        await expect(composer).toBeVisible()
      }
      const word = `deploy-${Date.now().toString(36)}`
      const synced = `Which build is this, ${word}?`
      const queued = `Asked offline before the deploy, ${word}`
      const draft = `A draft kept across the deploy, ${word}`
      const ownedQueued = `Asked offline after the deploy, ${word}`
      const ownedDraft = `A draft made after the deploy, ${word}`
      // The questions Postgres holds for this run, read through ChatApi's shape as devices read them.
      const storedRows = async () => (await serverRows(request, word)).filter((row) => row.role === "user")
      const stored = async () => (await storedRows()).map((row) => row.text)
      // Each question reaches Postgres once, under the id the device gave it.
      const sentOnce = async (ids: ReadonlyArray<string | null>) => {
        const rows = await storedRows()
        for (const id of ids) expect(rows.filter((row) => row.id === id)).toHaveLength(1)
      }
      let queuedId: string | null = null
      let ownedQueuedId: string | null = null

      await step("Open the deployed build", async () => {
        await page.goto(app)
        await expect(page.getByRole("main", { name: "App" })).toBeVisible({ timeout: 60_000 })
      })
      await step("Ask a question online", async () => {
        await openComposer()
        await composer.fill(synced)
        await composer.press("Enter")
        await expect(question(synced)).toHaveCount(1)
        // Postgres has it before the device goes offline: a synced row, not one waiting in the outbox.
        await expect.poll(stored, { timeout: 30_000 }).toContain(synced)
      })
      await step("Go offline and ask again", async () => {
        await context.setOffline(true)
        await composer.fill(queued)
        await composer.press("Enter")
        await expect(question(queued).getByText(QUEUED, { exact: true })).toBeVisible({ timeout: 15_000 })
        queuedId = await question(queued).getAttribute("data-id")
        expect(queuedId).toEqual(expect.any(String))
      })
      await step("Leave a draft", async () => {
        await composer.fill(draft)
        // The old build marks the draft once the device stored it.
        await expect(composer).toHaveAttribute("data-draft", "saved", { timeout: 15_000 })
      })

      await step("Deploy: the origin serves this build, and the device is back online", async () => {
        await page.goto("about:blank")
        builds.use("new")
        await context.setOffline(false)
      })
      await step("Open this build on the same device", async () => {
        await page.goto(app)
        await expect(page.getByRole("main", { name: "App" })).toBeVisible({ timeout: 60_000 })
      })
      await step("The synced message is there", async () => {
        await expect(question(synced)).toHaveCount(1, { timeout: 60_000 })
      })
      await step("The question queued before the deploy is sent, once", async () => {
        await expect(question(queued)).toHaveCount(1, { timeout: 60_000 })
        // This build's outbox sent the old build's write as its owner's: Postgres has it, once.
        await expect.poll(stored, { timeout: 60_000 }).toEqual([synced, queued])
        await sentOnce([queuedId])
        await expect(question(queued).getByText(QUEUED, { exact: true })).toHaveCount(0)
      })
      await step("The draft is in the composer, and stays", async () => {
        await openComposer()
        await expect(composer).toHaveValue(draft, { timeout: 30_000 })
        // This build stored it too, and it is still the draft once stored.
        await expect(composer).toHaveAttribute("data-draft", "saved", { timeout: 15_000 })
        await expect(composer).toHaveValue(draft)
      })
      await step("Offline, the owner asks again and leaves a new draft", async () => {
        await context.setOffline(true)
        await composer.fill(ownedQueued)
        await composer.press("Enter")
        await expect(question(ownedQueued).getByText(QUEUED, { exact: true })).toBeVisible({ timeout: 15_000 })
        ownedQueuedId = await question(ownedQueued).getAttribute("data-id")
        expect(ownedQueuedId).toEqual(expect.any(String))
        await composer.fill(ownedDraft)
        await expect(composer).toHaveAttribute("data-draft", "saved", { timeout: 15_000 })
        // Leave while still offline, so the write reaches Postgres only from the next activation's stored outbox.
        await page.goto("about:blank")
        await context.setOffline(false)
        await page.goto(app)
        await expect(page.getByRole("main", { name: "App" })).toBeVisible({ timeout: 60_000 })
      })
      await step("Reopened: the owner's question is sent once, and their draft stays", async () => {
        await expect(question(ownedQueued)).toHaveCount(1, { timeout: 60_000 })
        await expect.poll(stored, { timeout: 60_000 }).toEqual([synced, queued, ownedQueued])
        await sentOnce([queuedId, ownedQueuedId])
        await expect(question(ownedQueued).getByText(QUEUED, { exact: true })).toHaveCount(0)
        await openComposer()
        await expect(composer).toHaveValue(ownedDraft, { timeout: 30_000 })
        await expect(composer).toHaveAttribute("data-draft", "saved")
      })
      await step("Reload: the draft is still there, and nothing is sent again", async () => {
        await page.reload()
        await expect(page.getByRole("main", { name: "App" })).toBeVisible({ timeout: 60_000 })
        await openComposer()
        await expect(composer).toHaveValue(ownedDraft, { timeout: 30_000 })
        await expect(composer).toHaveAttribute("data-draft", "saved")
        expect(await stored()).toEqual([synced, queued, ownedQueued])
        await sentOnce([queuedId, ownedQueuedId])
      })
    } finally {
      await builds.close()
    }
  }
)
