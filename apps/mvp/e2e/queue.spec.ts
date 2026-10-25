import type { Page } from "@playwright/test"
import { expect, test } from "./devices"
import { requires, scriptedAgent } from "./target"

// The queue, end to end (decision 0022 slice 1, decision 0017 slice 1): a built-in plugin whose only wiring is its
// manifest (plugins/queue/plugin.json) and the public `PluginHost`. The agent asks three times; `g q` opens the queue;
// each wait fills the screen as its turn comes; the host's action strip answers it by key; the asking runs resume. The agent's
// model is scripted in the asking browser's engine worker (`/app?agent=queue`, src/test/scriptedAgent.ts); everything
// else is real: the plugin loader, the engine, ChatApi's runs routes, Postgres and Electric. It runs as local
// development's Maintainer, whom no other spec asks, so the queue holds only this test's waits.
requires("personalModel", "member", "ownConversation", "scriptedAgent", "devPeople")

const queue = (page: Page) => ({
  item: page.getByRole("article", { name: "Item" }),
  strip: page.getByRole("region", { name: "Actions" }),
  empty: page.getByText("Nothing needs you"),
})

/** Answers whatever an earlier, interrupted run of this test left waiting, so the queue starts empty. */
const drain = async (page: Page) => {
  const { item, strip } = queue(page)
  for (let left = 0; left < 20 && (await item.count()) > 0; left++) {
    const approval = (await item.getAttribute("data-kind")) === "approval"
    await page.keyboard.press(approval ? "a" : "1")
    await expect(strip).not.toHaveAttribute("data-sending", "true", { timeout: 15_000 })
  }
}

test("queue: the agent asks three times, and the person answers each from the queue by keyboard", {
  annotation: { type: "summary", description: "A plugin's full-screen queue answers what the agent asked, one key at a time." },
}, async ({ devices }) => {
  test.setTimeout(180_000)
  const word = devices.word
  const [a] = await devices.openAs("maintainer", "A")
  await a.page.goto(scriptedAgent("queue"))
  await a.ready()

  await test.step("Clear what an earlier run left", async () => {
    await a.page.keyboard.press("Escape")
    await a.page.keyboard.press("g")
    await a.page.keyboard.press("q")
    await expect(a.page).toHaveURL(/\/app\/queue$/)
    await expect(queue(a.page).item.or(queue(a.page).empty)).toBeVisible({ timeout: 15_000 })
    await drain(a.page)
    await expect(queue(a.page).empty).toBeVisible({ timeout: 15_000 })
    await a.page.getByRole("link", { name: "Back to chat" }).press("Enter")
    await expect(a.page).toHaveURL(/\/app$/)
  })

  // One conversation answers one question at a time: the second and third asks wait their turn, so each reaches the
  // queue once the one before it is answered.
  const asks = [`deploy ${word}-one`, `deploy ${word}-two`, `approve ${word}-three`]
  for (const ask of asks) await a.askAndWaitTaken(ask)
  await expect(a.answerTo(asks[0]!).locator('[data-slot="needs-you"]')).toBeVisible({ timeout: 30_000 })
  await expect(a.page.getByRole("button", { name: /^Queue/ }).getByLabel("1 waiting")).toBeVisible({ timeout: 15_000 })

  const { item, strip, empty } = queue(a.page)
  await test.step("g q opens the queue at the first", async () => {
    // Out of the composer first: in a field, a letter is typing.
    await a.page.keyboard.press("Escape")
    await a.page.keyboard.press("g")
    await a.page.keyboard.press("q")
    await expect(a.page).toHaveURL(/\/app\/queue$/)
    await expect(item).toContainText("1 of 1")
    await expect(item).toContainText(`${word}-one`)
    await expect(strip.getByRole("button", { name: /docs-v2/ })).toBeVisible()
  })

  await test.step("2 answers it from the strip; the next arrives", async () => {
    await a.page.keyboard.press("2")
    await expect(item).toContainText(`${word}-two`, { timeout: 30_000 })
  })

  await test.step("1 answers that one", async () => {
    await a.page.keyboard.press("1")
    await expect(item).toHaveAttribute("data-kind", "approval", { timeout: 30_000 })
    await expect(item).toContainText(`${word}-three`)
  })

  await test.step("A note rides with the approval; the queue is empty", async () => {
    await a.page.keyboard.press("i")
    await expect(strip.getByRole("textbox", { name: "Note" })).toBeFocused()
    await a.page.keyboard.type("ship it")
    await a.page.keyboard.press("Escape")
    await a.page.keyboard.press("a")
    await expect(empty).toBeVisible({ timeout: 15_000 })
  })

  await test.step("Every asking run went on with its answer", async () => {
    await a.page.getByRole("link", { name: "Back to chat" }).press("Enter")
    await a.expectAnswered(asks[0]!, "Deploying docs-v2.")
    await a.expectAnswered(asks[1]!, "Deploying main.")
    await a.expectAnswered(asks[2]!, "Approved: ship it")
  })
})
