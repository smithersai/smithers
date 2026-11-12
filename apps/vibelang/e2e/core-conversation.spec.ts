// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
// A backend that breaks the conversation's rules (fault=forged, test/support/forgedEvents.vibe): every forged event takes
// the next sequence number, so the page applies it, and the conversation machine must leave the conversation as it was.
import { expect, test } from "./coverage"
import type { Page } from "./coverage"
import type { Client, Conversation } from "../src/core/conversation.vibe"

interface Recovery {
  snapshot: () => { client: Client; delivered: number[]; forged: Record<string, number[]> }
  canonical: () => Promise<Conversation>
}

test.use({ baseURL: `http://127.0.0.1:${process.env.E2E_PORT ?? process.env.E2E_4510 ?? process.env.E2E_4508 ?? process.env.E2E_4505 ?? process.env.E2E_4501 ?? process.env.E2E_4516 ?? process.env.E2E_4511 ?? process.env.E2E_4502 ?? 4173}` })

const read = (page: Page) => page.evaluate(() => (window as unknown as { recovery: Recovery }).recovery.snapshot())

test("rule-breaking events in a reply change nothing the page shows", async ({ page }) => {
  await page.goto("/e2e/runtime/index.html?fault=forged")
  await page.keyboard.press("ControlOrMeta+k")
  const prompt = page.getByRole("textbox", { name: "Message" })
  await expect(prompt).toBeFocused()
  await prompt.pressSequentially("What is a service?")
  await prompt.press("Enter")
  const answers = page.locator(".sui-chat-message[data-role='assistant']")
  await expect(answers).toHaveAttribute("data-done", "true", { timeout: 15_000 })
  // 8 forged while the reply streams and 25 after it finishes; the client applies each one in order.
  await expect.poll(async () => (await read(page)).forged.home?.length).toBe(33)
  const last = (await read(page)).forged.home!.at(-1)!
  await expect.poll(async () => (await read(page)).client.conversation.seq).toBe(last)
  const snapshot = await read(page)
  const canonical = await page.evaluate(() => (window as unknown as { recovery: Recovery }).recovery.canonical())
  expect(snapshot.client.gap).toBe(false)
  expect(snapshot.client.pending).toEqual([])
  expect(snapshot.client.conversation.seq).toBe(canonical.seq + 33)
  const { seq: _seen, runs: seenRuns, ...seen } = snapshot.client.conversation
  const { seq: _real, runs: realRuns, ...real } = canonical
  expect(seen).toEqual(real)
  // A step or settlement of a run nobody requested leaves the conversation with no runs.
  expect(seenRuns ?? []).toEqual(realRuns ?? [])
  await expect(answers).toHaveCount(1)
  await expect(page.locator(".sui-chat-message[data-role='user']")).toHaveCount(1)
  await expect(page.getByText("forged")).toHaveCount(0)
  await expect(page.getByText("Forger")).toHaveCount(0)
})

test("rule-breaking walkthrough events leave the tour on its real step", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("vibelang:toured", "yes")
    localStorage.setItem("vibelang:tour-sound", "off")
  })
  await page.goto("/e2e/runtime/index.html?fault=forged")
  await page.getByRole("button", { name: "Learn more", exact: true }).click()
  const bar = page.getByRole("region", { name: "Walkthrough" })
  await expect(bar).toHaveAttribute("data-step", "1", { timeout: 15_000 })
  // A pause before the first step, then three out-of-range steps and two out-of-range seeks after it.
  await expect.poll(async () => Object.entries((await read(page)).forged).find(([conversation]) => conversation.startsWith("tour-"))?.[1].length).toBe(6)
  await expect(bar).toHaveAttribute("data-step", "1")
  // The real events after the forged ones still apply: the tour moves on when asked.
  await page.getByRole("button", { name: "Skip", exact: true }).click()
  await expect(bar).toHaveAttribute("data-step", "2", { timeout: 15_000 })
})
