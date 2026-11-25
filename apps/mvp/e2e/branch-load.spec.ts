import { recordExchange, withAttachedAgent } from "./attach"
import { expect, test } from "./devices"
import { step } from "./fixtures"
import { BUDGET, paintOf, watchPaint } from "./paint"
import { ownPlace, requires, target } from "./target"

// The branch page paints its recorded conversation with its chrome, both on open and on reload.
// The local test fills a fixture branch through chat admission and MCP before measuring the page.

requires("member", "ownConversation")

const REPO = { owner: "octocat", name: "Spoon-Knife", ref: "main" }

/** Asks and answers in the conversation: a window's worth of timeline entries. */
const ENTRIES = 50

test("Branch page: its conversation shows with its chrome on open and reload", {
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
      await withAttachedAgent(a.page, async (agent) => {
        for (let n = 0; n < ENTRIES / 2; n++) {
          await recordExchange(agent,
            { id: crypto.randomUUID(), answerId: crypto.randomUUID(), text: "Check release step " + (n + 1) },
            "Release step " + (n + 1) + " passed both of its checks after retrying the second one once.")
        }
      }, { repo: REPO.owner + "/" + REPO.name, branch: REPO.ref, conversation: conversationId })
    })
  }
  await a.page.addInitScript(watchPaint)
  await step("Open the branch with its recorded conversation", async () => {
    await a.page.goto(path)
    const { chrome, conversation } = await paintOf(a.page)
    const after = Math.round(conversation - chrome)
    test.info().annotations.push({ type: "open", description: `${after} ms` })
    expect(after, "the conversation shows within 3 s of the branch's chrome").toBeLessThanOrEqual(BUDGET)
  })
  await step("Reload the long conversation", async () => {
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
