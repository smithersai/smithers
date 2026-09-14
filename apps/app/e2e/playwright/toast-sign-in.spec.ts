import { expect, test } from "@playwright/test"

for (const path of ["/", "/smithersai/smithers/"]) {
  for (const trigger of ["click", "shortcut", "Tab and Enter"] as const) {
    test(`sign-in toast starts OAuth by ${trigger} on ${path}`, async ({ page }) => {
      await page.route("**/api/bootstrap", route => route.fulfill({ json: {
        apiVersion: 1, host: "cloud", version: "test", buildSha: "test",
        capabilities: ["identity", "cloud", "agent"], authFlow: "redirect", sandbox: null
      } }))
      await page.route("**/api/auth/session", route => route.fulfill({ json: { status: "signed-out" } }))
      await page.route("**/api/auth/github/start**", route => route.fulfill({ contentType: "text/html", body: "Sign-in started" }))
      await page.goto(path)
      await page.getByRole("button", { name: "Chat", exact: true }).click()
      const input = page.getByTestId("composer-input")
      await input.fill("/flow.list")
      await input.press("Enter")
      const stack = page.getByLabel("Notifications", { exact: true })
      const signIn = stack.getByRole("button", { name: "Sign in with GitHub", exact: true })
      await expect(signIn).toBeVisible()
      await expect(signIn).toHaveAttribute("aria-keyshortcuts", "Meta+Shift+G Control+Shift+G")
      if (trigger !== "click" && !(await input.isVisible())) await page.keyboard.press("Control+k")
      if (trigger === "click") await signIn.click()
      else if (trigger === "Tab and Enter") {
        await input.focus()
        for (let stop = 0; stop < 20 && !(await signIn.evaluate(button => button === document.activeElement)); stop++) {
          await page.keyboard.press("Tab")
        }
        await expect(signIn).toBeFocused()
        await page.keyboard.press("Enter")
      }
      else {
        await input.focus()
        await input.fill("still typing g")
        await expect(signIn).toBeVisible()
        await page.keyboard.press("Control+Shift+G")
      }
      await expect(page).toHaveURL(/\/api\/auth\/github\/start/)
      await expect(page.getByText("Sign-in started", { exact: true })).toBeVisible()
    })
  }
}
