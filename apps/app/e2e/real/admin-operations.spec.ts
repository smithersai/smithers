import { scenario } from "./coverage/types"
import { authenticatedTest } from "./auth-permissions/profile"
import { command, expect, closeComposer } from "./support"

import { bootProductionRepository } from "./repositories-github/production"

authenticatedTest("admin reset asks for confirmation and cancel preserves the live transcript", scenario("admin.reset-confirm-cancel", {
  capabilities: ["identity"],
  coverage: [
    "action:admin.reset.ask", "action:admin.reset.cancel", "action:admin.devtools", "host:production",
    "path:permission", "path:persistence", "path:keyboard", "door:slash", "door:button", "door:user-only",
    "dimension:keyboard", "dimension:destructive-confirmation", "dimension:reset-cancel", "evidence:transcript-and-session-readback"
  ],
  description: "An authenticated admin reaches the real destructive reset dialog, verifies its exact warning, cancels by keyboard, and proves the current transcript and session remain present."
}), async ({ page }) => {
  await bootProductionRepository(page)
  if (!await page.locator(".devtools-panel").isVisible()) await command(page, "/admin.devtools")
  await closeComposer(page)
  await expect(page.locator(".devtools-panel")).toBeVisible()
  await command(page, "/admin.health")
  await closeComposer(page)
  const health = page.locator('.smithers-card[data-kind="admin-health"]').last()
  await expect(health).toBeVisible({ timeout: 30_000 })
  await command(page, "/admin.reset.ask")
  const dialog = page.getByRole("dialog", { name: "Start a fresh conversation?" })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText("everything on screen will be discarded")
  await expect(dialog).toContainText("Nothing is kept")
  const cancel = dialog.getByRole("button", { name: "Cancel", exact: true })
  await cancel.focus()
  await expect(cancel).toBeFocused()
  await cancel.press("Enter")
  await expect(dialog).toBeHidden()
  await expect(health).toBeVisible()
  await expect(page.locator(".devtools-panel")).toBeVisible()
})

authenticatedTest("admin grant cancellation never posts a billing mutation", scenario("admin.grant-cancel-no-write", {
  capabilities: ["identity"],
  coverage: [
    "action:admin.grant", "action:admin.grant.cancel", "host:production", "path:permission", "path:persistence",
    "path:keyboard", "door:slash", "door:button", "door:user-only", "dimension:keyboard", "dimension:grant-confirmation",
    "dimension:grant-cancel", "dimension:no-write", "evidence:request-observation-and-card-removal"
  ],
  description: "The real admin grant flow creates a confirmation card but canceling it removes the card without sending a billing grant request."
}), async ({ page }) => {
  await bootProductionRepository(page)
  const requests: Array<{ method: string; path: string }> = []
  page.on("request", request => {
    const url = new URL(request.url())
    if (url.pathname === "/api/admin/grant" || url.pathname === "/api/billing/admin/grants") {
      requests.push({ method: request.method(), path: url.pathname })
    }
  })
  await command(page, "/admin.grant 1 smithers-e2e-invalid")
  await closeComposer(page)
  const card = page.locator('.smithers-card[data-kind="grant-confirm"]').last()
  await expect(card).toBeVisible()
  await expect(card).toContainText("Grant $1")
  await expect(card).toContainText("smithers-e2e-invalid")
  await card.getByRole("button", { name: "Cancel", exact: true }).press("Enter")
  await expect(card).toBeHidden()
  expect(requests).toEqual([])
})

authenticatedTest("admin grant rejects zero amount before any billing mutation", scenario("admin.grant-invalid-amount-refusal", {
  capabilities: ["identity"],
  coverage: [
    "action:admin.grant", "host:production", "path:error", "path:keyboard",
    "door:slash", "door:button", "door:user-only", "dimension:keyboard", "dimension:grant-validation", "dimension:no-credit",
    "evidence:validation-form-and-no-billing-request"
  ],
  description: "A zero-dollar grant remains in the validation form; submitting it still produces no billing request or grant confirmation."
}), async ({ page }) => {
  await bootProductionRepository(page)
  const requests: string[] = []
  page.on("request", request => {
    const path = new URL(request.url()).pathname
    if (request.method() === "POST" && (path === "/api/admin/grant" || path === "/api/billing/admin/grants")) requests.push(path)
  })
  await command(page, "/admin.grant 0 smithers-e2e-invalid")
  await closeComposer(page)
  const form = page.getByRole("region", { name: "Grant balance to a login (asks for confirmation first)", exact: true }).last()
  await expect(form).toBeVisible()
  await expect(form.getByRole("spinbutton", { name: "Amount usd" })).toHaveValue("0")
  await expect(form.getByRole("alert")).toContainText(/amount in dollars/)
  await form.getByRole("button", { name: "Submit", exact: true }).press("Enter")
  await expect(form).toHaveAttribute("data-status", "error")
  await expect(form.getByRole("alert")).toBeVisible()
  await expect(page.locator('.smithers-card[data-kind="grant-confirm"]')).toHaveCount(0)
  expect(requests).toEqual([])
  await form.getByRole("button", { name: "Cancel", exact: true }).press("Enter")
  await expect(form).toBeHidden()
})

authenticatedTest("admin allowlist add and remove are real, observable, and cleaned up", scenario("admin.allowlist-add-remove-cleanup", {
  capabilities: ["identity"],
  coverage: [
    "action:admin.allowlist.add", "action:admin.allowlist.remove", "host:production", "path:success", "path:error",
    "path:persistence", "door:slash", "dimension:allowlist-roundtrip", "dimension:cleanup", "evidence:post-response-and-reload"
  ],
  description: "A unique disposable login is added and removed through the live admin allowlist route; both responses are observed and cleanup runs even when an assertion fails."
}), async ({ page }) => {
  await bootProductionRepository(page)
  const login = `smithers-e2e-${Date.now()}`
  const responses: Array<{ action: string; status: number }> = []
  page.on("response", async response => {
    const url = new URL(response.url())
    if (url.pathname !== "/api/admin/allowlist" && url.pathname !== "/api/identity/admin/allowlist") return
    if (response.request().method() !== "POST") return
    const body = response.request().postDataJSON() as { action?: unknown } | null
    if (body?.action === "add" || body?.action === "remove") responses.push({ action: body.action, status: response.status() })
  })
  try {
    await command(page, `/admin.allowlist.add ${login}`)
    await expect(page.getByTestId("transcript")).toContainText(login)
    await expect(page.getByTestId("transcript")).toContainText(/allowlist/i)
    await page.reload({ waitUntil: "domcontentloaded" })
    await command(page, `/admin.allowlist.remove ${login}`)
    await expect(page.getByTestId("transcript")).toContainText(login)
    await expect(page.getByTestId("transcript")).toContainText(/allowlist/i)
    expect(responses).toEqual([{ action: "add", status: expect.any(Number) }, { action: "remove", status: expect.any(Number) }])
    expect(responses.every(response => response.status >= 200 && response.status < 300)).toBe(true)
  } finally {
    // A failed assertion after add must not strand the disposable login.
    const cleanup = await page.context().request.post(new URL("/api/admin/allowlist", page.url()).toString(), {
      data: { login, action: "remove" }
    }).catch(() => undefined)
    if (cleanup !== undefined && !cleanup.ok()) {
      throw new Error(`Disposable allowlist cleanup failed: HTTP ${cleanup.status()}.`)
    }
  }
})
