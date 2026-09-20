import type { Locator, Page } from "@playwright/test"
import { scenario } from "./coverage/types"
import { awaitBoot, closeComposer, command, expect, openApp, test } from "./support"

const boot = async (page: Page): Promise<void> => {
  const startedAt = performance.now()
  await openApp(page)
  await awaitBoot(page, "navigate", startedAt)
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
}

const createNote = async (page: Page): Promise<{ card: Locator; id: string; title: string }> => {
  const before = await page.locator('.smithers-card[data-kind="world"]').count()
  await command(page, "/wiki.new-note")
  await closeComposer(page)
  await expect(page.locator('.smithers-card[data-kind="world"]')).toHaveCount(before + 1)
  const card = page.locator('.smithers-card[data-kind="world"]').last()
  await expect(card).toBeVisible()
  const testId = await card.getAttribute("data-testid")
  const id = (testId ?? "").replace(/^card-/, "")
  expect(id).toMatch(/^wiki-open-/)
  const title = ((await card.locator("h3").textContent()) ?? "").trim().replace(/^#\s*/, "")
  return { card: page.getByTestId(`card-${id}`), id, title }
}

test(
  "a card maximize and restore cycle preserves the selected card and focus",
  scenario("real-card-maximize-restore", {
    capabilities: [],
    coverage: ["host:local", "host:production", "door:button", "path:success", "action:wiki.new-note", "action:card.maximize", "action:card.minimize", "dimension:focus-restoration", "evidence:card-state"]
  }),
  async ({ page }) => {
    await boot(page)
    const note = await createNote(page)
    const maximize = note.card.getByRole("button", { name: "Maximize card", exact: true })
    await maximize.click()
    await expect(note.card).toHaveAttribute("data-maximized", "true")
    const restore = note.card.getByRole("button", { name: "Restore", exact: true })
    await expect(restore).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(note.card).toHaveAttribute("data-maximized", "false")
    await expect(note.card.getByRole("button", { name: "Maximize card", exact: true })).toBeFocused()
    await note.card.getByRole("button", { name: "Maximize card", exact: true }).click()
    await expect(note.card).toHaveAttribute("data-maximized", "true")
    await note.card.getByRole("button", { name: "Restore", exact: true }).click()
    await expect(note.card).toHaveAttribute("data-maximized", "false")
  }
)

test(
  "a maximized card can move to a tab session and close cleanly",
  scenario("real-card-tab-session-lifecycle", {
    capabilities: [],
    coverage: ["host:local", "host:production", "door:button", "path:success", "action:wiki.new-note", "action:card.maximize", "action:tab.card", "action:tab.select", "action:tab.close", "dimension:session-lifecycle", "evidence:tab-state"]
  }),
  async ({ page }) => {
    await boot(page)
    const note = await createNote(page)
    await note.card.getByRole("button", { name: "Maximize card", exact: true }).click()
    await expect(note.card.getByRole("button", { name: "Open in tab", exact: true })).toBeVisible()
    await note.card.getByRole("button", { name: "Open in tab", exact: true }).click()
    const body = page.getByTestId(`tab-body-card-${note.id}`)
    await expect(body).toBeVisible()
    await expect(body.getByTestId(`card-${note.id}`)).toBeVisible()
    await page.keyboard.press("Meta+w")
    await expect(page.getByTestId(`tab-body-card-${note.id}`)).toHaveCount(0)
  }
)
