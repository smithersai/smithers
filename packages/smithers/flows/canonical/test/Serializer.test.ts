import { build } from "esbuild"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"
import { CanonicalError as RootError, canonicalize as rootCanonicalize } from "../src/index.ts"
import { CanonicalError, canonicalize } from "../src/Serializer.ts"

test("the runtime-free entry shares the exact digest implementation and error identity", () => {
  expect(canonicalize).toBe(rootCanonicalize)
  expect(CanonicalError).toBe(RootError)
})

test("runtime-free entry points have no transitive external or runtime dependency", async () => {
  const result = await build({
    absWorkingDir: fileURLToPath(new URL("../", import.meta.url)),
    entryPoints: ["src/Serializer.ts", "src/Record.ts"],
    bundle: true,
    platform: "browser",
    format: "esm",
    packages: "external",
    outdir: "dist-runtime-free-test",
    write: false,
    metafile: true
  })
  expect(Object.values(result.metafile.outputs).flatMap((output) => output.imports)).toEqual([])
  expect(Object.keys(result.metafile.inputs).every((path) => path.startsWith("src/"))).toBe(true)
})
