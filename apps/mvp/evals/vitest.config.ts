import { fileURLToPath } from "node:url"
import vibelang from "vibelang-vite"
import { defineConfig } from "vitest/config"
import { evalFiles } from "./standalone.ts"

// `pnpm eval`: the agent evals (docs/features/agent-evals.md). They call the real model through ChatApi's metered
// endpoint and spend tokens, so `pnpm test` never runs them.
export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  plugins: [vibelang()],
  test: {
    globalSetup: [fileURLToPath(new URL("../../../packages/repo-targets/test-utils/test-schemas.ts", import.meta.url))],
    include: [...evalFiles(process.env.EVAL_ONLY)],
    environment: "node",
    // A whole suite runs inside one test: up to 37 agent answers in turn, each a few model calls, and a pause of a
    // minute before each trial its model failed (evals/suite.ts).
    testTimeout: 120 * 60_000,
    hookTimeout: 120_000,
  },
})
