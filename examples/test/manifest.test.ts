/**
 * Pins the examples manifest to the packages the examples actually import.
 *
 * A dependency nobody imports still costs an install, a lockfile importer entry
 * and a false signal about what the examples exercise, so every runtime
 * dependency must be imported by at least one example or test.
 *
 * @since 0.1.0
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { expect, it } from "vitest"

const root = new URL("..", import.meta.url).pathname

const sourceFiles = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx|mts)$/.test(name) ? [path] : []
  })

const importedPackages = (files: ReadonlyArray<string>): ReadonlySet<string> => {
  const found = new Set<string>()
  for (const file of files) {
    for (const match of readFileSync(file, "utf8").matchAll(/from\s+["']((?:@[^/"']+\/)?[^./"'][^/"']*)/g)) {
      found.add(match[1]!)
    }
  }
  return found
}

it("declares only runtime dependencies the examples import", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    dependencies: Record<string, string>
  }
  const imported = importedPackages([...sourceFiles(join(root, "src")), ...sourceFiles(join(root, "test"))])
  const unused = Object.keys(manifest.dependencies).filter((name) => !imported.has(name))
  expect(unused).toEqual([])
})
