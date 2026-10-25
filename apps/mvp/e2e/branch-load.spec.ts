import { expect, test } from "./devices"
import { step } from "./fixtures"
import { BUDGET, paintOf, watchPaint } from "./paint"
import { ownPlace, requires, target, writeHeaders } from "./target"

// The branch page's conversation shows at once (docs/features/branch-workspace.md#the-page): on a long conversation,
// after a reload that cut its summaries off mid-flight, as on smithers.sh on 2026-10-22, where it showed 20 to 45 s
// after the page's chrome. Locally on the fixture branch below, whose conversation the test fills first; on a
// deployment on the test account's own branch, whose conversation the suite has already filled. The fixture is the
// public `octocat/Spoon-Knife`'s default branch, which no other suite opens; nothing is written to GitHub.

requires("personalModel", "member", "ownConversation")

const REPO = { owner: "octocat", name: "Spoon-Knife", ref: "main" }

/** Asks and answers in the conversation: a window's worth of entries for the timeline to summarize. */
const ENTRIES = 50

test("Branch page: its conversation shows with its chrome, even after a reload behind a long conversation's summaries", {
  annotation: { type: "summary", description: "A long branch conversation shows within 3 s of the page, reload included." },
}, async ({ devices }) => {
  test.setTimeout(240_000)
  const [a] = await devices.open("Load")
  const path = ownPlace()?.path ?? `/${REPO.owner}/${REPO.name}/tree/${REPO.ref}`
  if (target === "local") {
    await step(`Fill the branch's conversation with ${ENTRIES} entries`, async () => {
      const tracked = await a.page.request.post("/api/branches", { data: REPO })
      expect([200, 201]).toContain(tracked.status())
      const { conversationId } = (await tracked.json()) as { readonly conversationId: string }
      for (let n = 0; n < ENTRIES / 2; n++) {
        const id = crypto.randomUUID()
        const answerId = crypto.randomUUID()
        const asked = await a.page.request.post("/api/questions", {
          data: { id, answerId, conversationId, text: `Check release step ${n + 1}` },
          headers: writeHeaders(),
        })
        expect(asked.status()).toBe(202)
        const answered = await a.page.request.post(`/api/answers/${answerId}`, {
          data: { status: "done", text: `Release step ${n + 1} passed both of its checks.` },
        })
        expect(answered.status()).toBe(200)
      }
    })
  }
  if (new URL(a.page.url()).pathname !== path) {
    await step("Visit the branch: its summaries start", async () => {
      const summarizing = a.page.waitForRequest((request) => new URL(request.url()).pathname === "/api/model/summary", {
        timeout: 15_000,
      }).catch(() => undefined)
      await a.page.goto(path)
      await expect(a.page.getByRole("navigation", { name: "Branch" })).toBeVisible({ timeout: 30_000 })
      await summarizing
    })
  }
  await a.page.addInitScript(watchPaint)
  // The last visit left the branch's summaries running in the device's engine, as every earlier visit on smithers.sh
  // did (on a deployment, e2e/devices.ts opens the branch, then reloads): this open and the reload after it cut them off.
  await step("Open the branch: its conversation starts summarizing", async () => {
    const summarizing = a.page.waitForRequest((request) => new URL(request.url()).pathname === "/api/model/summary", {
      timeout: 15_000,
    }).catch(() => undefined)
    await a.page.goto(path)
    const { chrome, conversation } = await paintOf(a.page)
    await summarizing
    const after = Math.round(conversation - chrome)
    test.info().annotations.push({ type: "open", description: `${after} ms` })
    expect(after, "the conversation shows within 3 s of the branch's chrome").toBeLessThanOrEqual(BUDGET)
  })
  await step("Reload while its summaries run", async () => {
    await a.page.reload()
    const { chrome, conversation } = await paintOf(a.page)
    const after = Math.round(conversation - chrome)
    test.info().annotations.push({ type: "reload", description: `${after} ms` })
    expect(after, "the conversation shows within 3 s of the branch's chrome").toBeLessThanOrEqual(BUDGET)
  })
  await step("Open the composer with ⌘K", async () => {
    await a.page.keyboard.press("ControlOrMeta+k")
    await expect(a.composer).toBeVisible()
  })
})
