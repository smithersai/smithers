import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"

const packageRoot = join(import.meta.dirname, "..")
const sourceDir = join(packageRoot, "src")

/*
 * README.md "Route ownership": each row maps route families to the one module
 * that declares their constants.
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

/** Route constants can be nested in plain objects and arrays. */
const routesOf = (value: unknown): ReadonlyArray<string> => {
  const isRoute = (candidate: unknown): candidate is string =>
    typeof candidate === "string" && candidate.startsWith("/api/")
  if (isRoute(value)) return [value]
  if (typeof value !== "object" || value === null) return []
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return []
  return Object.values(value).flatMap(routesOf)
}

const declaredRoutes = async () => {
  const routes: Array<{ module: string; name: string; route: string }> = []
  for (const { module, names } of modules) {
    const exports: Record<string, unknown> = await import(`../src/${module.replace(/\.ts$/, "")}.ts`)
    for (const name of names) {
      for (const route of routesOf(exports[name])) routes.push({ module, name, route })
    }
  }
  return routes
}

describe("route ownership", () => {
  test("finds route constants through arrays and nested plain objects", () => {
    expect(routesOf({
      nested: { routes: ["/api/billing/checkout", { portal: "/api/billing/portal" }] },
      ignored: [null, undefined, false, 42, "/other", new Date(0), () => "/api/ignored"]
    })).toEqual(["/api/billing/checkout", "/api/billing/portal"])
    expect(routesOf(["/api/billing/checkout", ["/api/billing/portal"]])).toEqual([
      "/api/billing/checkout",
      "/api/billing/portal"
    ])
    expect(routesOf("/api/direct")).toEqual(["/api/direct"])
  })

  test("every README family owns at least one route constant in its named module", async () => {
    const routes = await declaredRoutes()
    const stale = table.filter(({ family, module }) =>
      !routes.some((entry) =>
        entry.module === module && (entry.route === family || entry.route.startsWith(`${family}/`))
      )
    )
    expect(stale).toEqual([])
  })
  test("every README row names a module in src/", () => {
    expect(table.length).toBeGreaterThan(0)
    const files = modules.map(({ module }) => module)
    for (const { module } of table) expect(files).toContain(module)
  })

  test("every route constant is declared in the module its README row names", async () => {
    const misplaced: Array<string> = []
    for (const { module, name, route } of await declaredRoutes()) {
      const owner = ownerOf(route)
      if (owner !== module) {
        misplaced.push(`${module} ${name} = ${route}: the README row names ${owner ?? "no module"}`)
      }
    }
    expect(misplaced).toEqual([])
  })
})
