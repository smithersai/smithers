import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    // Only this package's own suite. `infra/` is its own workspace package
    // with its own vitest run; `docs/`, `terraform/`, and `scripts/` carry no
    // vitest tests.
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      // Enabled so the thresholds below actually gate every run; without
      // this flag they were declared and never computed. The floors are the
      // measured coverage rounded down one point: an honest ratchet, raised
      // as tests accrete toward the workspace's 100% norm, never lowered.
      // Last raised 2026-09-01, from 83/70/74/84, when the mid-read guards,
      // the probe bound, the layers, and the manifest vectors got tests.
      enabled: true,
      provider: "v8",
      reportsDirectory: join(tmpdir(), `flows-build-coverage-${process.pid}`),
      include: ["src/**"],
      // Nested packages have their own coverage gates. Absolute patterns keep
      // checkout ancestors such as `review-harness` out of exclusion matching.
      exclude: ["build-cli/**", "infra/**", "targets/**"],
      thresholds: {
        branches: 91,
        functions: 89,
        lines: 95,
        statements: 94
      }
    }
  }
})
