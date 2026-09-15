import type { Page } from "@playwright/test"
import { scenario } from "./coverage/types"
import { closeComposer, command, expect, openApp, test } from "./support"

test.setTimeout(90_000)

const boot = async (page: Page): Promise<void> => {
  await openApp(page)
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
}

const makeNote = async (page: Page, marker: string): Promise<{ readonly id: string; readonly title: string }> => {
  await command(page, "/world.new-note")
  await closeComposer(page)
  const card = page.locator('.smithers-card[data-kind="world"]').last()
  await expect(card).toBeVisible()
  const raw = await card.getAttribute("data-testid")
  expect(raw).toMatch(/^card-wiki-open-/)
  const id = raw!.replace(/^card-wiki-open-/, "")
  const title = ((await card.locator("h3").textContent()) ?? "").replace(/^#\s*/, "").trim()
  await command(page, `/wiki.edit ${id} ${JSON.stringify(`# ${title}\n\n${marker}`)}`)
  await closeComposer(page)
  return { id, title }
}

test(
  "legacy World aliases create, select, and delete a real Wiki note with durable cancel",
  scenario("wiki.world-alias-lifecycle", {
    capabilities: [],
    coverage: [
      "action:world", "action:world.new-note", "action:world.select", "action:world.delete",
      "action:world.delete.cancel", "action:world.delete.confirm", "action:wiki.edit", "action:wiki.open",
      "host:local", "host:production", "path:success", "path:persistence", "path:keyboard",
      "door:slash", "door:button", "door:user-only", "dimension:keyboard", "dimension:legacy-alias", "dimension:confirmation-boundary",
      "evidence:document-readback-after-reload"
    ],
    description: "Exercises the persisted World compatibility aliases through the actual Wiki surface and proves cancellation leaves the document available after reload."
  }),
  async ({ page }) => {
    await boot(page)
    await command(page, "/world")
    await closeComposer(page)
    await expect(page.getByRole("region", { name: "Smithers Wiki state" })).toBeVisible()
    const note = await makeNote(page, `world-alias-${Date.now()}`)

    await command(page, `/world.select ${note.id}`)
    await closeComposer(page)
    await expect(page.locator('.smithers-card[data-kind="world"]').last()).toContainText(note.title)
    await command(page, `/world.delete ${note.id}`)
    await closeComposer(page)
    const dialog = page.getByRole("dialog", { name: `Delete ${note.title}?`, exact: true })
    await expect(dialog).toBeVisible()
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
    await expect(dialog).toBeHidden()
    await page.reload()
    await command(page, `/wiki.open ${note.title}`)
    await closeComposer(page)
    await expect(page.locator('.smithers-card[data-kind="world"]').last()).toContainText(note.title)

    await command(page, `/world.delete ${note.id}`)
    await closeComposer(page)
    await expect(page.getByRole("dialog", { name: `Delete ${note.title}?`, exact: true })).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.getByRole("dialog", { name: `Delete ${note.title}?`, exact: true })).toBeHidden()
  }
)

test(
  "onboarding finish and optional reel are real keyboard state transitions",
  scenario("onboarding.finish-reel-persistence", {
    capabilities: [],
    coverage: [
      "action:onboarding.act", "action:tut", "action:tut.more", "action:chat.open", "action:input.mode",
      "host:local", "host:production", "path:success", "path:persistence", "path:keyboard",
      "door:slash", "door:button", "door:user-only", "dimension:keyboard", "dimension:tutorial-finish", "dimension:optional-reel",
      "dimension:replay-and-dismiss", "evidence:guide-stage-and-reel-state"
    ],
    description: "Uses the real bundled onboarding state, finishes it through its user-facing action, opens the optional capability reel, advances by keyboard, and verifies the finished state survives reload."
  }),
  async ({ page }) => {
    await page.goto("/")
    const guide = page.locator(".guide-shell")
    await expect(guide).toBeVisible()
    await page.keyboard.press("q")
    await expect(guide).toHaveAttribute("data-stage", "10")
    await command(page, "/onboarding.act finish")
    await closeComposer(page)
    await expect(guide).toHaveAttribute("data-stage", "14")
    await command(page, "/tut.more")
    await closeComposer(page)
    const reel = page.getByRole("region", { name: "What else Smithers can do" })
    await expect(reel).toBeVisible()
    await expect(reel).toHaveAttribute("data-reel-stage", "0")
    await page.keyboard.press("ArrowRight")
    await expect(reel).toHaveAttribute("data-reel-stage", "1")
    await page.keyboard.press("Escape")
    await expect(reel).toBeHidden()
    await page.reload()
    await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "14")
    await command(page, "/tut")
    await closeComposer(page)
    await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "1")
    await page.keyboard.press("q")
    await command(page, "/onboarding.act finish")
    await closeComposer(page)
    await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "14")
  }
)
