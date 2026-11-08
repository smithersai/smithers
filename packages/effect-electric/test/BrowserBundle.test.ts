import { build } from "esbuild"
import { fileURLToPath } from "node:url"
import vibelang from "vibelang-unplugin/esbuild"
import { expect, test } from "vitest"

// The root entry bundles for a browser and a Worker with no Node built-in, so the package runs anywhere Effect does.
test("the root entry bundles for the browser without Node built-ins", async () => {
  const result = await build({
    plugins: [vibelang({ root: fileURLToPath(new URL("..", import.meta.url)) })],
    entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
    bundle: true,
    platform: "browser",
    conditions: ["workerd", "worker", "browser", "import", "default"],
    format: "esm",
    write: false,
    logLevel: "silent",
    metafile: true
  })
  const imported = Object.values(result.metafile.inputs).flatMap(({ imports }) => imports.map(({ path }) => path))
  expect(imported.filter((path) => /^(node|bun):/.test(path))).toEqual([])
})
