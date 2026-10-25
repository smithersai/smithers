import { digestSync } from "@smthrs/crypto"
import type { CodeStorage } from "@smthrs/effect-code-storage"
import { RealmFlow } from "@smthrs/harness"
import { Load, Manifest } from "@smthrs/plugin"
import { Data, Effect, type Layer, Metric, Option, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import type { SqlClient } from "effect/sql"
import { BRANCH_OPERATIONS, type BranchOperation, CREATION_ACTIONS, type CreationSelection, OPERATION_ACTIONS } from "../../src/features/branch/creation.ts"
import { readSource } from "../../src/features/flows-ui/checks.ts"
import { isRepository, repoId } from "../../src/features/repo/contract.ts"
import { BRANCH_FLOWS } from "../../src/plugins/builtinFlows.ts"
import { Sessions } from "../Actor.ts"
import { isMemberOn } from "./Access.ts"
import { homeRepositoryNames } from "./Conversations.ts"
import { defaultBranch } from "./Forge.ts"

export class CreationRefused extends Data.TaggedError("CreationRefused")<{
  readonly code: "invalid" | "unavailable"
}> {}

const FlowName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,39}$/))
/**
 * `.smithers/branch.json`: the plugin, and the flow it owns for each operation it replaces: `flow` creates, `publish`
 * publishes, `update` updates. An operation it names no flow for runs the first-party `branches` plugin's.
 */
const Config = Schema.Struct({
  plugin: Manifest.PluginId,
  flow: Schema.optional(FlowName),
  publish: Schema.optional(FlowName),
  update: Schema.optional(FlowName),
})
const invalid = () => new CreationRefused({ code: "invalid" })
const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(Config))
const textOf = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes)
const creationCapability = (capability: string) => Object.values(CREATION_ACTIONS).includes(capability as never)
const facts = new Map(Object.entries(CREATION_ACTIONS).map(([name, capability]) => [name, {
  capabilities: [capability], minimum: "member" as const, personOnly: false, system: true,
}]))

/** Reads all installation bytes at one commit; neither discovery nor manifest loading runs repository code. */
export const select = (
  client: CodeStorage.Client | undefined,
  repository: { readonly owner: string; readonly name: string },
  revision: string,
  operation: BranchOperation = "create",
): Effect.Effect<CreationSelection, CreationRefused> => Effect.gen(function* () {
  const read = (path: string) => client!.readFile(repoId(repository.owner, repository.name), { path, ref: revision, maxBytes: 65_536 }).pipe(
    Effect.flatMap(({ bytes }) => Effect.try({ try: () => textOf(bytes), catch: invalid })),
    Effect.catchTag("@smthrs/effect-code-storage/CodeStorageError", (error) =>
      error.code === "not_found" ? Effect.succeed(undefined) : Effect.fail(new CreationRefused({ code: "unavailable" }))),
  )
  const configText = client === undefined ? undefined : yield* read(".smithers/branch.json")
  const builtin = BRANCH_FLOWS[operation]
  let manifest: unknown = builtin.manifest
  let source: string = builtin.source
  let tag: string = builtin.tag
  const config = configText === undefined ? undefined : yield* decodeConfig(configText).pipe(Effect.mapError(invalid))
  const flow = config === undefined ? undefined : operation === "create" ? config.flow : config[operation]
  if (config !== undefined && flow !== undefined) {
    tag = `${config.plugin}/${flow}`
    const manifestText = yield* read(`.smithers/plugins/${config.plugin}/plugin.json`)
    const flowSource = yield* read(`.smithers/flows/${tag}/flow.ts`)
    if (manifestText === undefined || flowSource === undefined) return yield* invalid()
    manifest = yield* Effect.try({ try: () => JSON.parse(manifestText) as unknown, catch: invalid })
    source = flowSource
    const checked = yield* Manifest.decode(manifest).pipe(Effect.mapError(invalid))
    if (checked.id !== config.plugin || !checked.owns?.includes(flow)) return yield* invalid()
  }
  const checked = yield* Manifest.decode(manifest).pipe(Effect.mapError(invalid))
  const metadata = readSource(source, tag)
  if (metadata.tag !== tag || metadata.warnings.length > 0) return yield* invalid()
  const loaded = yield* Load.load({
    api: Manifest.PLUGIN_API, points: ["flows"], catalog: facts, queries: new Map(),
    tierCap: { "built-in": creationCapability, repository: creationCapability, personal: creationCapability },
  }, [{
    tier: flow === undefined ? "built-in" : "repository", manifest,
    flows: [{ tag, capabilities: checked.capabilities, minimum: "member", personOnly: false, system: false, modelInvocable: true }],
  }])
  if (loaded.refused.length > 0) return yield* invalid()
  // A flow may call only its own operation's host actions, whatever else its plugin uses.
  const allowed = (checked.uses ?? []).filter((action) => OPERATION_ACTIONS[operation].includes(action as never))
  // A creation's selection reads as it did before Publish existed, so a journaled one resumes unchanged.
  return { ...repository, tag, source, digest: digestSync(source), revision, runtime: RealmFlow.version, allowed,
    ...(operation === "create" ? {} : { operation }) }
})

export const selections = Metric.counter("smithers_branch_creation_selections", { incremental: true })

/**
 * The browser's journaled selection step; only a Member or above on the repository may request an installation.
 * `database` opens a Postgres client for the role check.
 */
export const route = <E, R>(client: Option.Option<CodeStorage.Client>, database: Layer.Layer<SqlClient.SqlClient, E, R>) => Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  let stage = "request"
  let failure: Record<string, string | number> = {}
  const refused = (error: { readonly _tag: string; readonly code: string; readonly status?: number }, status: number) => Effect.sync(() => {
    failure = { stage, errorTag: error._tag, errorCode: error.code,
      ...(error.status === undefined ? {} : { upstreamStatus: error.status }) }
    return HttpServerResponse.empty({ status })
  })
  const answer = yield* Effect.gen(function* () {
    if (request.method !== "GET") return HttpServerResponse.empty({ status: 405, headers: { allow: "GET" } })
    stage = "session"
    const actor = yield* (yield* Sessions).resolve
    if (Option.isNone(actor)) return HttpServerResponse.empty({ status: 401 })
    stage = "repository"
    const query = new URL(request.url, "http://app").searchParams
    const operation = query.get("operation") ?? "create"
    if (!BRANCH_OPERATIONS.includes(operation as never)) return HttpServerResponse.empty({ status: 400 })
    const home = yield* homeRepositoryNames
    const owner = query.get("owner") ?? home.owner
    const name = query.get("name") ?? home.name
    if (!isRepository(owner, name) || query.has("owner") !== query.has("name")) return HttpServerResponse.empty({ status: 400 })
    // A Member or above on the repository itself (decision 0079).
    stage = "role"
    const member = yield* isMemberOn(actor, repoId(owner, name)).pipe(
      Effect.provide(database),
      Effect.mapError(() => new CreationRefused({ code: "unavailable" })),
    )
    if (!member) return HttpServerResponse.empty({ status: 403 })
    // Without Code Storage there is no installed repository code; the ordinary default still refuses its write.
    stage = "head"
    const head = Option.isNone(client) ? undefined : yield* defaultBranch({ owner, name })
    stage = "installation"
    const selected = yield* select(Option.getOrUndefined(client), { owner, name }, head?.sha ?? "builtin", operation as BranchOperation)
    return HttpServerResponse.jsonUnsafe(selected, { headers: { "cache-control": "no-store" } })
  }).pipe(
    Effect.catchTags({
      CreationRefused: (error) => refused(error, error.code === "invalid" ? 400 : 503),
      "@smthrs/effect-code-storage/GitRemoteError": (error) => refused(error,
        error.code === "not_found" || error.code === "empty" ? 404 : 503),
    }),
    // Defects and unexpected failures remain unavailable; never log their message or raw cause.
    Effect.catchCause(() => refused({ _tag: "unexpected", code: "unexpected" }, 503)),
  )
  yield* Metric.update(Metric.withAttributes(selections, { status: String(answer.status) }), 1)
  yield* Effect.logInfo("branch.creation.select").pipe(Effect.annotateLogs({ status: answer.status, ...failure }))
  yield* Effect.annotateCurrentSpan({ "http.response.status_code": answer.status, ...failure })
  return answer
}).pipe(Effect.withSpan("branch.creation.select", { kind: "server" }))
