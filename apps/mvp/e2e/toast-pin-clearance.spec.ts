import type { Locator } from "@playwright/test"
import { expect, test } from "./devices"
import { step } from "./fixtures"
import { requires } from "./target"
import { expectServerError } from "./watch"

requires("localServer", "member", "hostedModelOff")
test.use({ trace: "off" })

/** Visibility alone doesn't detect a toast intercepting the button's pointer. */
const unobstructed = async (control: Locator) => {
  await expect(control).toBeInViewport({ ratio: 1 })
  await expect.poll(() => control.evaluate(element => {
    const box = element.getBoundingClientRect()
    return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
  }), { message: `${await control.getAttribute("aria-label")} receives the pointer` }).toBe(true)
}

for (const viewport of [{ width: 1190, height: 785 }, { width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`pinned controls stay clear of Add your model at ${viewport.width}x${viewport.height}`, {
    annotation: { type: "summary", description: "The toast stays fully visible; collapse, expand and unpin receive clicks without shifting the page on Hide." },
  }, async ({ devices }) => {
    test.setTimeout(180_000)
    expectServerError(409, "/api/model/*")
    const [a] = await devices.open("Pinned message")
    const page = a.page
    await page.setViewportSize(viewport)
    await page.emulateMedia({ reducedMotion: viewport.width === 390 ? "reduce" : "no-preference" })
    const id = crypto.randomUUID(), answerId = crypto.randomUUID()
    const pinned = page.getByRole("region", { name: "Pinned message", exact: true })
    const notice = page.locator('[data-slot="toast"][data-add-model]')
    const conversation = page.locator(".app-shell-conversation")
    const composer = page.locator(".app-shell-composer")
    try {
      await step("Pin an existing message without a model", async () => {
        expect((await page.request.post("/api/questions", { data: { id, answerId, text: `Reply with exactly the word: ${devices.word}${viewport.width === 1440 ? "\n" + "Context for the pinned message.\n".repeat(60) : ""}` } })).status()).toBe(202)
        expect((await page.request.post(`/api/answers/${answerId}`, { data: { status: "failed", failure: "unfinished" } })).status()).toBe(200)
        expect((await page.request.post("/api/message-pin", { data: { messageId: id, at: Date.now() } })).status()).toBe(200)
        await page.reload()
        await expect(pinned).toHaveAttribute("data-message-id", id, { timeout: 60_000 })
        await expect(notice).toBeInViewport({ ratio: 1, timeout: 30_000 })
        await expect.poll(() => notice.evaluate(element => Number(getComputedStyle(element).opacity))).toBe(1)
      })
      await step("Collapse and expand the pin while its toast shows", async () => {
        await unobstructed(pinned.getByRole("button", { name: "Collapse pinned message" }))
        await unobstructed(pinned.getByRole("button", { name: "Unpin message" }))
        await pinned.getByRole("button", { name: "Collapse pinned message" }).click()
        await expect(pinned.locator(".mvp-pin-content")).toBeHidden()
        await unobstructed(pinned.getByRole("button", { name: "Expand pinned message" }))
        await unobstructed(pinned.getByRole("button", { name: "Unpin message" }))
        await pinned.getByRole("button", { name: "Expand pinned message" }).click()
        await expect(pinned.locator(".mvp-pin-content")).toBeVisible()
        await expect(notice).toBeInViewport({ ratio: 1 })
        const pinBox = (await pinned.boundingBox())!
        expect((await notice.boundingBox())!.y, "the toast clears the pin's actual height").toBeGreaterThanOrEqual(pinBox.y + pinBox.height)
        await unobstructed(notice.getByRole("button", { name: "Open settings" }))
        await unobstructed(notice.getByRole("button", { name: "Hide", exact: true }))
      })
      await step("Hide keeps the pin, conversation and composer in place", async () => {
        const before = await Promise.all([pinned.boundingBox(), conversation.boundingBox(), composer.boundingBox()])
        await page.keyboard.press("Alt+t")
        await expect(notice.locator("[data-toast-focus]")).toBeFocused()
        await page.keyboard.press("h")
        await expect(notice).toHaveCount(0)
        expect(await Promise.all([pinned.boundingBox(), conversation.boundingBox(), composer.boundingBox()])).toEqual(before)
        await page.reload()
        await expect(notice).toBeInViewport({ ratio: 1, timeout: 30_000 })
      })
      await step("Unpin receives its click with the toast still visible", async () => {
        const unpin = pinned.getByRole("button", { name: "Unpin message" })
        await unobstructed(unpin)
        const saved = page.waitForResponse(response => new URL(response.url()).pathname === "/api/message-pin" && response.request().method() === "POST")
        await unpin.click()
        expect((await saved).status()).toBe(200)
        await expect(pinned).toHaveCount(0)
        await expect(notice).toBeInViewport({ ratio: 1 })
      })
    } finally {
      await page.request.post("/api/message-pin", { data: { messageId: null, at: Date.now() } })
    }
  })
}
