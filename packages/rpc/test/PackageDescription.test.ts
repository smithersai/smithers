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
  test("finds the network implementations it must disclose", () => {
    expect(implementations).toContain("BrowserFetch")
  })

  test.each(implementations)("names %s in package.json and README", (module) => {
    expect(manifest.description).toContain(module)
    expect(readme).toContain(`\`${module}\``)
  })
})
