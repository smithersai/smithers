import { build } from "esbuild"
import { fileURLToPath } from "node:url"
import vibelang from "vibelang-unplugin/esbuild"
import { describe, expect, it } from "vitest"

describe("browser bundle", () => {
  it("bundles the root without Node built-ins", async () => {
    const result = await build({
      entryPoints: ["src/index.ts"],
      absWorkingDir: fileURLToPath(new URL("..", import.meta.url)),
      bundle: true,
      plugins: [vibelang({ project: "tsconfig.test.json" })],
      platform: "browser",
      format: "esm",
      write: false,
      logLevel: "silent"
    })
    const output = result.outputFiles[0]?.text ?? ""
    expect(output).not.toMatch(/node:(?:fs|path|child_process|module|crypto)/)
    expect(output).not.toMatch(/require\(["']node:/)
  })
})
