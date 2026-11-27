import { Effect, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import * as Database from "../db/Database"
import { serverUrl } from "../db/TestDatabase"
import { expect, test } from "./fixtures"
import { baseURL, onThisMachine, target } from "./target"

// Persist a representative backlog before a fresh device reads it through the Worker and Electric.
// This fixture is opt-in on a disposable local development database, which its caller resets.
test("the bell interleaves stored spend and personal notices and focuses the visible question", async ({ page }) => {
  test.skip(target !== "local" || !onThisMachine(baseURL) || process.env.E2E_NOTIFICATION_HISTORY_FIXTURE !== "fresh",
    "requires a fresh local developer database")
  const run = crypto.randomUUID()
  const waiting = `run:${run}`
  await Effect.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.withTransaction(Effect.gen(function* () {
      yield* sql`INSERT INTO spend_alerts (id, window_start, window_end, calls, tokens, cost_usd, roles, day_tokens, budget, created_at)
        SELECT 'window-' || n, now() - (n + 1) * interval '1 minute', now() - n * interval '1 minute',
          2, 0, 0, '[]', 0, 1000, now() - n * interval '1 minute' FROM generate_series(1, 113) AS n`
      yield* sql`INSERT INTO notifications (recipient, subject, kind, state, mine, run_id, title, href, occurred_at)
        VALUES ('local-developer', ${waiting}, 'run', 'needs_you', true, ${run}, 'Choose a branch', '/app', now() - interval '90 seconds')`
    }))
  }).pipe(Effect.provide(Database.layer(serverUrl.pipe(Effect.map(url => Redacted.make(url.toString())))))))
  await page.goto("/app")
  const bell = page.getByRole("button", { name: /^Notifications/ })
  await expect(bell).toHaveAccessibleName(/114 unread/, { timeout: 60_000 })
  await bell.click()
  const panel = page.getByRole("dialog", { name: "Notifications" })
  const rows = panel.locator('[data-slot="notification"]')
  await expect(rows).toHaveCount(114)
  await expect(rows.nth(0)).toHaveAttribute("data-entry", "window-1")
  await expect(rows.nth(1)).toHaveAttribute("data-entry", waiting)
  await expect(rows.nth(2)).toHaveAttribute("data-entry", "window-2")
  await expect(rows.nth(113)).toHaveAttribute("data-entry", "window-113")
  await expect(rows.nth(0)).toContainText("2 calls · 0 tokens · $0.00")
  await expect(rows.nth(0)).toHaveAttribute("data-tone", "update")
  await expect(rows.nth(1)).toHaveAttribute("data-expanded", "")
  await expect(rows.nth(1).locator('[data-slot="notification-row"]')).toBeFocused()
})
