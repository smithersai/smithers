import { defineConfig } from "astro/config"
import { recordings } from "./scripts/markdown.mjs"
export default defineConfig({
  site: "https://tui.smithers.sh",
  markdown: { remarkPlugins: [recordings], shikiConfig: { theme: "github-dark" } },
  vite: { server: { fs: { allow: ["../.."] } }, optimizeDeps: { exclude: ["@smthrs/agent", "@smthrs/harness"] } }
})
