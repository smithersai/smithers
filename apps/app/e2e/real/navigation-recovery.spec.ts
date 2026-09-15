import type { Locator, Page } from "@playwright/test"
import { scenario } from "./coverage/types"
import { closeComposer, command, expect, openApp, test } from "./support"

const boot = async (page: Page): Promise<void> => {
  await openApp(page)
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
}

const createNote = async (page: Page): Promise<{ card: Locator; id: string; title: string }> => {
  await command(page, "/wiki.new-note")
  await closeComposer(page)
  const card = page.locator('.smithers-card[data-kind="world"]').last()
  await expect(card).toBeVisible()
  const testId = await card.getAttribute("data-testid")
  const id = (testId ?? "").replace(/^card-/, "")
  expect(id).toMatch(/^wiki-open-/)
  const title = ((await card.locator("h3").textContent()) ?? "").trim().replace(/^#\s*/, "")
  return { card: page.getByTestId(`card-${id}`), id, title }
}

test(
  "sidebar opens from the logo and remains open across a real reload",
  scenario("real-sidebar-reload-recovery", {
    capabilities: [],
    coverage: ["host:local", "host:production", "door:button", "path:persistence", "action:sidebar.toggle", "dimension:reload-recovery", "evidence:sidebar-state"]
  }),
  async ({ page }) => {
    await boot(page)
    const logo = page.getByRole("button", { name: "Smithers", exact: true })
    await expect(logo).toHaveAttribute("aria-expanded", "false")
    await logo.click()
    await expect(logo).toHaveAttribute("aria-expanded", "true")
    await expect(page.getByRole("complementary", { name: "Sessions and chrome" })).toBeVisible()
    await page.reload()
    const reloadedLogo = page.getByRole("button", { name: "Smithers", exact: true })
    await expect(reloadedLogo).toHaveAttribute("aria-expanded", "true")
    await expect(page.getByRole("complementary", { name: "Sessions and chrome" })).toBeVisible()
    await reloadedLogo.click()
    await expect(reloadedLogo).toHaveAttribute("aria-expanded", "false")
  }
)

test(
  "tutorial focus boundaries keep the global W shortcut from stealing input",
  scenario("real-sidebar-keyboard-boundary", {
    capabilities: [],
    coverage: ["host:local", "host:production", "door:user-only", "path:success", "action:sidebar.toggle", "action:palette.open", "dimension:focus-boundary", "evidence:keyboard-navigation"]
  }),
  async ({ page }) => {
    await boot(page)
    const logo = page.getByRole("button", { name: "Smithers", exact: true })
    // The tutorial owns the keyboard surface while it is active. A global
    // navigation shortcut must not steal that surface or mutate its state.
    await page.keyboard.press("w")
    await expect(logo).toHaveAttribute("aria-expanded", "false")
    await page.keyboard.press("ControlOrMeta+k")
    const input = page.getByTestId("composer-input")
    await expect(input).toBeVisible()
    await input.fill("w")
    await expect(logo).toHaveAttribute("aria-expanded", "false")
    await closeComposer(page)
  }
)

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
    await note.card.locator(".card-maximize-backdrop").click({ position: { x: 3, y: 3 } })
    await expect(note.card).toHaveAttribute("data-maximized", "false")
  }
)

test(
  "a maximized card can move to a sidebar session and close cleanly",
  scenario("real-card-sidebar-session-lifecycle", {
    capabilities: [],
    coverage: ["host:local", "host:production", "door:button", "path:success", "action:wiki.new-note", "action:card.maximize", "action:tab.card", "action:tab.select", "action:tab.close", "dimension:session-lifecycle", "evidence:tab-state"]
  }),
  async ({ page }) => {
    await boot(page)
    const note = await createNote(page)
    await note.card.getByRole("button", { name: "Maximize card", exact: true }).click()
    await expect(note.card.getByRole("button", { name: "Open in sidebar", exact: true })).toBeVisible()
    await note.card.getByRole("button", { name: "Open in sidebar", exact: true }).click()
    const sidebar = page.getByRole("complementary", { name: "Sessions and chrome" })
    await expect(sidebar).toBeVisible()
    const tab = sidebar.getByRole("tab", { name: note.title, exact: true })
    await expect(tab).toBeVisible()
    await tab.click()
    await expect(page.getByTestId(`card-${note.id}`)).toBeVisible()
    await sidebar.getByRole("button", { name: `Close ${note.title}`, exact: true }).click()
    await expect(sidebar.getByRole("tab", { name: note.title, exact: true })).toHaveCount(0)
  }
)
