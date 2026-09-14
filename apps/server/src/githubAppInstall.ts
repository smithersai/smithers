import * as Effect from "effect/Effect"
import { handlePlatformProxy } from "./proxies"
import { json, refuse } from "./Responses"

export const INSTALLATIONS_PATH = "/api/user/github-app/installations"
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** Verify against the caller's GitHub inventory and live App/user access diagnosis.
 * The callback id is a filter, never permission to read someone else's install.
 */
export const handleGitHubAppInstall = (request: Request, installationId?: string) => Effect.gen(function* () {
  const read = (path: string) => {
    const url = new URL(path, request.url)
    return handlePlatformProxy(new Request(url, { headers: request.headers }), url)
  }
  const repos: Array<{ fullName: string; pushedAt: string }> = []
  const seen = new Set<string>()
  const blockers: string[] = []
  for (let page = 1; page <= 10; page++) {
    const inventory = yield* read(`/api/user/github-repos?sort=pushed&direction=desc&per_page=100&page=${page}`)
    if (!inventory.ok) return inventory
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
        repos.push({ fullName: status.name, pushedAt: status.pushedAt })
      }
    }
    // Live inventory is sorted by most recently pushed. Once a page has a
    // verified candidate, later pages cannot improve the tutorial choice.
    if (repos.length > 0) return json(200, { repos })
    if (rows.length < 100) return blockers.length > 0 ? refuse("request_conflict", blockers[0] ?? "") : json(200, { repos })
  }
  return refuse(
    "service_temporarily_unavailable",
    "The repository inventory is too large to verify in one request. Try connecting the repository directly."
  )
})
