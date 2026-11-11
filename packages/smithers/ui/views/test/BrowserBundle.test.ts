/**
 * The root entry bundles for a browser and a Worker without a Node built-in,
 * and the realm half a presentation bundle carries pulls in nothing else.
 */
import { build } from "esbuild"
import { builtinModules } from "node:module"
import { fileURLToPath } from "node:url"
import vibelang from "vibelang-unplugin/esbuild"
import { describe, expect, it } from "vitest"

const node = new Set(builtinModules)

const bundleOf = async (contents: string, conditions: Array<string>) => {
  const result = await build({
    plugins: [vibelang({ root: fileURLToPath(new URL("..", import.meta.url)) })],
    stdin: { contents, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions,
    metafile: true,
    logLevel: "silent"
  })
  return result
}

describe("@smthrs/views bundles", () => {
  for (const conditions of [["browser", "import", "default"], ["workerd", "worker", "browser", "import", "default"]]) {
    it(`for ${conditions[0]} without a Node or Bun built-in`, async () => {
      const result = await bundleOf("export * from \"../src/index.ts\"", conditions)
      const reached = Object.keys(result.metafile.inputs).filter((input) =>
        input.startsWith("node:") || input.startsWith("bun:") || node.has(input)
      )
      expect(reached).toEqual([])
    }, 60_000)
  }

  it("keeps the realm half free of Effect, the checker and QuickJS", async () => {
    const result = await bundleOf(
      "import { Presentation } from \"../src/index.ts\"\nexport const install = Presentation.install",
      ["browser", "import", "default"]
    )
    // What reaches the output, not what esbuild read and then shook out.
    const output = Object.values(result.metafile.outputs)[0]!
    const inputs = Object.entries(output.inputs).filter(([, input]) => input.bytesInOutput > 0).map(([path]) => path)
    expect(
      inputs.filter((input) => /node_modules\/(effect|sucrase|@babel|quickjs-emscripten-core|@jitl)\//.test(input))
    ).toEqual([])
    expect(inputs.sort()).toEqual([
      "<stdin>",
      "src/Presentation.ts",
      "src/internal/harden.ts",
      "src/internal/vocabulary.ts"
    ])
  }, 60_000)
})
