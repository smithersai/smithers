// Stays .ts: Vitest loads --config files through Vite's config loader, which bundles JS/TS files only.
// Reproduce review finding 12 without editing production source. This run must fail its isolation assertion.
// pnpm exec vitest run --config test/mutations/room-isolation.config.ts test/MockFactory.test.vibe -t 'keeps complete live transcripts'
import { defineConfig, mergeConfig } from "vitest/config"
import config from "../../vite.config.ts"

export default defineConfig((env) => mergeConfig(config(env), {
  plugins: [{
    name: "remove-room-filter",
    enforce: "post",
    transform(code: string, id: string) {
      if (!id.split("?")[0]!.endsWith("/src/core/MockFactory.vibe")) return
      const predicate = "item.conversation === conversation && "
      if (!code.includes(predicate)) throw new Error("Room-filter mutation did not match; update this mutation check")
      return { code: code.replace(predicate, ""), map: null }
    },
  }],
}))
