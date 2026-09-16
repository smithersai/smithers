import type { Page } from "@playwright/test"
import { scenario } from "./coverage/types"
import { closeComposer, command, expect, openApp, openComposer, test } from "./support/test"

const boot = async (page: Page): Promise<void> => {
  await openApp(page)
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
}

test("the real palette filters flow rows and keyboard selection runs the same search door", scenario("search.palette-keyboard-real", {
  capabilities: [],
  coverage: ["action:palette.open", "action:search.flows", "host:local", "host:production", "path:success", "path:keyboard", "door:user-only", "door:slash", "dimension:palette-filter", "dimension:keyboard-selection", "dimension:keyboard", "evidence:palette-option-and-search-card"],
  description: "The browser opens the actual command palette, filters the registry through its real search seam, and runs the selected search flow with the keyboard."
}), async ({ page }) => {
  await boot(page)
  await openComposer(page)
  const input = page.getByTestId("composer-input")
  await input.fill("/chat")
  const palette = page.getByTestId("palette")
  await expect(palette).toBeVisible()
  await expect(palette).toHaveAttribute("data-mode", "flows")
  await expect(palette.getByRole("option").filter({ hasText: "chat" }).first()).toBeVisible()
  await expect(palette.getByRole("option").filter({ hasText: "billing.balance" })).toHaveCount(0)
  await input.fill("/search.flows chat")
  await input.press("Enter")
  await closeComposer(page)
  const card = page.locator('.smithers-card[data-kind="search-results"]').last()
  await expect(card).toBeVisible()
  await expect(card.getByTestId("search-results-query")).toContainText("chat")
  await expect(card.getByTestId("search-item-flow-chat")).toContainText("chat")
})

test("real search refuses unindexed modes and preserves an honest empty result", scenario("search.unindexed-refusal-real", {
  capabilities: [],
  coverage: ["action:search.symbols", "action:search.text", "host:local", "host:production", "path:error", "door:slash", "dimension:unindexed-search", "dimension:empty-result", "evidence:refusal-and-empty-card"],
  description: "The local host answers unsupported symbol and text indexes honestly, while a valid flow search returns an actual empty card rather than fabricated rows."
}), async ({ page }) => {
  await boot(page)
  await command(page, "/search.symbols Composer")
  await closeComposer(page)
  await expect(page.getByText(/No symbol index exists yet/i).last()).toBeVisible()
  await expect(page.locator('.smithers-card[data-kind="search-results"]')).toHaveCount(0)
  await command(page, "/search.text a-query-that-cannot-exist-in-this-real-session")
  await closeComposer(page)
  await expect(page.getByText(/No text index exists yet/i).last()).toBeVisible()
  await expect(page.locator('.smithers-card[data-kind="search-results"]')).toHaveCount(0)
  await command(page, "/search.flows query-that-is-not-a-flow-9f2f")
  await closeComposer(page)
  const empty = page.locator('.smithers-card[data-kind="search-results"]').last()
  await expect(empty).toBeVisible()
  await expect(empty.getByTestId("search-results-empty")).toContainText("query-that-is-not-a-flow-9f2f")
})

test("the Library is absent while its feature flag is off", scenario("plugins.library-disabled-real", {
  capabilities: [],
  coverage: ["host:local", "host:production", "path:success", "door:slash", "dimension:plugin-shelf", "evidence:disabled-library"],
  description: "The default app does not register Library navigation or mutation commands. Enabled Library behavior is covered by the controller and component suites."
}), async ({ page }) => {
  await boot(page)
  await openComposer(page)
  await page.getByTestId("composer-input").fill("/plugins")
  await expect(page.locator('[data-flow="plugins"]')).toHaveCount(0)
  await expect(page.locator('[data-flow="plugins.install"]')).toHaveCount(0)
  await expect(page.locator('[data-flow="plugins.remove"]')).toHaveCount(0)
  await expect(page.getByRole("region", { name: "Plugins on your workspace" })).toHaveCount(0)
})

test("signed-out notifications commands fail closed through the real requirement door", scenario("cloud-required-notifications-refusal-real", {
  capabilities: [],
  coverage: ["action:notifications.list", "action:notifications.read", "host:local", "host:production", "path:permission", "door:slash", "dimension:signed-out-cloud-requirement", "dimension:no-side-effect", "evidence:sign-in-step-and-no-cloud-card"],
  description: "Without a session, cloud notification actions expose the real sign-in requirement and do not create success cards or issue cloud mutations."
}), async ({ page }) => {
  await boot(page)
  await command(page, "/notifications.list")
  await closeComposer(page)
  await expect(page.getByText(/Sign in with GitHub to show your notifications/i).last()).toBeVisible()
  await expect(page.locator('.smithers-card[data-kind="notifications"]')).toHaveCount(0)
  await command(page, "/notifications.read")
  await closeComposer(page)
  await expect(page.getByText(/Sign in with GitHub to mark every notification read/i).last()).toBeVisible()

})
