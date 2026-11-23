import vibelang from "vibelang-vite"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [vibelang({ project: "tsconfig.json" })],
  test: {
    include: ["**/*.fuzz.test.{ts,vibe}"],
    environment: "node",
    testTimeout: 30_000
  }
})
