import type { SeamContext } from "./SeamContext"

export interface InstalledRepository {
  readonly fullName: string
  readonly pushedAt: string
  readonly installationId: number
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The callback id only filters the caller's canonical GitHub inventory. */
export const readInstalledRepositories = async (
  ctx: Pick<SeamContext, "http" | "baseUrl">,
  installationId: string | undefined,
  current: () => boolean
): Promise<{ readonly repos: InstalledRepository[] } | { readonly response: Response } | undefined> => {
  const repos: InstalledRepository[] = []
  const seen = new Set<string>()
  const blockers: string[] = []
  for (let page = 1; page <= 10 && current(); page++) {
    const response = await ctx.http(`${ctx.baseUrl}/api/user/github-repos?sort=pushed&direction=desc&per_page=100&page=${page}`)
    if (!current()) { await response.body?.cancel(); return }
    if (!response.ok) return { response }
    const body: unknown = await response.json()
    const rows = Array.isArray(body) ? body : record(body) && Array.isArray(body.repos) ? body.repos : record(body) && Array.isArray(body.items) ? body.items : undefined
    if (rows === undefined) throw new Error("Smithers returned an unreadable repository list")
    const candidates = rows.flatMap(row => {
      if (!record(row) || typeof row.full_name !== "string" || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(row.full_name) || seen.has(row.full_name)) return []
      seen.add(row.full_name)
      return [{ fullName: row.full_name, pushedAt: typeof row.pushed_at === "string" ? row.pushed_at : "" }]
    })
    for (let start = 0; start < candidates.length && current(); start += 6) {
      const statuses = await Promise.all(candidates.slice(start, start + 6).map(async candidate => ({
        ...candidate,
        response: await ctx.http(`${ctx.baseUrl}/api/user/github-access/${candidate.fullName.split("/").map(encodeURIComponent).join("/")}?surface=issues`)
      })))
      if (!current()) { await Promise.all(statuses.map(status => status.response.body?.cancel())); return }
      for (const status of statuses) {
        if (status.response.status === 403 || status.response.status === 404) { await status.response.body?.cancel(); continue }
        if (!status.response.ok) return { response: status.response }
        const access: unknown = await status.response.json()
        if (!record(access) || typeof access.verdict !== "string") throw new Error("Smithers returned an unreadable GitHub access diagnosis")
        if (installationId !== undefined && String(access.installation_id) !== installationId) continue
        if (access.verdict === "ok" && typeof access.installation_id === "number" && Number.isSafeInteger(access.installation_id) && access.installation_id > 0) {
          repos.push({ fullName: status.fullName, pushedAt: status.pushedAt, installationId: access.installation_id })
        } else if (access.verdict !== "app-not-installed" && typeof access.detail === "string") blockers.push(access.detail)
      }
    }
    if (!current()) return
    if (rows.length < 100) {
      if (repos.length === 0 && blockers.length > 0) throw new Error(blockers[0])
      return { repos }
    }
  }
  if (current()) throw new Error("The repository inventory is too large to verify. Connect the repository directly.")
}
