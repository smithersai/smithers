import { expect, test } from "./devices"
import { requires } from "./target"
import { installWebPages, viewsAdded, webPages } from "./web-page-fixtures"

// These journeys always use the real agent and the production runner's model read lease.
test.describe("outside pages", () => {
  installWebPages()

  test("the agent asked to embed a page that refuses framing adds the card instead", { annotation: { type: "summary", description: "The agent's call checks the page too, and never claims an embed" } }, async ({ devices }) => {
    requires("member", "ownConversation", "liveModel")
    const word = devices.word
    const [a] = await devices.open("A")
    const added = viewsAdded(a.device.context)

    const { refuses } = webPages()
    const prompt = `Show me ${refuses.url} in the chat, then reply with the word web-${word}.`
    await a.askAndWaitTaken(prompt)
    await expect.poll(() => added.length, { timeout: 60_000 }).toBe(1)
    expect(added[0]).toMatchObject({ template: "link", props: { url: refuses.url, ...refuses.preview } })
    const card = a.page.locator(`[data-view="${added[0]!.id}"] [data-slot="web-link-card"]`)
    await expect(card.locator('[data-slot="web-page-title"]')).toHaveText(refuses.preview.title!, { timeout: 30_000 })
    await a.expectAnswered(prompt, `web-${word}`)
  })

  test("the agent's tab card shows the page's domain, and its Open in new tab opens the page", async ({ devices }) => {
    requires("member", "ownConversation", "liveModel")
    const word = devices.word
    const [a] = await devices.open("A")
    const added = viewsAdded(a.device.context)
    const app = a.page.url()

    const { tab } = webPages()
    const prompt = `Open ${tab.url} in a new browser tab, then reply with the word tab-${word}.`
    await a.askAndWaitTaken(prompt)
    await expect.poll(() => added.filter((view) => view.template === "link").length, { timeout: 60_000 }).toBe(1)
    const link = added.find(view => view.template === "link")!
    expect(link).toMatchObject({ template: "link", props: { url: tab.url, ...tab.preview } })
    const card = a.page.locator(`[data-view="${link.id}"]`)
    // This public fixture allows framing: an accidental embed produces a webpage, so cannot pass as a tab card.
    // HTTPS shows the host; a local HTTP page shows its whole origin, including the scheme.
    await expect(card.locator('[data-slot="web-page-domain"]')).toHaveText(new URL(tab.url).protocol === "https:" ? new URL(tab.url).host : new URL(tab.url).origin, { timeout: 30_000 })
    await expect(card.locator('[data-slot="web-page-title"]')).toHaveText(tab.preview.title!)
    await a.expectAnswered(prompt, `tab-${word}`)

    const opening = a.device.context.waitForEvent("page")
    await card.getByRole("link", { name: `Open in new tab: ${tab.preview.title}` }).click()
    const opened = await opening
    await opened.waitForLoadState()
    expect(opened.url()).toBe(tab.url)
    await expect(opened).toHaveTitle(tab.documentTitle!)
    // The app itself stayed where it was.
    await expect(a.page).toHaveURL(app)
  })

})
