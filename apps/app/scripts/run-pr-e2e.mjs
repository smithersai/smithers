/** Required PR browser tier; package-local Playwright owns its matching browser. */
import { spawnSync } from "node:child_process"

/*
 * The flow-graph tier runs twice because the flow builder is a BUILD-time
 * flag: each run builds the SPA with the flag it names and asserts the half of
 * the proof that build can answer (playwright.graph.config.ts).
 */
const steps = [
  { args: ["exec", "playwright", "install", "--with-deps", "chromium"] },
  { args: ["run", "test:e2e:auth"] },
  { args: ["run", "test:e2e:probes"] },
  { args: ["exec", "playwright", "test"] },
  {
    args: ["exec", "playwright", "test", "--config", "playwright.graph.config.ts"],
    env: { VITE_SMITHERS_FLOW_BUILDER: "true" }
  },
  {
    args: ["exec", "playwright", "test", "--config", "playwright.graph.config.ts"],
    env: { VITE_SMITHERS_FLOW_BUILDER: "false" }
  }
]

for (const step of steps) {
  const result = spawnSync("pnpm", step.args, {
    stdio: "inherit",
    env: { ...process.env, SMITHERS_CHAT_STUB: "1", SMITHERS_PR_E2E: "1", ...step.env }
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
