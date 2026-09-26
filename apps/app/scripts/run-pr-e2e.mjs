/** Required PR browser tier; package-local Playwright owns its matching browser. */
import { spawnSync } from "node:child_process"

const steps = [
  ["exec", "playwright", "install", "--with-deps", "chromium"],
  ["run", "test:e2e:auth"],
  ["run", "test:e2e:probes"],
  ["run", "test:e2e:graph-lifecycle"],
  ["exec", "playwright", "test"],
  // The showcase cases as plain assertion tests (no recording). It reuses the dist/ the
  // T1 step above builds, so it must stay after that step.
  ["exec", "playwright", "test", "--config", "playwright.showcase.config.ts"],
  ["exec", "playwright", "test", "--config", "playwright.site.config.ts"],
  ["exec", "playwright", "test", "--config", "playwright.graph.config.ts"]
]

for (const args of steps) {
  const showcase = args.includes("playwright.showcase.config.ts")
  const result = spawnSync("pnpm", args, {
    stdio: "inherit",
    env: { ...process.env, SMITHERS_CHAT_STUB: "1", SMITHERS_PR_E2E: "1", ...(showcase ? { SMITHERS_SKIP_SPA_BUILD: "1" } : {}) }
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
