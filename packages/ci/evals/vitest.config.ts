import vibelang from "vibelang-vite"
import { defineConfig } from "vitest/config"

// The live eval: `pnpm exec vitest run --config evals/vitest.config.ts`. It calls a real model, so `pnpm test` never
// runs it.
export default defineConfig({
  plugins: [vibelang({ project: "tsconfig.test.json" })],
  test: {
    environment: "node",
    include: ["evals/**/*.eval.vibe"],
    coverage: { enabled: false },
    disableConsoleIntercept: true
  }
})
