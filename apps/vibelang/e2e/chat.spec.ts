import { expect, type Page, test } from "@playwright/test"

/** Waits until no view transition runs, so a screenshot shows the page and not a transition's snapshot. */
async function settled(page: Page) {
  await page.waitForFunction(() => !document.documentElement.matches(":active-view-transition"))
}

// The first brick end to end, in a real browser: the splash, ⌘K, a question, the streamed answer, and back.
test.describe("splash and chat", () => {
  test("a visitor asks the agent from the splash and reads its answer", async ({ page }, testInfo) => {
    await page.goto("/")
    await expect(page.getByRole("heading", { name: "VibeLang" })).toBeVisible()
    // The wordmark whose text suits the theme, and a poster before the video plays (2026-11-07).
    const light = testInfo.project.name === "light"
    await expect(page.locator(".vl-top .vl-logo-on-light")).toBeVisible({ visible: light })
    await expect(page.locator(".vl-top .vl-logo-on-dark")).toBeVisible({ visible: !light })
    await expect(page.locator(".vl-media video")).toHaveAttribute("poster", "/media/contract-poster.jpg")
    await page.screenshot({ path: testInfo.outputPath("1-splash.png") })

    await page.keyboard.press("ControlOrMeta+k")
    const prompt = page.getByRole("dialog", { name: "Ask the agent" })
    await expect(prompt).toBeVisible()
    await expect(page.getByRole("textbox", { name: "Message" })).toBeFocused()
    await page.getByRole("textbox", { name: "Message" }).pressSequentially("How do I install it?")
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("How do I install it?")
    await page.screenshot({ path: testInfo.outputPath("2-prompt.png") })
    await page.keyboard.press("Enter")

    await expect(prompt).toBeHidden()
    await expect(page.getByRole("button", { name: "Expand the VibeLang home page" })).toBeVisible()
    await expect(page.locator(".sui-chat-message[data-role='user']")).toHaveText(/How do I install it\?/)
    const answer = page.locator(".sui-chat-message[data-role='assistant']")
    await expect(answer).toHaveAttribute("data-done", "true", { timeout: 15_000 })
    await expect(answer).toContainText("npm create vibelang@latest my-app")
    await settled(page)
    await page.screenshot({ path: testInfo.outputPath("3-chat.png") })

    // The docked composer stays inside the window on every screen (it overflowed on phones, 2026-11-07).
    const composer = await page.locator(".sui-chat-composer[data-docked]").boundingBox()
    expect(composer).not.toBeNull()
    expect(composer!.x).toBeGreaterThanOrEqual(0)
    expect(composer!.x + composer!.width).toBeLessThanOrEqual(page.viewportSize()!.width)

    await page.getByRole("button", { name: "Expand the VibeLang home page" }).click()
    await expect(page.getByRole("heading", { name: "VibeLang" })).toBeVisible()
    await page.getByRole("button", { name: "Chat" }).click()
    await expect(answer).toContainText("npm create vibelang@latest my-app")
  })

  test("the docked composer sends a follow-up, and Shift+Enter makes a new line", async ({ page }) => {
    await page.goto("/")
    await page.getByRole("button", { name: "Ask the agent" }).click()
    await expect(page.getByRole("textbox", { name: "Message" })).toBeFocused()
    await page.getByRole("textbox", { name: "Message" }).pressSequentially("What is a service?")
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("What is a service?")
    await page.keyboard.press("Enter")
    const answers = page.locator(".sui-chat-message[data-role='assistant'][data-done='true']")
    await expect(answers).toHaveCount(1, { timeout: 15_000 })
    const composer = page.getByRole("textbox", { name: "Message" })
    await composer.focus()
    await expect(composer).toBeFocused()
    await composer.pressSequentially("How do errors")
    await composer.press("Shift+Enter")
    await composer.pressSequentially("work?")
    await expect(composer).toHaveValue("How do errors\nwork?")
    await composer.press("Enter")
    await expect(answers).toHaveCount(2, { timeout: 15_000 })
    await expect(answers.nth(1)).toContainText("error UserNotFound")
  })

  test("Escape and the backdrop close the prompt without sending", async ({ page }) => {
    await page.goto("/")
    await page.keyboard.press("ControlOrMeta+k")
    await expect(page.getByRole("textbox", { name: "Message" })).toBeFocused()
    await page.getByRole("textbox", { name: "Message" }).pressSequentially("never sent")
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("never sent")
    await page.keyboard.press("Escape")
    await expect(page.getByRole("dialog", { name: "Ask the agent" })).toBeHidden()
    await page.getByRole("button", { name: "Ask the agent" }).click()
    await expect(page.getByRole("dialog", { name: "Ask the agent" })).toBeVisible()
    await expect(page.getByRole("textbox", { name: "Message" })).toBeFocused()
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("never sent")
    await page.locator(".vl-palette-scrim").click({ position: { x: 5, y: 5 } })
    await expect(page.getByRole("dialog", { name: "Ask the agent" })).toBeHidden()
    await expect(page.getByRole("heading", { name: "VibeLang" })).toBeVisible()
  })

  test("the deployment says which agent it runs", async ({ request }) => {
    test.skip(process.env.E2E_BASE_URL === undefined, "vite preview has no Worker; this runs against a deployment")
    const health = await request.get("/api/health")
    expect(await health.json()).toEqual({ ok: true, agent: "live" })
  })
})
