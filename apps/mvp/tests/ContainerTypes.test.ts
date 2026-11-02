// The container adapter and app must read the same runtime contract, independently of workspace hoisting.
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { expect, test } from "vitest"

test("Alchemy resolves the app's Cloudflare declarations instead of an undeclared hoisted version", () => {
  const app = createRequire(import.meta.url)
  const alchemy = createRequire(app.resolve("alchemy"))
  const version = (resolve: NodeJS.Require) =>
    (JSON.parse(readFileSync(resolve.resolve("@cloudflare/workers-types/package.json"), "utf8")) as { version: string }).version
  expect(version(alchemy)).toBe(version(app))
})
