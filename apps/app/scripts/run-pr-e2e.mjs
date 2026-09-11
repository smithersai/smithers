/** Required PR browser tier; package-local Playwright owns its matching browser. */
import { spawnSync } from "node:child_process"

for (const args of [
  ["exec", "playwright", "install", "--with-deps", "chromium"],
  ["run", "test:e2e:auth"],
  ["exec", "playwright", "test"]
]) {
  const result = spawnSync("pnpm", args, { stdio: "inherit", env: { ...process.env, SMITHERS_CHAT_STUB: "1", SMITHERS_PR_E2E: "1" } })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
