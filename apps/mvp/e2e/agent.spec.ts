import type { Page } from "@playwright/test"
import { THEME_ATTRIBUTE, THEME_MIRROR_KEY } from "../src/features/theme/contract"
import { attachToOpenConversation, browserModelRequests } from "./attach"
import { expect, test } from "./devices"
import { requires } from "./target"

const painted = (page: Page) => page.evaluate((attribute) => document.documentElement.getAttribute(attribute), THEME_ATTRIBUTE)

test("ask: an attached agent answers and the browser syncs the reply", async ({ devices }) => {
  requires("member", "ownConversation")
  const [a] = await devices.open("A")
  const calls = browserModelRequests(a.device.context)
  const agent = await attachToOpenConversation(a.page)
  const answer = `agent-${devices.word}`
  const question = `Reply with ${answer}`
  try {
    await a.askAndWaitTaken(question)
    await agent.respond(await a.idOf(question), answer)
    await a.expectAnswered(question, answer)
    expect(calls).toEqual([])
  } finally {
    await agent.revoke()
  }
})

test("theme by button: the theme button switches the mode, and the device keeps it across a reload", { annotation: [{ type: "theme", description: "light" }, { type: "summary", description: "The theme button switches light and dark, and the device keeps the choice after a reload." }] }, async ({ devices }) => {
  const [a] = await devices.open("A")
  const page = a.page
  const toDark = page.getByRole("button", { name: "Switch to dark mode" })
  const toLight = page.getByRole("button", { name: "Switch to light mode" })
  // The browser starts in light mode (Playwright's color scheme) with no preference on the device.
  await expect(toDark).toBeVisible({ timeout: 30_000 })

  await toDark.click()
  await expect.poll(() => painted(page)).toBe("dark")
  await expect(toLight).toBeVisible()
  expect(await page.evaluate((key) => localStorage.getItem(key), THEME_MIRROR_KEY)).toBe("dark")

  // The preference lives on the device: a reload paints it before the store opens, and the button agrees with the page
  // from the first frame, before the store has restored the row.
  await a.reload()
  await expect.poll(() => painted(page)).toBe("dark")
  await expect(toLight).toBeVisible()

  await toLight.click()
  await expect.poll(() => painted(page)).toBe("light")
  await expect(toDark).toBeVisible()
})

test("closed tab: an attached agent can answer while chat is closed", async ({ devices }) => {
  requires("member", "ownConversation")
  const [a] = await devices.open("A")
  const calls = browserModelRequests(a.device.context)
  const agent = await attachToOpenConversation(a.page)
  const question = `Answer while the tab is closed ${devices.word}`
  const answer = `answered-${devices.word}`
  try {
    await a.askAndWaitTaken(question)
    const id = await a.idOf(question)
    await a.close()
    await agent.respond(id, answer)
    const reopened = await devices.tab(a.device, "A again")
    await reopened.expectAnswered(question, answer)
    expect(calls).toEqual([])
  } finally {
    await agent.revoke()
  }
})
