import { GitHub } from "@smthrs/integrations"
import { Context, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { ResourceLocks, ordered, releaseAll, type Lease, type Resource } from "./resource-locks.ts"

export class PoolUnavailable extends Error {}
/** Injectable fault seam; the live implementation uses the catalog's redacted GitHub client. */
export class ScratchGitHub extends Context.Service<ScratchGitHub, {
  readonly request: (method: "GET" | "POST", path: string, body?: unknown) => Effect.Effect<unknown, unknown>
}>()("e2e/ScratchGitHub") {}
export const scratchGitHubLive = (token: string) => Layer.effect(ScratchGitHub, Effect.gen(function* () {
  const client = yield* GitHub.GitHubClient.make({ token, apiBaseUrl: "https://api.github.com" }, {})
  return { request: client.request }
}).pipe(Effect.provide(FetchHttpClient.layer)))

export type PoolConfig = { readonly login: string; readonly appId: number; readonly size: number }
export const poolConfig = (env: Readonly<Record<string, string | undefined>>): PoolConfig => {
  const login = env.E2E_GITHUB_LOGIN ?? "codeplanesmithers"
  const appId = Number(env.E2E_GITHUB_APP_ID ?? env.GITHUB_APP_ID)
  const size = Number(env.E2E_SCRATCH_POOL_SIZE ?? 4)
  if (!/^[a-zA-Z0-9-]+$/.test(login) || !Number.isSafeInteger(size) || size < 1 || size > 16) throw new Error("Invalid scratch pool login or size (1–16)")
  if (!Number.isSafeInteger(appId) || appId < 1) throw new PoolUnavailable("App identity missing: set E2E_GITHUB_APP_ID to verify the test account's installation")
  return { login, appId, size }
}
export const poolNames = (config: PoolConfig, kind: "stack" | "factory") =>
  Array.from({ length: config.size }, (_, i) => `${config.login}/smithers-e2e-${kind}-${i + 1}`.toLowerCase())

/** Check the actual installation before any write. No installation/permission changes, no inferred App coverage. */
export const verifyPoolAccount = (config: PoolConfig) => Effect.gen(function* () {
  const api = yield* ScratchGitHub
  const person = yield* api.request("GET", "/user") as Effect.Effect<{ login?: string }, unknown>
  if (person.login?.toLowerCase() !== config.login.toLowerCase()) return yield* Effect.fail(new PoolUnavailable("GitHub credential is not the test account"))
  // /user/installations requires the App's user token. A PAT that cannot read this fails closed into configured scratch.
  const result = yield* api.request("GET", "/user/installations?per_page=100") as Effect.Effect<{
    total_count?: number; installations?: Array<{ id: number; app_id: number; account?: { login: string }; repository_selection?: string; suspended_at?: unknown }>
  }, unknown>
  if (!Array.isArray(result.installations) || (result.total_count ?? Infinity) > result.installations.length) return yield* Effect.fail(new PoolUnavailable("Installation list incomplete"))
  const installation = result.installations.find((row) => row.app_id === config.appId && row.account?.login.toLowerCase() === config.login.toLowerCase())
  if (!installation || installation.repository_selection !== "all" || installation.suspended_at != null) return yield* Effect.fail(new PoolUnavailable("Test account App installation is not active with repository_selection=all"))
  return installation.id
})

/** Called only while holding this repository's lease. Reconcile an existing repo; create only on GitHub's 404. */
export const ensureScratchRepository = (repository: string, config: PoolConfig) => Effect.gen(function* () {
  if (![...poolNames(config, "stack"), ...poolNames(config, "factory")].includes(repository)) return yield* Effect.fail(new PoolUnavailable("Not a pool repository"))
  const api = yield* ScratchGitHub
  const existing = yield* api.request("GET", `/repos/${repository}`).pipe(Effect.catch((error) => {
    // IntegrationError keeps the HTTP status as a structured field, never parse its message.
    const status = (error as { status?: number; details?: { status?: number } }).status ?? (error as { details?: { status?: number } }).details?.status
    return status === 404 ? Effect.succeed(undefined) : Effect.fail(error)
  }))
  if (existing === undefined) {
    yield* api.request("POST", "/user/repos", {
      name: repository.split("/")[1], private: false, auto_init: true,
      description: "Smithers production e2e scratch repository",
    })
  }
  // Read the created repository back: POST need not include the authenticated permission projection.
  const answer = existing ?? (yield* api.request("GET", `/repos/${repository}`))
  const repo = answer as { full_name?: string; owner?: { login?: string }; permissions?: { admin?: boolean }; archived?: boolean; default_branch?: string }
  if (repo.full_name?.toLowerCase() !== repository || repo.owner?.login?.toLowerCase() !== config.login.toLowerCase() || repo.permissions?.admin !== true || repo.archived || !repo.default_branch) {
    return yield* Effect.fail(new PoolUnavailable("Scratch repository identity or administration was not verified"))
  }
  // The real TODO picker requires an open issue. This is a test-account fixture in the leased scratch repo,
  // never a work-tracking issue in the product repository. Reconcile first; never repeat an ambiguous POST.
  const issues = yield* api.request("GET", `/repos/${repository}/issues?state=open&per_page=100`) as Effect.Effect<Array<{ pull_request?: unknown }>, unknown>
  if (!Array.isArray(issues)) return yield* Effect.fail(new PoolUnavailable("Scratch issue list was not verified"))
  if (!issues.some((issue) => issue.pull_request === undefined)) {
    yield* api.request("POST", `/repos/${repository}/issues`, { title: "Production e2e fixture", body: "Scratch issue for production e2e TODOs." })
  }
  return repository
})

/** Acquire a complete candidate in global order, releasing partial candidates before waiting or trying another. */
export const leaseRunResources = async (locks: ResourceLocks, fixed: ReadonlyArray<Resource> | ((repositories: ReadonlyArray<string>) => ReadonlyArray<Resource>), pools: ReadonlyArray<ReadonlyArray<string>>) => {
  let candidates: string[][] = [[]]
  for (const pool of pools) {
    if (!pool.length) throw new Error("Empty scratch pool")
    candidates = candidates.flatMap((candidate) => pool.map((repository) => [...candidate, repository]))
  }
  let waiting = false
  for (;;) {
    for (const repositories of candidates) {
      const resources = ordered([...(typeof fixed === "function" ? fixed(repositories) : fixed), ...repositories.map((repository): Resource => ({ name: `repository:${repository.toLowerCase()}`, mode: "write" }))])
      const leases: Lease[] = []
      try {
        for (const resource of resources) {
          const lease = await locks.tryAcquire(resource)
          if (!lease) break
          leases.push(lease)
        }
        if (leases.length === resources.length) return { leases, repositories }
      } catch (error) { await releaseAll(leases); throw error }
      await releaseAll(leases)
    }
    if (!waiting) { locks.log("waiting", (typeof fixed === "function" ? "scratch-pool" : ordered(fixed).map((r) => r.name).join(",")) || "scratch-pool"); waiting = true }
    await locks.pause()
  }
}
