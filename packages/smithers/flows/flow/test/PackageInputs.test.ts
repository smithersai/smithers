/**
 * Every workspace source a suite executes contributes to both target keys.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, it } from "vitest"

const root = join(import.meta.dirname, "..")
const declaration = readFileSync(join(root, "PACKAGE.ts"), "utf8")
const engineInputs = readFileSync(join(root, "../engine/SourceInputs.ts"), "utf8")

const importsIn = (directory: string): ReadonlySet<string> => {
  const imported = new Set<string>()
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(?:ts|vibe)$/.test(entry.name)) continue
    const source = readFileSync(join(entry.parentPath, entry.name), "utf8")
    for (const match of source.matchAll(/from "@smthrs\/([a-z-]+)(?:\/[^"]*)?"/g)) imported.add(match[1]!)
  }
  return imported
}

const packageBindings = (source: string): ReadonlyMap<string, string> => {
  const bindings = new Map<string, string>()
  for (const match of source.matchAll(/import \{ Package as (\w+) \} from "\.\.\/([a-z-]+)\/PACKAGE\.ts"/g)) {
    bindings.set(match[1]!, match[2]!)
    const local = new RegExp(`const (\\w+) = ${match[1]}\\.lib`).exec(source)
    if (local !== null) bindings.set(local[1]!, match[2]!)
  }
  return bindings
}

it.each(["check", "test"])("keys %s on every package its suites and engine import", (target) => {
  const start = declaration.indexOf(`const ${target} = Smithers.`)
  expect(start).toBeGreaterThanOrEqual(0)
  const block = declaration.slice(start, declaration.indexOf("\n})", start))
  const deps = /deps: \[([^\]]*)\]/.exec(block)?.[1]!.split(",").map((name) => name.trim()) ?? []
  expect(deps).toContain("engineSourceInputs")
  const bindings = packageBindings(declaration)
  const covered = new Set(deps.flatMap((name) => bindings.has(name) ? [bindings.get(name)!] : []))
  covered.add("flow")
  covered.add("engine")
  const groupSources = /srcs: \[([^\]]*)\]/.exec(engineInputs)?.[1] ?? ""
  for (const [binding, name] of packageBindings(engineInputs)) {
    if (groupSources.includes(`${binding}.lib`)) covered.add(name)
  }
  const imported = new Set([
    ...importsIn(join(root, "test")),
    ...importsIn(join(root, "examples")),
    ...importsIn(join(root, "../engine/src"))
  ])
  expect([...imported].filter((name) => !covered.has(name))).toEqual([])
})
