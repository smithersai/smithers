// Stays .ts: Vitest loads its configuration before VibeLang compilation.
import { defineConfig } from "vitest/config"
import vibelang from "vibelang-vite"
export default defineConfig({ plugins: [vibelang()], test: {
  environment: "node", include: ["bench/sandbox.live.vibe"], maxWorkers: 1, fileParallelism: false,
  testTimeout: 9 * 60_000,
} })
