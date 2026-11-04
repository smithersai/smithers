import { CANT_OPEN } from "../src/features/web/contract"
import { expect, test } from "./devices"
import { wholeText } from "./console"
import { requires, target } from "./target"
import { installWebPages, SANDBOX, typing, viewsAdded, webPages } from "./web-page-fixtures"

// Person-driven journeys have no model lease. The real-agent journeys live in web-page-agent.spec.ts.
test.describe("outside pages", () => {
  installWebPages()

  test("a page that allows framing shows in the chat, on every device and at full size", { annotation: { type: "summary", description: "ChatApi checks the page first; it allows frames, so it shows in the chat" } }, async ({ devices }) => {
    requires("member", "ownConversation")
    const [a, b] = await devices.open("A", "B")
    const added = viewsAdded(a.device.context)
    const { allows } = webPages()
    const url = allows.url

    await test.step("A sends /web with a page that allows framing", async () => {
      await a.openComposer()
      await a.composer.pressSequentially(`/web ${url}`, typing)
      await a.composer.press("Enter")
    })
    await expect.poll(() => added.length, { timeout: 60_000 }).toBe(1)
    expect(added[0]).toMatchObject({
      template: "webpage",
      props: { url, ...allows.preview },
    })
    const view = a.page.locator(`[data-view="${added[0]!.id}"]`)

    await test.step("the page shows in its frame, under its origin", async () => {
      await expect(view).toBeVisible({ timeout: 30_000 })
      await expect(view.locator('[data-slot="web-page-origin"]')).toHaveText(new URL(url).origin)
      const frame = view.locator("iframe")
      await expect(frame).toHaveAttribute("src", url)
      await expect(frame).toHaveAttribute("sandbox", SANDBOX)
      await expect(view.locator('[data-slot="web-page-view"]')).toHaveAttribute("data-state", "loaded", { timeout: 30_000 })
      // The page itself, not a browser error: the frame rendered it.
      await expect(view.frameLocator("iframe").locator("h1")).toBeVisible({ timeout: 30_000 })
      await expect(view.frameLocator("iframe").locator("h1")).toHaveText(allows.heading!, { timeout: 30_000 })
      await expect(view.locator('[data-slot="web-link-card"]')).toHaveCount(0)
    })

    await test.step("B shows it from its own synced copy", async () => {
      const synced = b.page.locator(`[data-view="${added[0]!.id}"]`)
      // Frames are lazy. Read the second device's view as a person would, by scrolling it into sight first.
      await synced.scrollIntoViewIfNeeded({ timeout: 30_000 })
      await expect(synced.locator("iframe")).toHaveAttribute("src", url, { timeout: 30_000 })
      await expect(synced.frameLocator("iframe").locator("h1")).toHaveText(allows.heading!, { timeout: 30_000 })
    })

    await test.step("Full screen shows the same page at its own route", async () => {
      await view.getByRole("link", { name: "Full screen" }).click()
      await expect(a.page).toHaveURL(new RegExp(`/app/views/${added[0]!.id}(?:\\?|$)`))
      const full = a.page.getByRole("main", { name: "View" })
      await expect(full.frameLocator("iframe").locator("h1")).toHaveText(allows.heading!, { timeout: 30_000 })
      await full.getByRole("link", { name: "Back to chat" }).click()
      await expect(a.page).toHaveURL(/\/app$/)
    })
  })

  test("a page that refuses framing shows as a card: title, description, domain, icon and Open in new tab, with Enter", { annotation: { type: "summary", description: "The page's framing headers refuse the app, so a card shows instead of a broken frame" } }, async ({ devices }) => {
    requires("member", "ownConversation")
    const [a] = await devices.open("A")
    const added = viewsAdded(a.device.context)
    const { refuses } = webPages()
    const url = refuses.url
    const app = a.page.url()

    await test.step("A sends /web with a page that refuses framing", async () => {
      await a.openComposer()
      await a.composer.pressSequentially(`/web ${url}`, typing)
      await a.composer.press("Enter")
    })
    await expect.poll(() => added.length, { timeout: 60_000 }).toBe(1)
    expect(added[0]).toMatchObject({ template: "link", props: { url, ...refuses.preview } })
    const card = a.page.locator(`[data-view="${added[0]!.id}"] [data-slot="web-link-card"]`)

    await test.step("a card shows what the page is, and no frame", async () => {
      await expect(card).toBeVisible({ timeout: 30_000 })
      await expect(card.locator('[data-slot="web-page-title"]')).toHaveText(refuses.preview.title!)
      await expect(card.locator('[data-slot="web-page-description"]')).toHaveText(
        refuses.preview.description!,
      )
      await expect(card.locator('[data-slot="web-page-domain"]')).toHaveText(new URL(url).host)
      const icon = card.locator('[data-slot="web-page-icon"] img')
      await expect(icon).toHaveAttribute("src", refuses.preview.icon!)
      await expect.poll(() => icon.evaluate(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0)).toBe(true)
      await expect(a.page.locator(`[data-view="${added[0]!.id}"] iframe`)).toHaveCount(0)
    })

    await test.step("Enter on Open in new tab opens the page in a new tab", async () => {
      const open = card.getByRole("link", { name: `Open in new tab: ${refuses.preview.title}` })
      await expect(open).toHaveAttribute("aria-keyshortcuts", "Enter")
      await expect(open).toHaveAttribute("rel", "noopener noreferrer")
      const opening = a.device.context.waitForEvent("page")
      await open.focus()
      await a.page.keyboard.press("Enter")
      const opened = await opening
      await opened.waitForLoadState()
      expect(opened.url()).toBe(url)
      await expect(opened).toHaveTitle(refuses.documentTitle!)
      await opened.close()
      await expect(a.page).toHaveURL(app)
    })
  })

  test("a person's /web <url> tab opens the page straight from their Enter, and adds nothing to the chat", async ({ devices }) => {
    requires("member", "ownConversation")
    const [a] = await devices.open("A")
    const added = viewsAdded(a.device.context)
    const outcomes: Array<string> = []
    a.page.on("console", message => {
      if (!message.text().includes("web.page.open")) return
      void wholeText(message).then(text => {
        if (/"web_mode"\s*:\s*"tab"/.test(text) && /"door"\s*:\s*"slash"/.test(text)) {
          const outcome = /"outcome"\s*:\s*"([a-z]+)"/.exec(text)?.[1]
          if (outcome !== undefined) outcomes.push(outcome)
        }
      })
    })
    await a.openComposer()

    const { tab, local } = webPages()
    const url = target === "local" ? `${local}/from-enter` : tab.url
    const opening = a.device.context.waitForEvent("page")
    await a.composer.pressSequentially(`/web ${url} tab`, typing)
    await a.composer.press("Enter")
    const opened = await opening
    await opened.waitForURL(url)
    expect(opened.url()).toBe(url)
    expect(await opened.evaluate(() => window.opener)).toBeNull()
    expect(await opened.evaluate(() => document.referrer)).toBe("")
    await expect(opened).toHaveTitle(tab.documentTitle!)
    await expect(a.composer).toHaveValue("")
    // The actual gesture receipt closes the action. A delayed fallback card can never satisfy this outcome.
    await expect.poll(() => outcomes).toEqual(["opened"])
    expect(added).toEqual([])
  })

})

test("refusals: a javascript: page, and the app's own origin, stay in the composer saying why; nothing runs", async ({ devices }) => {
  requires("member")
  const [a] = await devices.open("A")
  const added = viewsAdded(a.device.context)
  const dialogs: Array<string> = []
  a.page.on("dialog", (dialog) => {
    dialogs.push(dialog.message())
    void dialog.dismiss()
  })
  const status = a.composerForm.locator(".sui-chat-composer-status")
  await a.openComposer()

  await a.composer.pressSequentially("/web javascript:alert(document.cookie)", typing)
  await a.composer.press("Enter")
  await expect(status).toHaveText(CANT_OPEN.scheme)
  await expect(a.composer).toHaveValue("/web javascript:alert(document.cookie)")

  // The app's own host: a frame of it would hand it the app, and a tab of it is /navigate's. Its plain-HTTP form is
  // refused first, whichever the app is served over.
  const app = new URL(a.page.url()).origin
  await a.composer.fill("")
  await a.composer.pressSequentially(`/web ${app.replace(/^http:/, "https:")}/app`, typing)
  await a.composer.press("Enter")
  await expect(status).toHaveText(CANT_OPEN.same_origin)
  await a.composer.fill("")
  await a.composer.pressSequentially(`/web ${app.replace(/^https:/, "http:")}/app`, typing)
  await a.composer.press("Enter")
  await expect(status).toHaveText(CANT_OPEN.insecure)

  expect(added).toEqual([])
  expect(dialogs).toEqual([])
  await expect(a.page).toHaveURL(/\/app$/)
})

test("the app's own pages refuse to be framed, and frame nothing but https pages", async ({ request, devices }) => {
  const response = await request.get("/app")
  expect(response.headers()["content-security-policy"]).toBe("frame-ancestors 'none'")
  expect(response.headers()["x-frame-options"]).toBe("DENY")
  const [a] = await devices.open("A")
  await expect(a.page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute("content", "frame-src https:")
})
