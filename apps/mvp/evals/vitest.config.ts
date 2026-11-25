import { fileURLToPath } from "node:url"
import vibelang from "vibelang-vite"
import { defineConfig } from "vitest/config"
import { evalFiles } from "./standalone.ts"

// `pnpm eval`: explicit live model evaluations, outside the regular test suite.
export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  plugins: [vibelang()],
  test: {
    globalSetup: [fileURLToPath(new URL("../../../packages/repo-targets/test-utils/test-schemas.ts", import.meta.url))],
    include: [...evalFiles(process.env.EVAL_ONLY)],
    environment: "node",
    testTimeout: 120 * 60_000,
    hookTimeout: 120_000,
  },
})
