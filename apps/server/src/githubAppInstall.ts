import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import { ServerConfig } from "./Config"
import { cloudTokenRefusal, fetchCloudToken } from "./gateway"
import { fetchWithDeadline } from "./Http"
import { requireTurnSession } from "./identity"
import { json, refuse, upstreamUnreachable } from "./Responses"

export const INSTALLATIONS_PATH = "/api/user/github-app/installations"
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** Verify against the caller's GitHub inventory and live App/user access diagnosis.
 * The callback id is a filter, never permission to read someone else's install.
 */
export const handleGitHubAppInstall = (request: Request, installationId?: string) => Effect.gen(function* () {
  // Validate the session and mint the Cloud token ONCE. Routing every read
  // through handlePlatformProxy cost three subrequests per repository and
  // tripped the Worker's 1000-subrequest ceiling at a few hundred repos.
  const config = yield* ServerConfig
  const gate = yield* requireTurnSession(request)
  if (gate instanceof Response) return gate
  const token = yield* fetchCloudToken(gate.login)
  if (token.status !== "ok") {
    const refusal = cloudTokenRefusal(token, `Smithers Cloud isn't reachable for your account right now (${token.status}).`)
    return refuse(refusal.code, refusal.message)
  }
  const headers = { authorization: `Bearer ${token.token}`, accept: "application/json" }
  const read = (path: string) => Effect.gen(function* () {
    const fetched = yield* Effect.result(fetchWithDeadline("Smithers Cloud", new URL(path, config.cloudApiBaseUrl).toString(), { headers }, config.upstreamTimeoutMs))
    return Result.isFailure(fetched) ? upstreamUnreachable("Smithers Cloud", fetched.failure) : fetched.success
  })
  const repos: Array<{ fullName: string; pushedAt: string; installationId: number }> = []
  const seen = new Set<string>()
  const blockers: string[] = []
  for (let page = 1; page <= 10; page++) {
    const inventory = yield* read(`/api/user/github-repos?sort=pushed&direction=desc&per_page=100&page=${page}`)
    // Upstream prose never passes through (the proxy's rule): restate it.
    if (!inventory.ok) return json(inventory.status, { message: "Smithers Cloud could not verify the GitHub App installation. Try again." })
    const body: unknown = yield* Effect.promise(() => inventory.json().catch(() => null))
    const rows = Array.isArray(body) ? body : record(body) && Array.isArray(body.repos) ? body.repos : record(body) && Array.isArray(body.items) ? body.items : undefined
    if (rows === undefined) return refuse("upstream_malformed", "Smithers Cloud returned an unreadable repository list.")
    const candidates = rows.flatMap(row => {
      if (!record(row)) return []
      const name = typeof row.full_name === "string" ? row.full_name : undefined
      if (name === undefined || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(name) || seen.has(name)) return []
      seen.add(name)
      return [{ name, pushedAt: typeof row.pushed_at === "string" ? row.pushed_at : "" }]
    })
    const statuses = yield* Effect.forEach(candidates, candidate => Effect.gen(function* () {
      const response = yield* read(`/api/user/github-access/${candidate.name.split("/").map(encodeURIComponent).join("/")}?surface=issues`)
      const body: unknown = yield* Effect.promise(() => response.json().catch(() => null))
      return { ...candidate, status: response.status, ok: response.ok, body }
    }), { concurrency: 6 })
    for (const status of statuses) {
      // A repository disappearing from this account during the read is no
      // longer a candidate. Other errors must not masquerade as no install.
      if (status.status === 403 || status.status === 404) continue
      if (!status.ok) return json(status.status, { message: "Smithers Cloud could not verify the GitHub App installation. Try again." })
      const app = status.body
      if (!record(app) || typeof app.verdict !== "string") return refuse("upstream_malformed", "Smithers Cloud returned an unreadable GitHub access diagnosis.")
      if (app.verdict !== "ok" && app.verdict !== "app-not-installed" && typeof app.detail === "string" &&
        (installationId === undefined || String(app.installation_id) === installationId)) blockers.push(app.detail)
      if (app.verdict === "ok" &&
        typeof app.installation_id === "number" && Number.isSafeInteger(app.installation_id) && app.installation_id > 0 &&
        (installationId === undefined || String(app.installation_id) === installationId)) {
        repos.push({ fullName: status.name, pushedAt: status.pushedAt, installationId: app.installation_id })
      }
    }
    // Read every page: another installation (and the rest of the chip menu)
    // may be on a later page even after the active repository is known.
    if (rows.length < 100) return repos.length === 0 && blockers.length > 0 ? refuse("request_conflict", blockers[0] ?? "") : json(200, { repos })
  }
  return refuse(
    "service_temporarily_unavailable",
    "The repository inventory is too large to verify in one request. Try connecting the repository directly."
  )
})
