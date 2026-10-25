import { expect } from "@playwright/test"
import { COULDNT_ANSWER, test } from "./devices"
import { step } from "./fixtures"
import { ownPlace, requires, scriptedAgent } from "./target"

for (const width of [390, 768, 1280]) {
  test(`pin at ${width}: stays above a long conversation and follows only its person`, {
    annotation: { type: "summary", description: "Pin, scroll, collapse, sync across devices, and unpin without changing another person's view." },
  }, async ({ devices }) => {
    requires("devPeople", "scriptedAgent")
    test.setTimeout(180_000)
    devices.atWidth(width)
    const [first, second] = await devices.open("First device", "Second device")
    const [other] = await devices.openTeammate("Another person")
    await first!.page.goto(scriptedAgent("pin-message"))
    await first!.ready()
    const question = `${devices.word}: Write 35 numbered lines about a garden, one short sentence per line. Start with GARDEN.`
    await first!.ask(question)
    await first!.expectAnswered(question, "GARDEN")
    const reply = first!.answerTo(question)
    const id = (await reply.getAttribute("data-id"))!
    const pinned = first!.page.getByRole("region", { name: "Pinned message", exact: true })
    await test.step("Pin the agent's reply", async () => {
      await reply.hover()
      await reply.getByRole("button", { name: "Pin message", exact: true }).click()
      await expect(pinned).toHaveAttribute("data-message-id", id)
      if (width === 1280) await expect(first!.page.getByRole("navigation", { name: "Conversation timeline", exact: true })).toBeInViewport()
      await expect(second!.page.getByRole("region", { name: "Pinned message", exact: true })).toHaveAttribute("data-message-id", id)
      await expect(other!.page.getByRole("region", { name: "Pinned message", exact: true })).toHaveCount(0)
    })
    await test.step("Scroll the conversation beneath the pin", async () => {
      const conversation = first!.page.getByRole("region", { name: "Conversation", exact: true })
      const top = async () => {
        const [copy, column] = await Promise.all([pinned.boundingBox(), conversation.boundingBox()])
        return Math.round(copy!.y - column!.y)
      }
      await expect.poll(top).toBe(0)
      const scroll = first!.page.locator('[data-slot="message-scroller-viewport"]')
      expect(await scroll.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true)
      await scroll.evaluate(node => { node.scrollTop = 0 })
      await expect.poll(top).toBe(0)
      await scroll.evaluate(node => { node.scrollTop = node.scrollHeight })
      expect(await scroll.evaluate(node => node.scrollTop)).toBeGreaterThan(0)
      await expect.poll(top).toBe(0)
      await expect(pinned).toBeInViewport()
      const content = pinned.locator(".mvp-pin-content")
      expect(await content.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true)
      expect((await pinned.boundingBox())!.height).toBeLessThan(320)
      await content.evaluate(node => { node.scrollTop = node.scrollHeight })
      await pinned.getByRole("button", { name: "Collapse pinned message" }).click()
      await expect(content).toBeHidden()
      await expect(first!.composer).toBeVisible()
      await pinned.getByRole("button", { name: "Expand pinned message" }).click()
      await expect(content).toBeVisible()
    })
    await test.step("Reload the second device and replace the pin with the person's message", async () => {
      await second!.reload()
      await expect(second!.page.getByRole("region", { name: "Pinned message", exact: true })).toHaveAttribute("data-message-id", id)
      const own = first!.question(question)
      await own.hover()
      await own.getByRole("button", { name: "Pin message", exact: true }).click()
      await expect(pinned).toHaveAttribute("data-message-id", (await own.getAttribute("data-id"))!)
      await expect(other!.page.getByRole("region", { name: "Pinned message", exact: true })).toHaveCount(0)
    })
    await test.step("Unpin from the original, then from the pinned copy", async () => {
      const own = first!.question(question)
      await own.hover()
      await own.getByRole("button", { name: "Unpin message", exact: true }).click()
      await expect(pinned).toHaveCount(0)
      await reply.hover()
      await reply.getByRole("button", { name: "Pin message", exact: true }).click()
      await expect(pinned).toHaveAttribute("data-message-id", id)
      await pinned.getByRole("button", { name: "Unpin message", exact: true }).click()
      await expect(pinned).toHaveCount(0)
      await expect(second!.page.getByRole("region", { name: "Pinned message", exact: true })).toHaveCount(0)
    })
  })
}

test.describe("Live message pin", () => {
  // Scope these needs to the live journey; the multi-person journeys above stay local-only.
  requires("personalModel", "member", "ownConversation", "liveModel")

  test("Pin message: a real reply stays on top while scrolling and stays unpinned after reload", {
    annotation: { type: "summary", description: "Pin a settled reply, scroll beneath it, then persist Unpin across a reload." },
  }, async ({ devices }) => {
    test.setTimeout(300_000)
    // devices.open installs recordActions and opens the signed-in account's own conversation on a deployment.
    const [a] = await devices.open("Message pin")
    const path = ownPlace()?.path ?? "/octocat/Spoon-Knife/tree/main"
    const branchReady = async () => {
      await expect(a.page.getByRole("navigation", { name: "Branch", exact: true })).toBeVisible({ timeout: 30_000 })
      await expect(a.page.getByRole("progressbar", { name: "Loading page" })).toHaveCount(0, { timeout: 60_000 })
    }
    await step("Open the branch conversation", async () => {
      if (new URL(a.page.url()).pathname !== path) await a.page.goto(path)
      await branchReady()
    })
    // Supply scrollable context even on an empty branch, independently of the model's wording or outcome.
    const question = `Pin check ${devices.word}: reply with exactly the word ok.\n\nContext for this scroll check, no action needed:\n${Array.from({ length: 40 }, (_, i) => `Context line ${i + 1}: checking a pinned reply while reading the conversation.`).join("\n")}`
    await step("Ask a real question", async () => {
      await a.askAndWaitTaken(question)
    })
    const { answerId } = a.asked.find(asked => asked.text === question)!
    const reply = a.conversation.locator(`[data-id="${answerId}"]`)
    const pinned = a.page.getByRole("region", { name: "Pinned message", exact: true })

    await step("Wait for the reply to finish or show its failure", async () => {
      // Admission precedes Electric delivery. Allow the real-model budget for mounting and settlement.
      await expect(reply).toHaveAttribute("data-state", /^(done|failed)$/, { timeout: 180_000 })
      await expect(reply).toHaveAttribute("data-role", "assistant")
      await reply.scrollIntoViewIfNeeded()
      await expect(reply.locator('[data-slot="message-response"]')).toHaveAttribute("data-streaming", "false")
      if (await reply.getAttribute("data-state") === "failed") {
        await expect(reply.getByText(COULDNT_ANSWER, { exact: true })).toBeVisible()
      }
    })
    await step("Pin the agent's reply from its message controls", async () => {
      const saved = a.page.waitForResponse(response => new URL(response.url()).pathname === "/api/message-pin" &&
        response.request().method() === "POST" && response.request().postDataJSON()?.messageId === answerId)
      await reply.hover()
      await reply.getByRole("button", { name: "Pin message", exact: true }).click()
      expect((await saved).status()).toBe(200)
      await expect(pinned).toHaveAttribute("data-message-id", answerId)
      await expect(pinned).toBeInViewport()
    })
    await step("Scroll the conversation beneath the pinned reply", async () => {
      const scroll = a.conversation.locator('[data-slot="message-scroller-viewport"]')
      const top = async () => {
        // The pin's column is inside the branch card's border.
        const [copy, column] = await Promise.all([pinned.boundingBox(), pinned.locator("..").boundingBox()])
        return Math.round(copy!.y - column!.y)
      }
      expect(await scroll.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true)
      const distance = await scroll.evaluate(node => node.scrollHeight)
      await expect.poll(top).toBe(0)
      // Wheel over the transcript, outside the pinned copy's own scrollport.
      await scroll.hover()
      await a.page.mouse.wheel(0, -distance)
      await expect.poll(() => scroll.evaluate(node => node.scrollTop)).toBe(0)
      await expect.poll(top).toBe(0)
      await expect(pinned).toBeInViewport()
      await a.page.mouse.wheel(0, distance)
      await expect.poll(() => scroll.evaluate(node => node.scrollTop)).toBeGreaterThan(0)
      await expect.poll(top).toBe(0)
      await expect(pinned).toHaveAttribute("data-message-id", answerId)
      await expect(pinned).toBeInViewport()
    })
    await step("Unpin the reply and save the change", async () => {
      const saved = a.page.waitForResponse(response => new URL(response.url()).pathname === "/api/message-pin" &&
        response.request().method() === "POST" && response.request().postDataJSON()?.messageId === null)
      await pinned.getByRole("button", { name: "Unpin message", exact: true }).click()
      // A disappearing optimistic copy alone is not a persistence receipt.
      const response = await saved
      expect(response.status()).toBe(200)
      expect(await response.json()).toMatchObject({ messageId: null })
      await expect(pinned).toHaveCount(0)
    })
    await step("Reload and see the reply is still unpinned", async () => {
      await a.page.reload()
      await branchReady()
      await expect(reply).toHaveAttribute("data-state", /^(done|failed)$/)
      await expect(pinned).toHaveCount(0)
      await reply.hover()
      await expect(reply.getByRole("button", { name: "Pin message", exact: true })).toHaveAttribute("aria-pressed", "false")
    })
  })
})
