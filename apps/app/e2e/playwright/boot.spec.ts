import { expect, test } from "@playwright/test"
import { localApiGet } from "./localApi"

/*
 * M0 boot (LOCAL-APP.md, "Test tiers"): the local origin answers, the SPA
 * mounts (the guide shell owns first paint), and advertises only the
 * services in bootstrap.
 */

test("GET /api/health answers ok with node and sandbox", async ({ request }) => {
  const response = await request.get("/api/health")
  expect(response.status()).toBe(200)
  const body = (await response.json()) as {
    ok: boolean
    version: string
    pid: number
    node: { path: string; version: string } | null
    sandbox: { platform: string; enforced: boolean }
  }
  expect(body.ok).toBe(true)
  expect(typeof body.version).toBe("string")
  expect(typeof body.pid).toBe("number")
  expect(body.node === null || typeof body.node.path === "string").toBe(true)
  expect(typeof body.sandbox.platform).toBe("string")
  expect(typeof body.sandbox.enforced).toBe("boolean")
})

test("the offline local app boots without advertising unavailable cloud identity", async ({ page }) => {
  await page.goto("/")
  await expect(page).toHaveTitle(/Smithers/)
  /*
   * The guide shell is the mounted app: it owns first paint (the entrance),
   * with the transcript mounted beneath it and the composer hidden until
   * summoned (the 2026-09-08 brief: Command-K summons ONLY the composer).
   */
  await expect(page.locator(".guide-shell")).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeHidden()
  await expect(page.getByTestId("chrome-sign-in")).toHaveCount(0)
  // The opening read sits above it; the identity state is its own message (mounted, beneath the guide).
  await expect(
    page.locator('.smithers-chat-message[data-role="assistant"]').filter({ hasText: "Smithers identity" })
  ).toContainText("doesn't provide Smithers identity")
  // Anonymous is the open state: Command-K summons the composer, nothing gates.
  await page.keyboard.press("Control+k")
  await expect(page.getByTestId("composer-input")).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeEnabled()
})

test("the default test origin discovers no real harness identities", async ({ page, request }) => {
  test.skip(process.env.SMITHERS_E2E_HOST_HARNESSES === "1", "explicit real-host harness lane")
  await page.goto("/")
  const health = await (await request.get("/api/health")).json() as { home: string }
  expect(health.home).toContain("smithers-browser-test-")
  const response = await localApiGet(page, request, "/api/harnesses")
  expect(response.status()).toBe(200)
  const body = await response.json() as { harnesses: Array<{ status: string; binary: string | null; account: unknown }> }
  expect(body.harnesses.length).toBeGreaterThan(0)
  expect(body.harnesses.every((row) => row.status === "unavailable" && row.binary === null && row.account === null)).toBe(true)
})
