import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"

const packageRoot = join(import.meta.dirname, "..")
const sourceDir = join(packageRoot, "src")

/*
 * README.md "Route ownership": each row maps route families to the one module
 * that declares their constants. A route belongs to the longest family it
 * falls under, so `/api/cloud-ws/…` is the tunnel's and `/api/targets/graph`
 * is TargetGraph's while `/api/targets/query` is LocalApp's.
 */
const table = readFileSync(join(packageRoot, "README.md"), "utf8")
  .split("\n")
  .flatMap((line) => {
    const row = /^\|(.+)\|\s*`([A-Za-z]+\.ts)`\s*\|$/.exec(line)
    if (row === null) return []
    const [, families = "", module = ""] = row
    return [...families.matchAll(/`(\/api\/[^`]+)`/g)].map(([, family = ""]) => ({ family, module }))
  })

const ownerOf = (route: string): string | undefined =>
  table
    .filter(({ family }) => route === family || route.startsWith(`${family}/`))
    .sort((a, b) => b.family.length - a.family.length)[0]?.module

/** The names each module declares itself; a re-export belongs to the module it names. */
const modules = readdirSync(sourceDir)
  .filter((file) => file.endsWith(".ts"))
  .map((file) => {
    const source = readFileSync(join(sourceDir, file), "utf8")
    return { module: file, names: [...source.matchAll(/^export const (\w+)/gm)].map((match) => match[1] ?? "") }
  })

/** A route constant is an `/api/` string, or a plain object of them such as TargetGraph's route table. */
const routesOf = (value: unknown): ReadonlyArray<string> => {
  const isRoute = (candidate: unknown): candidate is string =>
    typeof candidate === "string" && candidate.startsWith("/api/")
  if (isRoute(value)) return [value]
  if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) return []
  return Object.values(value).filter(isRoute)
}

describe("route ownership", () => {
  test("every README row names a module in src/", () => {
    expect(table.length).toBeGreaterThan(0)
    const files = modules.map(({ module }) => module)
    for (const { module } of table) expect(files).toContain(module)
  })

  test("every route constant is declared in the module its README row names", async () => {
    const misplaced: Array<string> = []
    for (const { module, names } of modules) {
      const exports: Record<string, unknown> = await import(`../src/${module.replace(/\.ts$/, "")}.ts`)
      for (const name of names) {
        for (const route of routesOf(exports[name])) {
          const owner = ownerOf(route)
          if (owner !== module) {
            misplaced.push(`${module} ${name} = ${route}: the README row names ${owner ?? "no module"}`)
          }
        }
      }
    }
    expect(misplaced).toEqual([])
  })
})
