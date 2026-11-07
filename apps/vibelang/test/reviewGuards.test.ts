// @vitest-environment node
import { readFileSync } from "node:fs"
import { expect, it } from "vitest"
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
it("script examples rely on the full compiler, without a nonexistent projection diagnostics channel", () => {
  expect(read("./scriptedReplies.test.ts")).not.toContain("--ts-projection")
  expect(read("../wiki/decisions/0004-mock-mode.md")).not.toContain("Both projection diagnostics")
})
it("does not install the unused browser platform adapter", () => {
  const pkg = JSON.parse(read("../package.json"))
  expect(pkg.dependencies).not.toHaveProperty("@effect/platform-browser")
  expect(read("../wiki/decisions/0001-app-and-stack.md")).not.toContain("@effect/platform-browser")
})
