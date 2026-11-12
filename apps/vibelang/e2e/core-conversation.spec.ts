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
  // 9 forged while the reply streams and 25 after it finishes, then the reply's end again; the client applies each
  // forged event in order and drops the repeat.
  await expect.poll(async () => (await read(page)).forged.home?.length).toBe(34)
  const last = (await read(page)).forged.home!.at(-1)!
  await expect.poll(async () => (await read(page)).client.conversation.seq).toBe(last)
  const snapshot = await read(page)
  const canonical = await page.evaluate(() => (window as unknown as { recovery: Recovery }).recovery.canonical())
  expect(snapshot.client.gap).toBe(false)
  expect(snapshot.client.pending).toEqual([])
  expect(snapshot.client.conversation.seq).toBe(canonical.seq + 34)
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
  // A pause and a settlement of no run before the first step, then three out-of-range steps and two out-of-range seeks after it.
  await expect.poll(async () => Object.entries((await read(page)).forged).find(([conversation]) => conversation.startsWith("tour-"))?.[1].length).toBe(7)
  await expect(bar).toHaveAttribute("data-step", "1")
  // The real events after the forged ones still apply: the tour moves on when asked.
  await page.getByRole("button", { name: "Skip", exact: true }).click()
  await expect(bar).toHaveAttribute("data-step", "2", { timeout: 15_000 })
})

test("a failed post stays to retry while a later post is answered", async ({ page }) => {
  // fault=refuse: the transport refuses only the first post (test/support/FaultyFactory.vibe).
  await page.goto("/e2e/runtime/index.html?fault=refuse")
  await page.getByRole("button", { name: "Ask the agent" }).click()
  const prompt = page.getByRole("textbox", { name: "Message" })
  await prompt.fill("install")
  await prompt.press("Enter")
  const pending = page.locator("[data-pending='true']")
  await expect(pending).toContainText("Send failed")
  await prompt.fill("What is a service?")
  await prompt.press("Enter")
  const answers = page.locator("[data-role='assistant'][data-done='true']")
  await expect(answers).toHaveCount(1, { timeout: 15_000 })
  // The answered post left `pending`; the failed one is still there, first in line to retry.
  await expect(pending).toHaveCount(1)
  await expect(pending).toContainText("install")
  const waiting = (await read(page)).client.pending
  expect(waiting).toHaveLength(1)
  expect(waiting[0]).toMatchObject({ text: "install" })
  expect(waiting[0]!.error).not.toBe("")
  await pending.getByRole("button", { name: "Retry" }).click()
  await expect(answers).toHaveCount(2, { timeout: 15_000 })
  await expect(pending).toHaveCount(0)
  const entries = (await read(page)).client.conversation.entries
  expect(entries.filter((entry) => entry.author === "person").map((entry) => entry.text)).toEqual(["What is a service?", "install"])
  expect(entries.filter((entry) => entry.author === "person").map((entry) => entry.clientId)).toContain(waiting[0]!.clientId)
})
