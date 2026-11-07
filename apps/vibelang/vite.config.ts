import { fileURLToPath } from "node:url"
import vibelang from "vibelang-vite"
import { defineConfig } from "vitest/config"

// Until the live agent lands, the mock Factory layer (no backend, no model) is the app's only backend
// (wiki/decisions/0004-mock-mode.md). `--mode e2e` adds the fault-injection page the recovery tests drive.
export default defineConfig(({ mode }) => ({
  plugins: [vibelang()],
  // The Smithers packages are linked from this repository (package.json `link:`) until this app joins the pnpm
  // workspace (wiki/roadmap.md); @smthrs/ui-css's own import of the style guide resolves through this alias meanwhile.
  resolve: { alias: { "@smthrs/ui-styleguide": fileURLToPath(new URL("../../packages/smithers/ui/ui-styleguide/src/index.ts", import.meta.url)) } },
  build: {
    target: "es2022", sourcemap: true,
    ...(mode === "e2e" ? { rolldownOptions: { input: ["index.html", "e2e/runtime/index.html"] } } : {}),
  },
  server: { port: 5178 },
  test: {
    environment: "happy-dom",
    include: ["test/**/*.test.{ts,vibe}"],
    // Foldkit ships ESM that Vitest must transform with the app.
    server: { deps: { inline: ["foldkit"] } },
  },
}))
