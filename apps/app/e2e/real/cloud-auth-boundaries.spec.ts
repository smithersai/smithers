import { scenario } from "./coverage/types"
import { command, expect, openApp, realApi, test } from "./support/test"

/**
 * Cloud PAT authentication belongs to the native/local host.  The real local
 * server deliberately has no Cloud upstream in this suite, so these cases
 * exercise the browser-facing refusal contract without inventing a token or
 * stubbing a response.  A signed-out process must remain signed out and the
 * proxy must never turn an unavailable credential into a successful read.
 */
test("a real local browser sees an honest signed-out Cloud session", scenario("cloud-auth.signed-out-session-boundary", {
  capabilities: ["cloud"],
  coverage: [
    "action:cloud.sign-in", "action:cloud.sign-out", "host:local", "path:permission",
    "path:persistence", "door:slash", "dimension:cloud-session-boundary",
    "evidence:real-session-read-and-no-credential-mutation"
  ],
  description: "The local browser reads the real Cloud auth endpoint, observes the empty session, and cannot claim a credential by invoking sign-in or sign-out while the Cloud seam is unavailable."
}), async ({ page, request }) => {
  await openApp(page)

  const before = await realApi(page, request, "GET", "/api/cloud-auth/session")
  expect(before.status()).toBe(200)
  expect(await before.json()).toEqual({ state: "signed-out", username: null, expiresAt: null })

  await command(page, "/cloud.sign-in")
  await expect(page.getByText(/cloud\.sign-in|Cloud sign-in|Smithers Cloud/i).last()).toBeVisible()
  await expect(page.locator('[data-flow="cloud.sign-in"]:visible')).toHaveCount(0)

  const start = await realApi(page, request, "POST", "/api/cloud-auth/start", {})
  expect(start.status()).toBe(501)
  const signOut = await realApi(page, request, "POST", "/api/cloud-auth/sign-out", {})
  expect(signOut.status()).toBe(501)

  const after = await realApi(page, request, "GET", "/api/cloud-auth/session")
  expect(after.status()).toBe(200)
  expect(await after.json()).toEqual({ state: "signed-out", username: null, expiresAt: null })
})

test("a real signed-out Cloud proxy refuses protected reads before any upstream dial", scenario("cloud-auth.signed-out-proxy-denial", {
  capabilities: ["cloud"],
  coverage: [
    "action:cloud.sign-in", "host:local", "path:permission", "door:slash",
    "dimension:cloud-proxy-auth-boundary", "evidence:exact-cloud-sign-in-required-refusal"
  ],
  description: "A real anonymous browser cannot enumerate Cloud repositories; the proxy returns its explicit sign-in requirement and the UI preserves the Cloud sign-in boundary."
}), async ({ page, request }) => {
  await openApp(page)
  await command(page, "/repo.list")

  const refusal = page.locator('.smithers-card, .smithers-toast').filter({ hasText: /Cloud|sign in|sign-in/i }).last()
  await expect(refusal).toBeVisible()
  await expect(refusal).toContainText(/sign in|unavailable|not implemented/i)

  const response = await realApi(page, request, "GET", "/api/cloud/api/user/repos")
  expect(response.status()).toBe(501)
  const body = await response.json() as { status?: unknown; code?: unknown; message?: unknown }
  expect(body).toMatchObject({ status: "error", code: "not_implemented" })
  expect(body.message).toEqual(expect.any(String))
  expect(String(body.message)).not.toMatch(/repo|repository/i)
})
