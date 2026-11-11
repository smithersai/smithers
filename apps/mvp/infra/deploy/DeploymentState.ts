/**
 * Alchemy's bundle hash is a local cache, not evidence of what serves traffic.
 * Attach a live Worker version to completed state writes; invalidate that cache
 * when a rollback or an interrupted publication leaves another version live.
 * Resource identities, bindings and generated secrets are retained.
 */
import { type PersistedState, State, StateStoreError, type StateService } from "alchemy/State"
import { Config, Context, Effect, Layer, Metric, Redacted } from "effect"

export class DeploymentVersions extends Context.Service<DeploymentVersions, {
  readonly current: (account: string, worker: string) => Effect.Effect<string | undefined, StateStoreError>
}>()("mvp/DeploymentVersions") {}

const invalidations = Metric.counter("deploy_state_invalidations")
const reads = Metric.counter("deploy_state_reads")

/** Read-only API boundary. Neither response bodies nor credentials enter a diagnostic. */
export const deploymentVersionsLive = Layer.effect(DeploymentVersions, Effect.gen(function*() {
  const token = yield* Config.Redacted("CLOUDFLARE_API_TOKEN")
  return DeploymentVersions.of({
    current: (account, worker) => Effect.tryPromise({
      try: async () => {
        const response = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/workers/scripts/${encodeURIComponent(worker)}/deployments`,
          { headers: { authorization: `Bearer ${Redacted.value(token)}` }, signal: AbortSignal.timeout(30_000) }
        )
        if (response.status === 404) return undefined
        if (!response.ok) throw new Error("deployment read failed")
        const body = await response.json() as {
          success?: boolean
          result?: { deployments?: Array<{
            created_on: string
            versions: Array<{ version_id: string; percentage: number }>
          }> }
        }
        if (body.success !== true) throw new Error("deployment read failed")
        const latest = [...(body.result?.deployments ?? [])].sort((a, b) => b.created_on.localeCompare(a.created_on))[0]
        const version = latest?.versions[0]
        if (latest?.versions.length !== 1 || version?.percentage !== 100 || !version.version_id) {
          throw new Error("deployment has no single live version")
        }
        return version.version_id
      },
      catch: () => new StateStoreError({
        message: "Cannot verify a Worker's live deployment. Check deployment-read permission and require one version at 100%."
      })
    })
  })
}))

/** Version workers, previews, dispatch scripts and local dev are separate resources. */
const tracked = (row: PersistedState | undefined) =>
  row?.kind !== "action" && row !== undefined &&
  ["Cloudflare.Worker", "Cloudflare.Workers.Worker"].includes(row.resourceType) &&
  row.providerMode !== "local" && row.attr?.workerName &&
  row.attr?.accountId && !row.attr.namespace && !row.attr.versionOf && !row.attr.previewOf

/** Decorate the existing store; reads stay read-only, including under alchemy plan. */
export const reconcileStore = (store: StateService, versions: typeof DeploymentVersions.Service): StateService => ({
  ...store,
  get: (request) => Effect.gen(function*() {
    const row = yield* store.get(request)
    if (!tracked(row) || row?.kind === "action" || !row?.attr?.hash) return row
    yield* Metric.update(reads, 1)
    const recorded: unknown = row.attr.hash.deploymentVersion
    const live = yield* versions.current(row.attr.accountId, row.attr.workerName)
    if (recorded !== undefined && recorded === live) return row
    yield* Metric.update(invalidations, 1)
    yield* Effect.logInfo("deploy.state.invalidated").pipe(Effect.annotateLogs({
      resource: row.logicalId, reason: recorded === undefined ? "untracked" : "live-version-changed"
    }))
    // A missing hash forces the provider's normal update path. Keeping the
    // resource record avoids adoption, replacement, or Durable Object deletion.
    return { ...row, attr: { ...row.attr, hash: undefined } }
  }).pipe(Effect.withSpan("deploy.state.read")),
  set: (request) => Effect.gen(function*() {
    const row = request.value
    if (!tracked(row) || row.kind === "action" ||
      !["created", "updated"].includes(row.status) || !row.attr?.hash) return yield* store.set(request)
    const deploymentVersion = yield* versions.current(row.attr.accountId, row.attr.workerName)
    if (!deploymentVersion || row.attr.versionId !== deploymentVersion) {
      return yield* new StateStoreError({
        message: "A Worker's published version is not live. Refusing to cache candidate content after a rollback or interrupted publication."
      })
    }
    const value = { ...row, attr: { ...row.attr, hash: { ...row.attr.hash, deploymentVersion } } }
    yield* Effect.logInfo("deploy.state.recorded").pipe(Effect.annotateLogs({ resource: row.logicalId }))
    return yield* store.set({ ...request, value })
  }).pipe(Effect.withSpan("deploy.state.write"))
})

/** Wrap Cloudflare's real state layer. Tests provide the real in-memory store and a faulty version service. */
export const reconciledState = <E, R>(base: Layer.Layer<State, E, R>) => Layer.effect(
  State,
  Effect.gen(function*() {
    const store = yield* yield* State
    const versions = yield* DeploymentVersions
    return Effect.succeed(reconcileStore(store, versions))
  })
).pipe(Layer.provide(base), Layer.provide(deploymentVersionsLive), Layer.orDie)
