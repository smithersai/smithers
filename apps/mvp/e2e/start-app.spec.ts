import { faultyApp, faults } from "./faults"
import { expect, OFFLINE, test } from "./fixtures"
import { requires, signedOut } from "./target"

// A first-time visitor has no session: in a deployment every page otherwise starts signed in as the test account
// (e2e/target.ts). Locally a page has no stored session either way.
test.use(signedOut)

test("landing: a first-time visitor sees the landing and clicks Get started for free", { annotation: { type: "summary", description: "A first-time visitor sees the landing page and starts with Get started for free." } }, async ({ page }) => {
  await page.goto("/")
  // A dev server's first page compiles the app's modules as it loads, which takes seconds.
  await expect(page.getByRole("heading", { name: "Smithers" })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText("Automate maintaining your codebase")).toBeVisible()
  await expect(page.getByRole("link", { name: "GitHub" })).toHaveAttribute("href", "https://github.com/smithersai/smithers")

  await page.getByRole("link", { name: "Get started for free" }).click()

  await expect(page).toHaveURL(/\/app$/)
  await expect(page.getByRole("main", { name: "App" })).toBeVisible()

  await page.goBack()
  await expect(page.getByRole("link", { name: "Get started for free" })).toBeVisible()
})

// The sync service is unreachable when the app opens: every shape request fails on the network, as when Electric or
// the network to it is down. The app opens at once anyway, never on a loading or lost-connection screen; the pill says
// Offline with Retry once requests have failed for 10 s, and Retry syncs once sync is back. The app opens on its faulty
// services with sync down (e2e/faults.ts); nothing intercepts a request.
test("sync down at boot: the app opens at once, the pill says Offline with Retry, and Retry syncs once sync is back", { annotation: { type: "summary", description: "With sync down, the app still opens at once, says Offline, and Retry syncs once sync is back." } }, async ({ page }) => {
  requires("faults")
  await page.goto(faultyApp("down"))
  await expect(page.getByRole("main", { name: "App" })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole("button", { name: /Chat/ })).toBeVisible()

  const pill = page.locator('[aria-label="Connection"]')
  await expect(pill).toContainText(OFFLINE, { timeout: 30_000 })
  const retry = pill.getByRole("button", { name: "Retry" })
  await expect(retry).toBeVisible({ timeout: 30_000 })

  await faults(page).shapes.heal()
  await retry.click()
  await expect(pill).toBeEmpty({ timeout: 30_000 })
  await expect(page.locator(".sui-chat-message").first()).toBeVisible({ timeout: 30_000 })
})
