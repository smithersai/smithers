// Stays .ts: Vite and Vitest load config through their JS/TS-only config loader.
import { defineConfig } from "vitest/config"
import vibelang from "vibelang-vite"
export default defineConfig({plugins:[vibelang()], build:{target:"es2022",outDir:"dist-view"},publicDir:"../vibelang/public",test:{environment:"node",include:["test/**/*.test.vibe"],testTimeout:30000}})
