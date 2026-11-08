// Stays .ts: Vitest loads configs through Vite's JS/TS config loader.
import { defineConfig } from "vitest/config"
import vibelang from "vibelang-vite"
import { fileURLToPath } from "node:url"

export default defineConfig({
  root: fileURLToPath(new URL("./", import.meta.url)),
  plugins: [vibelang({ project: "../../tsconfig.json" })],
  test: {
    include: ["fixture.coverage.vibe"],
    environment: "node",
    coverage: {
      enabled: true, provider: "v8", include: ["fixture.vibe"], reporter: ["json", "json-summary"],
      thresholds: { perFile: true, lines: 100, statements: 100, branches: 100, functions: 100 },
    },
  },
})
