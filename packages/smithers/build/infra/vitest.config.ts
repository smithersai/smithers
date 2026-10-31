import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { join } from "node:path"
import vibelang from "vibelang-vite"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [vibelang({ register: true, project: "tsconfig.test.json" })],
  test: {
    globalSetup: [fileURLToPath(new URL("../../../repo-targets/test-utils/coverage-teardown.mjs", import.meta.url)), fileURLToPath(new URL("../../../repo-targets/test-utils/test-process-environment.mjs", import.meta.url))],
    environment: "node",
    include: ["worker/test/**/*.test.{ts,vibe}", "scripts/**/*.test.{ts,vibe}"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      // Enabled so the thresholds below are computed rather than declared:
      // `Smithers.Vitest` only declines to pass `--coverage.enabled=false`,
      // and vitest's own default is off, so nothing measured this package
      // until this block existed. The thresholds are the workspace contract
      // (the release policy): 100% on every default run.
      enabled: true,
      provider: "v8",
      reportsDirectory: join(tmpdir(), `flows-build-infra-coverage-${process.pid}`),
      // `alchemy.run.ts` only names the Cloudflare resources; every option
      // object and the stack program come from `deployment.ts`, so importing
      // the graph executes all of it and the suite can hold it to 100% too.
      include: ["worker/**/*.{ts,vibe}", "scripts/**/*.{ts,vibe}", "deployment.ts", "alchemy.run.ts"],
      exclude: ["worker/test/**", "scripts/**/*.test.{ts,vibe}"],
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100
      }
    }
  }
})
