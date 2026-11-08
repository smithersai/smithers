// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
import { expect, type Page, test } from "@playwright/test"

// Will, 2026-11-08: "I don't see any in app button to switch into mocked mode to use the entire app and every feature I
// asked for." Ruling VL-13: the whole app works in mock mode, with no backend, no model and no sign-in. This test starts
// as a visitor with nothing saved, switches to Mock with the top bar's switch, and uses every feature there. Against a
// deployment it starts live; on a local build (no API Worker) the page is already mock, and the switch still shows it.
test.use({ storageState: { cookies: [], origins: [] } })

const modeSwitch = (page: Page) => page.locator(".vl-top .vl-mode")
const assistant = (page: Page) => page.locator(".sui-chat-message[data-role='assistant']")

async function ask(page: Page, words: string) {
  await page.getByRole("button", { name: "Ask the agent", exact: true }).click()
  const box = page.getByRole("dialog").getByRole("textbox", { name: "Message" })
  await box.fill(words)
  await page.getByRole("dialog").getByRole("button", { name: "Send", exact: true }).click()
  await expect(assistant(page).last()).toHaveAttribute("data-done", "true", { timeout: 20_000 })
}

test("the top bar switches to Mock, the choice persists, and every feature works there", async ({ page }) => {
  test.setTimeout(180_000)
  await page.goto("/?agent=live")
  await expect(modeSwitch(page)).toBeVisible({ timeout: 15_000 })
  const startedLive = (await modeSwitch(page).textContent()) === "Live"
  if (startedLive) await modeSwitch(page).click()
  await expect(modeSwitch(page)).toHaveText("Mock")
  await expect(modeSwitch(page)).toHaveAttribute("data-mode", "mock")

  // The choice survives a reload with no query, signed out.
  await page.goto("/")
  await expect(modeSwitch(page)).toHaveText("Mock")

  // Chat: the mock agent answers.
  await ask(page, "What is VibeLang?")
  await expect(assistant(page).last()).not.toBeEmpty()

  // The five roles, from the picker.
  const picker = page.getByRole("combobox", { name: "Visit as" })
  for (const role of ["viewer", "new", "community", "contributor", "maintainer"]) {
    await picker.selectOption(role)
    if (role === "viewer") await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible()
    else await expect(page.locator(".vl-nav-role")).toHaveText(role[0]!.toUpperCase() + role.slice(1))
  }

  // Wiki.
  await page.getByRole("button", { name: "Wiki", exact: true }).click()
  await expect(page.getByRole("region", { name: "Wiki", exact: true }).getByRole("heading", { name: "VibeLang factory wiki" })).toBeVisible()

  // Issues, tasks and VIPs.
  await page.goto("/")
  await page.getByRole("button", { name: "Issues", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Issues", exact: true })).toBeVisible()
  await page.getByRole("link", { name: "Case branches on tuples", exact: true }).click()
  await expect(page.getByRole("link", { name: /#49/ })).toBeVisible()

  // Both acceptance gates. Agent review is separate from the maintainer's proposal approval.
  await page.getByRole("link", { name: "‹ Issues" }).click()
  await picker.selectOption("maintainer")
  await page.getByRole("link", { name: "Pattern matching in case", exact: true }).click()
  await page.getByRole("button", { name: "Accept", exact: true }).click()
  await expect(page.getByRole("region", { name: "Proposal gate" })).toContainText("will")
  await page.getByRole("link", { name: "‹ Issues" }).click()
  await page.getByRole("button", { name: "Specification", exact: true }).click()
  await expect(page.getByRole("status", { name: "Specification gate" })).toHaveText("Accepted")
  await page.getByRole("textbox", { name: "Specification text" }).fill("A new mock specification revision.")
  await page.getByRole("button", { name: "Save revision" }).click()
  await expect(page.getByRole("status", { name: "Specification gate" })).toHaveText("In review")
  for (const reviewer of ["Codex Astra", "Codex Sol", "Claude Fable", "Claude Opus"]) {
    await page.getByRole("row", { name: new RegExp(reviewer) }).getByRole("button", { name: "Request review" }).click()
    await expect(page.getByRole("row", { name: new RegExp(reviewer) })).toContainText("LGTM")
  }
  await expect(page.getByRole("status", { name: "Specification gate" })).toHaveText("In review")
  await page.getByRole("row", { name: /Claude Opus/ }).getByRole("button", { name: "Request review" }).click()
  await expect(page.getByRole("status", { name: "Specification gate" })).toHaveText("Accepted")

  // Actions, and the slash menu, which also lists switching back to live.
  await page.goto("/")
  await ask(page, "Hello")
  await page.getByRole("button", { name: "Expand Actions", exact: true }).click()
  await expect(page.getByRole("region", { name: "Actions", exact: true }).getByRole("button", { name: "Tour", exact: true })).toBeVisible()
  await page.keyboard.press("Escape")
  await page.keyboard.press("ControlOrMeta+k")
  const prompt = page.getByRole("dialog").getByRole("textbox", { name: "Message" })
  await prompt.pressSequentially("/")
  const menu = page.getByRole("listbox", { name: "Commands" })
  await expect(menu.getByRole("option", { name: /^\/live/ })).toBeVisible()
  await expect(menu.getByRole("option")).not.toHaveCount(1)
  await prompt.fill("")
  await page.keyboard.press("Escape")

  // Sandboxes with minutes, as a contributor.
  await page.goto("/")
  await page.getByRole("combobox", { name: "Visit as" }).selectOption("contributor")
  await ask(page, "hello")
  await page.getByRole("button", { name: "Sandboxes", exact: true }).click()
  await page.getByRole("button", { name: "New sandbox" }).click()
  await expect(page.getByRole("status", { name: "Sandbox" })).toHaveText("Running")
  const command = page.getByRole("textbox", { name: "Terminal command" })
  await command.fill("echo mock")
  await command.press("Enter")
  await page.getByRole("button", { name: "Stop", exact: true }).click()
  await expect(page.getByRole("status", { name: "Sandbox" })).toHaveText("Stopped")

  // The tour: Learn more, the glow, the docs, and Esc.
  await page.goto("/")
  await page.getByRole("button", { name: "Learn more", exact: true }).click()
  await expect(page.locator(".vl-glow")).toBeVisible()
  await expect(page.getByTitle("VibeLang docs")).toBeVisible({ timeout: 15_000 })
  await page.getByRole("button", { name: "Esc", exact: true }).click()
  await expect(page.locator(".vl-glow")).toBeHidden()

  // The mythical history, in mock mode too.
  await page.goto("/history")
  await expect(modeSwitch(page)).toHaveText("Mock")
  await expect(page.getByRole("button", { name: /The compiler/ })).toBeVisible({ timeout: 20_000 })

  // ⌘K's /live switches back on a deployment; locally there is no live agent to switch to.
  if (startedLive) {
    await page.goto("/")
    await page.keyboard.press("ControlOrMeta+k")
    await page.getByRole("dialog").getByRole("textbox", { name: "Message" }).fill("/live")
    await page.keyboard.press("Enter")
    await expect(modeSwitch(page)).toHaveText("Live", { timeout: 15_000 })
    await page.goto("/")
    await expect(modeSwitch(page)).toHaveText("Live")
  }
})

test("health says which commit is deployed", async ({ request, baseURL }) => {
  test.skip(!process.env.E2E_BASE_URL, "only a deployment has the API Worker")
  const health = await (await request.get(new URL("/api/health", baseURL).toString())).json() as { agent: string; commit?: string }
  expect(health.agent).toBe("live")
  expect(health.commit).toMatch(/^[0-9a-f]{7,40}$/)
})
