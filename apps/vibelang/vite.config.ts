import { fileURLToPath } from "node:url"
import vibelang from "vibelang-vite"
import { defineConfig } from "vitest/config"

// `vite --mode mock` (or `?mock` in the URL) runs the app with no backend and no model: the mock Factory layer stands
// in for vibelang.smithers.sh's API (wiki/decisions/0004-mock-mode.md).
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
