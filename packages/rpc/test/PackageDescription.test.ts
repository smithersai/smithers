import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"

const packageRoot = join(import.meta.dirname, "..")
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { description: string }
const readme = readFileSync(join(packageRoot, "README.md"), "utf8")

/* Modules that perform network I/O rather than only declaring contracts. */
const implementations = readdirSync(join(packageRoot, "src"))
  .filter((file) => file.endsWith(".ts"))
  .filter((file) => /\bfetch\(/.test(readFileSync(join(packageRoot, "src", file), "utf8")))
  .map((file) => file.replace(/\.ts$/, ""))

describe("package description", () => {
  test("contract modules perform no network I/O", () => {
    expect(implementations).toEqual([])
  })

  test("describes the contracts without an unmounted fetch handler", () => {
    expect(manifest.description).toContain("zod schemas")
    expect(manifest.description).not.toContain("BrowserFetch")
    expect(readme).not.toContain("BrowserFetch")
  })
})
