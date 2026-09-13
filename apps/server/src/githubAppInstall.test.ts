import { expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import { configLayer } from "./Config"
import { transportLayer } from "./Http"
import { handleGitHubAppInstall } from "./githubAppInstall"

const verify = async (id: string | undefined, options: { signedIn?: boolean; installed?: boolean; status?: number; verdict?: string } = {}) => {
  const seen: Array<{ path: string; auth: string | null }> = []
  const response = await Effect.runPromise(handleGitHubAppInstall(new Request("https://app.test/api/user/github-app/installations", {
    headers: { cookie: "smithers_session=test" }
  }), id).pipe(Effect.provide(configLayer({ IDENTITY_UPSTREAM_URL: "https://identity.test", IDENTITY_SERVICE_TOKEN: "svc", SMITHERS_CLOUD_API_BASE_URL: "https://cloud.test" })),
  Effect.provide(transportLayer(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname === "/api/identity/validate") return options.signedIn === false ? new Response("", { status: 401 }) : Response.json({ login: "ada", allowlisted: true, admin: false, scopes: [] })
    if (url.pathname === "/api/identity/cloud-token") return Response.json({ found: true, token: "ada-cloud-token" })
    seen.push({ path: url.pathname, auth: new Headers(init?.headers).get("authorization") })
    if (url.pathname === "/api/user/github-repos") return Response.json([{ full_name: "ada/hello", pushed_at: "2026-09-12T00:00:00Z" }])
    if (options.status !== undefined) return Response.json({ message: "upstream failure" }, { status: options.status })
    return Response.json({ verdict: options.verdict ?? (options.installed === false ? "app-not-installed" : "ok"), installation_id: 42, detail: "Your GitHub credential cannot access this repository." })
  }))))
  return { response, seen }
}

test("callback only returns source-only GitHub repositories with a verified matching installation, without prior import", async () => {
  const { response, seen } = await verify("42")
  expect(await response.json()).toEqual({ repos: [{ fullName: "ada/hello", pushedAt: "2026-09-12T00:00:00Z" }] })
  expect(seen).toEqual([
    { path: "/api/user/github-repos", auth: "Bearer ada-cloud-token" },
    { path: "/api/user/github-access/ada/hello", auth: "Bearer ada-cloud-token" }
  ])
  expect(await (await verify("999")).response.json()).toEqual({ repos: [] })
  expect(await (await verify(undefined, { installed: false })).response.json()).toEqual({ repos: [] })
})

test("a return without an id checks installed repository status, never accepts inventory alone", async () => {
  expect((await (await verify(undefined)).response.json() as { repos: unknown[] }).repos).toHaveLength(1)
  expect((await verify(undefined, { status: 503 })).response.status).toBe(503)
})

test("signed-out callbacks cannot read the repository or App installation inventory", async () => {
  const { response, seen } = await verify("42", { signedIn: false })
  expect(response.status).toBe(401)
  expect(seen).toEqual([])
})


test("an existing installation never bypasses the user's own repository grant", async () => {
  const { response } = await verify("42", { verdict: "no-org-grant" })
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({ message: "Your GitHub credential cannot access this repository." })
})
