import { afterEach, expect, test } from "bun:test"
import { readInstalledRepositories } from "./GitHubInstallInventory"

const servers: Array<ReturnType<typeof Bun.serve>> = []
afterEach(() => { for (const server of servers.splice(0)) server.stop(true) })
const backend = (handler: (request: Request) => Response | Promise<Response>) => {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler })
  servers.push(server)
  return { baseUrl: server.url.origin, http: (url: string, init?: RequestInit) => fetch(url, init) }
}

test("installation return only selects repositories verified by canonical account APIs, across pages", async () => {
  const paths: string[] = []
  let concurrent = 0, maximum = 0
  const ctx = backend(async request => {
    const url = new URL(request.url)
    paths.push(url.pathname + url.search)
    if (url.pathname === "/api/user/github-repos") {
      const page = url.searchParams.get("page")
      return Response.json(page === "1"
        ? Array.from({ length: 100 }, (_, i) => ({ full_name: `alice/r${i}`, pushed_at: "2026-09-20" }))
        : [{ full_name: "alice/chosen", pushed_at: "2026-09-24" }])
    }
    concurrent++; maximum = Math.max(maximum, concurrent)
    await new Promise(resolve => setTimeout(resolve, 1))
    concurrent--
    if (url.pathname.endsWith("/r0")) return Response.json({ message: "not yours" }, { status: 403 })
    return Response.json({ verdict: "ok", installation_id: url.pathname.endsWith("/chosen") ? 42 : 17 })
  })
  expect(await readInstalledRepositories(ctx, "42", () => true)).toEqual({ repos: [
    { fullName: "alice/chosen", pushedAt: "2026-09-24", installationId: 42 }
  ] })
  expect(paths).toHaveLength(103)
  expect(paths.every(path => path.startsWith("/api/user/github-repos?") || path.startsWith("/api/user/github-access/"))).toBe(true)
  expect(maximum).toBeLessThanOrEqual(6)
  expect(maximum).toBeGreaterThan(1)
})

test("provider refusal and malformed diagnosis never report an empty successful installation", async () => {
  let mode = "refused"
  const ctx = backend(request => new URL(request.url).pathname === "/api/user/github-repos"
    ? Response.json([{ full_name: "alice/repo" }])
    : mode === "refused" ? Response.json({ message: "rate limited" }, { status: 429 }) : Response.json({ installation_id: 42 }))
  const refusal = await readInstalledRepositories(ctx, undefined, () => true)
  expect(refusal && "response" in refusal ? refusal.response.status : undefined).toBe(429)
  mode = "malformed"
  await expect(readInstalledRepositories(ctx, undefined, () => true)).rejects.toThrow("unreadable GitHub access diagnosis")
})

test("account change while the inventory is unresolved prevents diagnosis and adoption", async () => {
  let current = true
  let reads = 0
  const ctx = backend(() => { reads++; current = false; return Response.json([{ full_name: "alice/repo" }]) })
  expect(await readInstalledRepositories(ctx, undefined, () => current)).toBeUndefined()
  expect(reads).toBe(1)
})
