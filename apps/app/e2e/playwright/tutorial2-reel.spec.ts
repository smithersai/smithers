import { expect, test } from "@playwright/test"
import { lessonMessage } from "../../src/mainview/onboarding/lessons"
import { FINISH_BUTTON, REEL_BUTTON, REPLAY_KEY } from "../../src/mainview/onboarding/reel.ts"

test.use({ contextOptions: { reducedMotion: "reduce" } })

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`terminal read, keyed pills and optional reel at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.route('**/api/bootstrap', route => route.fulfill({ json: {
      apiVersion: 1, host: 'cloud', version: 'test', buildSha: 'test', capabilities: ['identity', 'cloud'], authFlow: 'redirect', sandbox: null,
    } }))
    await page.route('**/api/auth/session', route => route.fulfill({ json: { status: 'signed-out' } }))
    await page.route('**/api/public/repos', route => route.fulfill({ json: { repos: [{ name: 'smithersai/smithers' }] } }))
    await page.route('**/api/repos/smithersai/smithers', route => route.fulfill({ json: { default_bookmark: 'main' } }))
    await page.goto("/smithersai/smithers/?tutorial")
    const shell = page.locator('.guide-shell')
    await expect(shell).toHaveAttribute('data-stage', '1')
    await expect(page.locator('.guide-app')).toHaveAttribute('data-repo', 'smithersai/smithers')
    await page.keyboard.press('q')
    await expect(shell).toHaveAttribute('data-stage', '10')
    await page.keyboard.press('x')
    await expect(shell).toHaveAttribute('data-stage', '13')
    await page.keyboard.press('c')
    await expect(page.getByTestId('composer-input')).toBeVisible()
    await expect(page.getByTestId('palette')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('palette')).toBeHidden()
    await expect(shell).toHaveAttribute('data-stage', '14')
    await expect(shell).toHaveAttribute('data-conversation-open', 'false')
    await expect(page.getByTestId('composer-input')).toBeHidden()
    await expect(page.locator(".guide-app")).toHaveAttribute("data-repo", "smithersai/smithers")
    const terminal = page.locator('[data-message-step="14"]')
    await expect(terminal).toBeInViewport()
    await expect(terminal.locator('[data-line="1"]')).toHaveText(lessonMessage(14, { declined: ['login'] }))
    await expect(page.locator('.guide-location')).toBeVisible()
    await expect(page.locator('.guide-location')).toHaveText('Your workspace')
    const finish = page.getByRole('button', { name: FINISH_BUTTON.label, exact: true })
    const more = page.getByRole('button', { name: REEL_BUTTON.label, exact: true })
    for (const [button, key] of [[finish, FINISH_BUTTON.key], [more, REEL_BUTTON.key]] as const) {
      await expect(button).toHaveAttribute('aria-keyshortcuts', key)
      if (viewport.width <= 640) await expect(button.locator('kbd')).toBeHidden()
      else await expect(button.locator('kbd')).toBeVisible()
      await expect(button.locator('kbd')).toHaveText(key)
      expect(await button.evaluate(node => !!node.closest('.guide-actions'))).toBe(true)
      const bounds = (await button.boundingBox())!
      expect(bounds.height).toBeLessThan(70)
      const workspace = (await page.locator('.guide-app').boundingBox())!
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(workspace.y)
    }
    await finish.focus()
    await page.keyboard.press('Tab')
    await expect(more).toBeFocused()
    const originalTheme = await shell.getAttribute('data-theme')
    await page.keyboard.press(REEL_BUTTON.key)
    await expect(page.locator('[data-reel-stage="0"]')).toBeVisible()
    await expect(shell).toHaveAttribute('data-theme', originalTheme === 'dark' ? 'light' : 'dark')
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('[data-reel-stage="1"]')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-reel-stage]')).toHaveCount(0)
    await expect(more).toBeFocused()
    await expect(shell).toHaveAttribute('data-theme', originalTheme!)
    await page.screenshot({ path: test.info().outputPath(`terminal-${viewport.width}.png`) })
    await page.keyboard.press(REPLAY_KEY)
    await expect(shell).toHaveAttribute('data-stage', '1')
    await page.keyboard.press('q')
    await expect(shell).toHaveAttribute('data-stage', '10')
    await page.keyboard.press('x')
    await expect(shell).toHaveAttribute('data-stage', '13')
    await page.keyboard.press('c')
    await expect(page.getByTestId('composer-input')).toBeVisible()
    await expect(page.getByTestId('palette')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('palette')).toBeHidden()
    await expect(shell).toHaveAttribute('data-stage', '14')
    await expect(shell).toHaveAttribute('data-conversation-open', 'false')
    await expect(page.getByTestId('composer-input')).toBeHidden()
    await page.keyboard.press(FINISH_BUTTON.key)
    await expect(shell).toHaveCount(0)
  })
}


test.describe("capacity refusal handoff", () => {
  test.use({ timezoneId: "America/Los_Angeles" })
  test("Finish leaves a limited practice run behind and opens the repository Home", async ({ page }) => {
    await page.route("**/api/**", route => route.fulfill({ status: 404, json: {} }))
    await page.route("**/api/bootstrap", route => route.fulfill({ json: {
      apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["identity", "cloud"], authFlow: "redirect", sandbox: null,
    } }))
    await page.route("**/api/auth/session", route => route.fulfill({ json: { status: "signed-out" } }))
    await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [{ name: "smithersai/smithers" }] } }))
    await page.route("**/api/repos/smithersai/smithers", route => route.fulfill({ json: { default_bookmark: "main" } }))
    await page.route("**/contents/.smithers/home.json", route => route.fulfill({ json: { content: JSON.stringify({ blocks: [{ type: "text", text: "Repository home" }] }) } }))
    await page.route("**/api/tutorial/live/research", route => route.fulfill({ status: 429, json: { code: "turn_rate_limited", retryAt: "2030-01-02T00:00:00Z" } }))
    await page.goto("/smithersai/smithers/?tutorial")
    const shell = page.locator(".guide-shell")
    for (const [step, key] of [[1, "i"], [2, "r"], [3, "e"], [4, "r"]] as const) {
      await expect(shell).toHaveAttribute("data-stage", String(step))
      await page.keyboard.press(key)
    }
    const run = page.locator('.guide-transcript [data-testid="card-live-tutorial-research"]')
    await expect(run).toContainText("4:00 PM PST")
    await expect(run).toContainText("nothing was charged")
    await expect(run).not.toContainText(/FAILED/i)
    const skip = run.getByRole("button", { name: "Continue without practice", exact: true })
    await expect(skip).toHaveClass(/guide-button/)
    await skip.click()
    await expect(shell).toHaveAttribute("data-stage", "10")
    await page.keyboard.press("x")
    await expect(shell).toHaveAttribute("data-stage", "13")
    await page.keyboard.press("f")
    await expect(shell).toHaveCount(0)
    const first = page.getByTestId("transcript").locator(".smithers-card").first()
    await expect(first).toHaveAttribute("data-kind", "repo-home")
    await expect(first).toContainText("Home · smithersai/smithers")
    await expect(first).toBeInViewport()
    await expect(page.getByTestId("card-live-tutorial-research")).toHaveCount(0)
    await expect(page.getByTestId("card-practice-issue-flows-3")).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Continue without practice", exact: true })).toHaveCount(0)
  })
})


/*
 * R2-T3-4 / R2-T2-3 / R2-T3-5 / R2-T10-2: what Finish must leave behind, and
 * what it must not. The reel's demo notification outlived the shell and hung
 * clipped under the app header with no dismiss control; and the only door
 * back into the tutorial was a flow name typed into chat.
 */
test("Finish clears the tutorial's own notification and leaves two doors back in", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.route('**/api/bootstrap', route => route.fulfill({ json: {
    apiVersion: 1, host: 'cloud', version: 'test', buildSha: 'test', capabilities: ['identity', 'cloud'], authFlow: 'redirect', sandbox: null,
  } }))
  await page.route('**/api/auth/session', route => route.fulfill({ json: { status: 'signed-out' } }))
  await page.route('**/api/public/repos', route => route.fulfill({ json: { repos: [{ name: 'smithersai/smithers' }] } }))
  await page.route('**/api/repos/smithersai/smithers', route => route.fulfill({ json: { default_bookmark: 'main' } }))
  // Finish prepares the destination before the shell leaves, and that includes this read.
  await page.route('**/contents/.smithers/home.json', route => route.fulfill({ json: {
    content: JSON.stringify({ blocks: [{ type: "text", text: "Repository home" }] }),
  } }))
  const shell = page.locator('.guide-shell')
  const replay = page.getByRole("button", { name: "Replay introduction", exact: true })
  /** Beat 1 to the handoff beat, by the two escape hatches the reel test walks. */
  const walkToHandoff = async () => {
    await expect(shell).toHaveAttribute('data-stage', '1')
    await page.keyboard.press('q')
    await expect(shell).toHaveAttribute('data-stage', '10')
    await page.keyboard.press('x')
    await expect(shell).toHaveAttribute('data-stage', '13')
    await page.keyboard.press('c')
    await expect(page.getByTestId('palette')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(shell).toHaveAttribute('data-stage', '14')
  }

  await page.goto("/smithersai/smithers/?tutorial")
  await walkToHandoff()
  // The reel's second example sends the demo notification (reel.ts REEL_STAGES).
  await page.keyboard.press(REEL_BUTTON.key)
  await expect(page.locator('[data-reel-stage="0"]')).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('[data-reel-stage="1"]')).toBeVisible()
  const notification = page.getByText("This is a tutorial notification.", { exact: true })
  await expect(notification).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(shell).toHaveAttribute('data-stage', '14')

  await page.keyboard.press(FINISH_BUTTON.key)
  await expect(shell).toHaveCount(0)
  await expect(page).toHaveURL(/\/smithersai\/smithers\/$/)
  await expect(notification).toHaveCount(0)

  // The footer remains available, and the explicit deep link starts again.
  await expect(replay).toBeVisible()
  await page.goto("/smithersai/smithers/?tutorial")
  await expect(shell).toHaveAttribute("data-stage", "1")
  await walkToHandoff()
  await page.keyboard.press(FINISH_BUTTON.key)
  await expect(shell).toHaveCount(0)
  await expect(page).toHaveURL(/\/smithersai\/smithers\/$/)

  // The door survives a reload of the repository route it finished on.
  await page.goto("/smithersai/smithers/")
  await expect(replay).toBeVisible()
  await expect(shell).toHaveCount(0)

  // The repository route mounts the guide from the footer's keyboard door.
  await replay.focus()
  await page.keyboard.press("Enter")
  await expect(shell).toHaveAttribute("data-stage", "1")
})
