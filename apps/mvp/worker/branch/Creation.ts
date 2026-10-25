import { digestSync } from "@smthrs/crypto"
import type { CodeStorage } from "@smthrs/effect-code-storage"
import { RealmFlow } from "@smthrs/harness"
import { Load, Manifest } from "@smthrs/plugin"
import { Data, Effect, type Layer, Metric, Option, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import type { SqlClient } from "effect/sql"
import { CREATION_ACTIONS, type CreationSelection } from "../../src/features/branch/creation.ts"
import { readSource } from "../../src/features/flows-ui/checks.ts"
import { isRepository, repoId } from "../../src/features/repo/contract.ts"
import { CREATION } from "../../src/plugins/builtinFlows.ts"
import { Sessions } from "../Actor.ts"
import { isMemberOn } from "./Access.ts"
import { homeRepositoryNames } from "./Conversations.ts"
import { defaultBranch } from "./Forge.ts"

export class CreationRefused extends Data.TaggedError("CreationRefused")<{
  readonly code: "invalid" | "unavailable"
}> {}

const Config = Schema.Struct({ plugin: Manifest.PluginId, flow: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,39}$/)) })
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
): Effect.Effect<CreationSelection, CreationRefused> => Effect.gen(function* () {
  const read = (path: string) => client!.readFile(repoId(repository.owner, repository.name), { path, ref: revision, maxBytes: 65_536 }).pipe(
    Effect.flatMap(({ bytes }) => Effect.try({ try: () => textOf(bytes), catch: invalid })),
    Effect.catchTag("@smthrs/effect-code-storage/CodeStorageError", (error) =>
      error.code === "not_found" ? Effect.succeed(undefined) : Effect.fail(new CreationRefused({ code: "unavailable" }))),
  )
  const configText = client === undefined ? undefined : yield* read(".smithers/branch.json")
  let manifest: unknown = CREATION.manifest
  let source: string = CREATION.source
  let tag: string = CREATION.tag
  if (configText !== undefined) {
    const config = yield* decodeConfig(configText).pipe(Effect.mapError(invalid))
    tag = `${config.plugin}/${config.flow}`
    const manifestText = yield* read(`.smithers/plugins/${config.plugin}/plugin.json`)
    const flowSource = yield* read(`.smithers/flows/${tag}/flow.ts`)
    if (manifestText === undefined || flowSource === undefined) return yield* invalid()
    manifest = yield* Effect.try({ try: () => JSON.parse(manifestText) as unknown, catch: invalid })
    source = flowSource
    const checked = yield* Manifest.decode(manifest).pipe(Effect.mapError(invalid))
    if (checked.id !== config.plugin || !checked.owns?.includes(config.flow)) return yield* invalid()
  }
  const checked = yield* Manifest.decode(manifest).pipe(Effect.mapError(invalid))
  const metadata = readSource(source, tag)
  if (metadata.tag !== tag || metadata.warnings.length > 0) return yield* invalid()
  const loaded = yield* Load.load({
    api: Manifest.PLUGIN_API, points: ["flows"], catalog: facts, queries: new Map(),
    tierCap: { "built-in": (cap) => cap === "git:write", repository: creationCapability, personal: creationCapability },
  }, [{
    tier: configText === undefined ? "built-in" : "repository", manifest,
    flows: [{ tag, capabilities: checked.capabilities, minimum: "member", personOnly: false, system: false, modelInvocable: true }],
  }])
  if (loaded.refused.length > 0) return yield* invalid()
  const allowed = checked.uses ?? []
  return { ...repository, tag, source, digest: digestSync(source), revision, runtime: RealmFlow.version, allowed }
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
    const selected = yield* select(Option.getOrUndefined(client), { owner, name }, head?.sha ?? "builtin")
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
