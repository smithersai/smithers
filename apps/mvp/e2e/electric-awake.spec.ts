import { expect, test } from "./devices"
import { step } from "./fixtures"
import { BUDGET, paintOf, watchPaint } from "./paint"
import { ownPlace, requires } from "./target"

// Local limitation: compose Electric does not use the Cloudflare Container idle/sleep policy being regressed here. Only an otherwise quiet deployment can prove the container stays awake; a local timer would test a different lifecycle.
//
// A deployment's sync stays up through a quiet spell (docs/infrastructure.md#electric). On smithers.sh before
// 2026-10-22, Electric's container stopped about 2 minutes after its last request, and a device's first visit after a
// quiet spell waited for it to start again with an empty disk: every shape refused 503 ("Cannot connect to the
// database to verify the shape", then "Snapshot timed out while waiting for a table lock"), 41 on one visit, and the
// branch's conversation showed 40 s after the load, more than 30 s after the reload's chrome (branchprobe after 16
// quiet minutes, 14:16 UTC). Here a new device, which holds none of the branch's rows, opens the branch as
// e2e/devices.ts opens a device (load, wait for the service worker, reload) after 12 quiet minutes, and its
// conversation shows within 3 s of the reload's chrome with no shape refused. The quiet spell is the deployment's own:
// another tab or test following shapes meanwhile keeps the old build's Electric up too, so this test fails on that
// build only when the deployment is otherwise quiet, as smithers.sh was then.

requires("personalModel", "longRun", "ownConversation")

/** Longer than the quiet spells that always stopped Electric's container before the fix (11 minutes, 12 of 12). */
const QUIET = 12 * 60_000

test("Branch page after a quiet spell: a new device's conversation shows within 3 s of the chrome, no shape refused", {
  annotation: { type: "summary", description: "After 12 quiet minutes a new device still shows the branch's conversation within 3 s." },
}, async ({ devices, browser }) => {
  test.setTimeout(QUIET + 240_000)
  const [a] = await devices.open("Quiet")
  const path = ownPlace()!.path
  await step("Leave the deployment for 12 quiet minutes: no tab follows a shape", async () => {
    await a.page.goto("about:blank")
    // The condition is the quiet spell itself: time the deployment spends with no shape request from this test.
    const parked = Date.now()
    await expect.poll(() => Date.now() - parked, { timeout: QUIET + 60_000, intervals: [30_000] }).toBeGreaterThanOrEqual(QUIET)
  })
  const context = await browser.newContext({ recordVideo: { dir: test.info().outputPath("videos") } })
  try {
    const page = await context.newPage()
    const refused: Array<string> = []
    page.on("response", (response) => {
      const { pathname } = new URL(response.url())
      if (pathname.startsWith("/api/shapes/") && response.status() === 503) refused.push(pathname)
    })
    await page.addInitScript(watchPaint)
    await step("A new device opens the branch: load, its service worker, reload", async () => {
      await page.goto(path)
      await expect(page.getByRole("navigation", { name: "Branch" })).toBeVisible({ timeout: 60_000 })
      await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined))
      await page.reload()
    })
    await step("Its conversation shows within 3 s of the chrome, and no shape is refused", async () => {
      const { chrome, conversation } = await paintOf(page)
      const after = Math.round(conversation - chrome)
      test.info().annotations.push({ type: "after a quiet spell", description: `${after} ms` })
      expect(after, "the conversation shows within 3 s of the branch's chrome").toBeLessThanOrEqual(BUDGET)
      // The suite filled the test account's own conversation: its entries synced, through every shape this load opened.
      await expect(page.getByRole("region", { name: "Conversation", exact: true }).locator(".sui-chat-message").first())
        .toBeVisible({ timeout: 30_000 })
      expect(refused, "no shape request is refused while Electric starts").toEqual([])
    })
  } finally {
    await context.close()
  }
})
