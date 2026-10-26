import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { apiRoute, routeTemplate } from "./apiRoutes"

const root = fileURLToPath(new URL("..", import.meta.url))

/** Every production .ts file under `directory`: no tests and no test hosts. */
const sources = (directory: string): Array<string> =>
  readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) return name === "test" || name === "node_modules" ? [] : sources(path)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })

describe("routeTemplate", () => {
  it("keeps the app's route words and names every other segment, never a repository, id or name", () => {
    expect(routeTemplate("/api/repos/acme/widgets/stack")).toBe("/api/repos/:owner/:repo/stack")
    expect(routeTemplate("/api/repos/acme/widgets/secrets/STRIPE_KEY")).toBe("/api/repos/:owner/:repo/secrets/:id")
    expect(routeTemplate("/api/repos/launch")).toBe("/api/repos/launch")
    expect(routeTemplate("/api/repos/r-1/file")).toBe("/api/repos/:owner/file")
    expect(routeTemplate("/api/runs/run-1/credential")).toBe("/api/runs/:id/credential")
    expect(routeTemplate("/api/branches/b-1/shares")).toBe("/api/branches/:id/shares")
    expect(routeTemplate("/api/shapes/items")).toBe("/api/shapes/items")
    expect(routeTemplate("/api/shapes/item-summaries")).toBe("/api/shapes/item-summaries")
    expect(routeTemplate("/api/shapes/")).toBe("/api/shapes/")
    expect(routeTemplate("/api/answers/a-1/x/y")).toBe("/api/answers/:id/:id/:id")
  })

  it("keeps every route the app and ChatApi name as they are", () => {
    const literal = /["`](\/api\/[a-z0-9/_-]*)/g
    const routes = new Set(
      [...sources(join(root, "src")), ...sources(join(root, "worker"))].flatMap((file) =>
        // Code only: a comment may show a route with sample names in it.
        [...readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").matchAll(literal)]
          .map((match) => match[1]!)
      ),
    )
    expect(routes.size).toBeGreaterThan(50)
    for (const route of routes) expect(routeTemplate(route), route).toBe(route)
  })
})

describe("apiRoute", () => {
  const route = apiRoute("https://smithers.sh")

  it("names the app's own /api/ requests by their template", () => {
    expect(route(new URL("https://smithers.sh/api/repos/acme/widgets/home?x=1"))).toBe("/api/repos/:owner/:repo/home")
  })

  it("leaves alone another origin, a path outside /api/, and the telemetry export", () => {
    expect(route(new URL("https://elsewhere.example/api/questions"))).toBeUndefined()
    expect(route(new URL("https://smithers.sh/assets/index.js"))).toBeUndefined()
    expect(route(new URL("https://smithers.sh/api/telemetry/v1/logs"))).toBeUndefined()
  })
})
