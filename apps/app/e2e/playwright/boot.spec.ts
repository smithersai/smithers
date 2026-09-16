import { expect,test } from "@playwright/test"
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
