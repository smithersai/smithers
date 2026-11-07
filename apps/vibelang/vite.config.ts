import vibelang from "vibelang-vite"
import { defineConfig } from "vitest/config"

// Until the live agent lands, the mock Factory layer (no backend, no model) is the app's only backend
// (wiki/decisions/0004-mock-mode.md). `--mode e2e` adds the fault-injection page the recovery tests drive.
export default defineConfig(({ mode }) => ({
  plugins: [vibelang()],
  build: {
    target: "es2022", sourcemap: true,
    ...(mode === "e2e" ? { rolldownOptions: { input: ["index.html", "e2e/runtime/index.html"] } } : {}),
  },
  server: { port: 5178 },
  test: {
    environment: "happy-dom",
    include: ["test/**/*.test.{ts,vibe,mjs}"],
    // Foldkit ships ESM that Vitest must transform with the app.
    server: { deps: { inline: ["foldkit"] } },
  },
}))
