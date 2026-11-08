import { build } from "esbuild"
import { fileURLToPath } from "node:url"
import vibelang from "vibelang-unplugin/esbuild"
import { describe, expect, it } from "vitest"

describe("browser bundle", () => {
  it("bundles the root entry without Node built-ins", async () => {
    const result = await build({
      plugins: [vibelang({ root: fileURLToPath(new URL("..", import.meta.url)) })],
      entryPoints: ["./src/index.ts"],
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
      logLevel: "silent"
    })
    const output = result.outputFiles[0]?.text ?? ""
    expect(output).not.toMatch(/node:(assert|buffer|child_process|fs|path|url)/)
    expect(output).not.toMatch(/require\(["']node:/)
  })
})
