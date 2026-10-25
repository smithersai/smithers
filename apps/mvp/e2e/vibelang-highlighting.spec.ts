import { expect, step, test } from "./fixtures"
import { requires } from "./target"

requires("codeStorage", "member")

// Read-only, pinned public VibeLang examples through the real repository view.
const revision = "3ad97368713b9a1fab1fa408388a017687aa7431"
const examples = [
  { path: "typescript/vibelang/cases/decl-schema-error-family/main.vibe", words: ["error", "NotStored", "extends", "StoreError"] },
  { path: "typescript/vibelang/cases/decl-schema-alias/main.vibe", words: ["schema", "Code"] },
  { path: "packages/compiler/test/eslint/fixtures/modules.vibe", words: ["module", "text"] },
] as const

test("VibeLang: inherited errors, schema aliases and module escapes have colour", {
  annotation: { type: "summary", description: "Real .vibe files highlight error inheritance, schema aliases and module blocks." },
}, async ({ page }) => {
  test.setTimeout(420_000)
  for (const example of examples) {
    await step(`Read ${example.path}`, async () => {
      await page.goto(`/smithersai/vibelang/blob/${revision}/${example.path}`)
      const code = page.locator('[data-slot="code-view"]')
      const clone = page.locator('header[aria-label="Repository"]').getByRole("button", { name: "Clone" })
      const refresh = page.getByRole("button", { name: "Refresh", exact: true })
      await expect(code.or(clone).or(refresh)).toBeVisible({ timeout: 60_000 })
      if (await clone.isVisible()) await clone.click()
      await expect(async () => {
        if (await refresh.isVisible()) await refresh.click()
        await expect(code).toHaveAttribute("data-state", "ready", { timeout: 3_000 })
      }).toPass({ timeout: 180_000, intervals: [2_000] })
      for (const word of example.words) {
        // Playwright pierces pierre's shadow root; exact token boundaries ensure
        // these words aren't merely present together in an unhighlighted span.
        const token = code.locator('span[style*="color"]').filter({ hasText: new RegExp(`^${word}$`) }).first()
        await expect(token).toBeVisible({ timeout: 120_000 })
      }
    })
  }
})

test("VibeLang: GitHub's newest commit is readable through the mirror", {
  annotation: { type: "summary", description: "The newest GitHub commit serves the same README through Smithers, refreshing a stale mirror." },
}, async ({ page, request }) => {
  test.setTimeout(240_000)
  const commits = await request.get("https://api.github.com/repos/smithersai/vibelang/commits?per_page=1")
  expect(commits.ok()).toBe(true)
  const latest = (await commits.json()) as Array<{ sha: string }>
  const sha = latest[0]!.sha
  expect(sha).toMatch(/^[0-9a-f]{40}$/)
  const upstream = await request.get(`https://raw.githubusercontent.com/smithersai/vibelang/${sha}/README.md`)
  expect(upstream.ok()).toBe(true)
  const expected = await upstream.text()
  await step("Open the newest GitHub commit", async () => {
    await page.goto(`/smithersai/vibelang/blob/${sha}/README.md`)
    const clone = page.locator('header[aria-label="Repository"]').getByRole("button", { name: "Clone" })
    if (await clone.isVisible()) await clone.click()
    await expect.poll(async () => (await page.request.get("/api/repos/smithersai/vibelang/refs")).status(), { timeout: 180_000 }).toBe(200)
    const path = `/api/repos/smithersai/vibelang/blob/${sha}/README.md`
    const first = await page.request.get(path)
    if (first.status() !== 200) {
      expect(first.status()).toBe(503)
      expect(await first.json()).toEqual({ code: "not_synced" })
      await expect(page.getByText("Not synced yet", { exact: true })).toBeVisible()
      await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeVisible()
    }
    await expect.poll(async () => (await page.request.get(path)).status(), { timeout: 180_000, intervals: [2_000] }).toBe(200)
    expect(await (await page.request.get(path)).text()).toBe(expected)
    const tree = await page.request.get(`/api/repos/smithersai/vibelang/tree/${sha}`)
    expect(tree.status()).toBe(200)
    expect((await tree.json()).paths).toContain("README.md")
    const refresh = page.getByRole("button", { name: "Refresh", exact: true })
    if (await refresh.isVisible()) await refresh.click()
    await expect(page.getByText("Not synced yet", { exact: true })).not.toBeVisible()
  })
})
