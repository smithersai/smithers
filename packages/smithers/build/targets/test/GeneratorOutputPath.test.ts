import * as Path from "node:path"
import { expect, it } from "vitest"
import * as OutputPath from "../src/internal/GeneratorOutputPath.ts"
import * as SafeFs from "../src/SafeFs.ts"

it("allows root and nested outputs while refusing sibling and absolute escapes", () => {
  const root = Path.resolve("workspace-output-policy")
  const host = { resolve: Path.resolve, inside: SafeFs.inside }
  expect(OutputPath.resolve(host, root, ".")).toBe(root)
  expect(OutputPath.resolve(host, root, "out/file")).toBe(Path.join(root, "out/file"))
  expect(() => OutputPath.resolve(host, root, "../sibling")).toThrow(
    "declared output escapes the workspace: ../sibling"
  )
  const outside = Path.resolve(root, "../outside")
  expect(() => OutputPath.resolve(host, root, outside)).toThrow("declared output escapes the workspace")
})
