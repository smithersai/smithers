import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

// The runner's agent evals: real agents on the operator's accounts, so `pnpm test` never runs them.
export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  test: { include: ["evals/*.eval.ts"], environment: "node", testTimeout: 60 * 60_000 }
})
