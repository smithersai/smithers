import { expect, test, type Page } from "@playwright/test"

const input = (page: Page) => page.getByRole("textbox", { name: "Message" })
const answers = (page: Page) => page.locator(".sui-chat-message[data-role='assistant']")

async function open(page: Page) {
  await page.keyboard.press("ControlOrMeta+k")
  await expect(page.getByRole("dialog", { name: "Ask the agent" }).getByRole("textbox", { name: "Message" })).toBeFocused()
}
async function type(page: Page, value: string) {
  await expect(input(page)).toBeFocused()
  await input(page).pressSequentially(value)
  await expect(input(page)).toHaveValue(value)
}

test("9: the named transcript log stays quiet during streaming and announces the completed answer politely", async ({ page }) => {
  await page.goto("/")
  await open(page)
  await type(page, "What is a service?")
  await input(page).press("Enter")
  const log = page.getByRole("log", { name: "Conversation" })
  await expect(log).toBeVisible()
  await expect(log).toHaveAttribute("aria-live", "off")
  const announcement = page.getByRole("status", { name: "Answer" })
  await expect(answers(page).last()).toHaveAttribute("data-done", "false")
  await expect(answers(page).last().locator(".sui-chat-bubble")).not.toBeEmpty()
  await expect(announcement).toBeEmpty()
  await expect(answers(page).last()).toHaveAttribute("data-done", "true", { timeout: 15_000 })
  await expect(announcement).toContainText("service")
  const cdp = await page.context().newCDPSession(page)
  const { nodes } = await cdp.send("Accessibility.getFullAXTree")
  expect(nodes.some(node => node.role?.value === "log" && node.name?.value === "Conversation")).toBe(true)
  const answer = nodes.find(node => node.role?.value === "status" && node.name?.value === "Answer")!
  expect(answer.properties).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "live", value: expect.objectContaining({ value: "polite" }) }),
    expect.objectContaining({ name: "atomic", value: expect.objectContaining({ value: true }) }),
  ]))
  const completed = await announcement.textContent()
  await input(page).focus()
  await type(page, "What is a service?")
  await input(page).press("Enter")
  await expect(answers(page)).toHaveCount(2)
  await expect(answers(page).last()).toHaveAttribute("data-done", "false")
  await expect(announcement).toHaveText(completed!)
})
