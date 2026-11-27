// 3rd-party contributor onboarding, prepaid cloud compute credits, and one-click forks (decision 0175).
import { expect, test as devicesTest } from "./devices"
import { step, test } from "./fixtures"
import { requires } from "./target"

test("landing page clearly explains the three contributor paths (BYOA free, Fork & maintain, Cloud sandboxes)", async ({ page }) => {
  await step("Open /: the three contributor paths are visible above the fold", async () => {
    await page.goto("/")
    const paths = page.getByRole("region", { name: "Ways to contribute" })
    await expect(paths).toBeVisible({ timeout: 30_000 })
    await expect(paths.getByRole("heading", { name: "Bring your own agent" })).toBeVisible()
    await expect(paths.getByText("Free", { exact: true })).toBeVisible()
    await expect(paths.getByRole("heading", { name: "Fork & maintain" })).toBeVisible()
    await expect(paths.getByRole("heading", { name: "Cloud sandboxes" })).toBeVisible()
    await expect(paths.getByText("~$0.15/hr", { exact: false })).toBeVisible()
  })
})

test("settings page displays Cloud compute & credits balance, rates, and prepaid packs", async ({ page }) => {
  await step("Open /app/settings: Cloud compute & credits section loads from /api/billing/account", async () => {
    await page.goto("/app/settings")
    const billing = page.getByRole("region", { name: "Cloud compute and credits" })
    await expect(billing).toBeVisible({ timeout: 30_000 })
    await expect(billing.getByRole("heading", { name: "Cloud compute & credits" })).toBeVisible()
    await expect(billing.getByText("Bringing your own agent locally via MCP is always free", { exact: false })).toBeVisible()
    const accountRes = await page.request.get("/api/billing/account")
    expect(accountRes.status()).toBe(200)
    const body = (await accountRes.json()) as { packs?: ReadonlyArray<{ label: string }> }
    expect(body.packs?.map((p) => p.label)).toEqual(["$10", "$25", "$50"])
  })
})

devicesTest("non-member contributor sees fork/BYOA/credits onboarding on /app and Fork button on read-only repos", async ({ devices }) => {
  requires("devPeople")
  devicesTest.setTimeout(120_000)
  const [contrib] = await devices.openAs(`reader-${devices.word}`, "Contributor")
  const page = contrib.page

  await step("On /app: contributor options surface browse & fork links, Connect your agent (Free), and Add cloud credits", async () => {
    await page.goto("/app")
    await contrib.ready()
    const options = page.locator(".first-run-contributor")
    await expect(options).toBeVisible({ timeout: 30_000 })
    await expect(options.getByRole("link", { name: "smithersai/smithers" })).toBeVisible()
    await expect(options.getByRole("link", { name: "Connect your agent (Free)" })).toBeVisible()
    await expect(options.getByRole("link", { name: "Add cloud credits" })).toBeVisible()
  })

  await step("On /app/settings: non-member has $0 prepaid credits and computeAccess none until funded", async () => {
    const res = await page.request.get("/api/billing/account")
    expect(res.status()).toBe(200)
    expect(await res.json()).toMatchObject({
      isDeploymentMember: false,
      computeAccess: "none",
      balanceMicroUsd: 0,
    })
  })
})
