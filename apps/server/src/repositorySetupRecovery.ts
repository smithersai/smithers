import { Data, Effect } from "effect"
import { z } from "zod"
import { RepositoryJobSchema, SetupDraftSchema, setupCandidate, type RepositoryJob, type SetupRecoveryResponse } from "@smthrs/rpc/RepositorySetup"
import { ServerConfig } from "./Config"
import { fetchCloudToken } from "./gateway"
import { discardBody, fetchWithDeadline, readBoundedJson } from "./Http"
import { SetupRequests, type SetupRecord } from "./repositorySetupStore"

class RecoveryError extends Data.TaggedError("RecoveryError")<{ readonly message: string }> {}
const fail = (message: string) => Effect.fail(new RecoveryError({ message }))

export const publicSetupResult = (record: SetupRecord) => ({
  ...(record.result ?? { requestId: record.input.requestId, revision: record.input.revision, digest: record.input.digest, receipt: record.receipt }),
  ...((record.binding?.workspaceId ?? record.workspaceId) ? { workspaceId: record.binding?.workspaceId ?? record.workspaceId } : {})
})

const RegistrationRow = z.object({ id: z.string().min(1), workspace_id: z.string().uuid(), user_id: z.number().int().positive(),
  job: z.string(), mode: z.enum(["enabled", "trial"]), revision: z.number().int().positive(), digest: z.string().regex(/^[0-9a-f]{64}$/),
  source_revision: z.string().min(1), flow_id: z.string(), enabled: z.boolean(),
  schedule: z.string().max(200).default(""), next_fire_at: z.iso.datetime({ offset: true }).nullish(), configuration: z.object({
    repo: z.string(), workspace_id: z.string().uuid(), source_revision: z.string().min(1), flow_id: z.string(), mode: z.enum(["enabled", "trial"]), revision: z.number().int().positive(), digest: z.string(), input: SetupDraftSchema,
    schedule: z.string().max(200).default("")
  })
})

/** A row naming another job belongs to a registration kind this Worker does not project; a row naming one of ours is always ours to interpret. */
const RegistrationKind = z.object({ job: RepositoryJobSchema })
const KNOWN_REGISTRATION_LIMIT = 50

/** The authenticated Cloud user id, never a browser claim, owns the gateway binding. */
const registrations = (login: string, repo: string, job: RepositoryJob): Effect.Effect<SetupRecoveryResponse["registration"], never, ServerConfig | import("./Http").Transport> => Effect.gen(function* () {
  const config = yield* ServerConfig
  const read = (path: string, limit: number) => Effect.gen(function* () {
    let token = yield* fetchCloudToken(login)
    if (token.status !== "ok") return yield* fail("Repository registration authentication is unavailable")
    const call = (value: string) => fetchWithDeadline("Repository registrations", new URL(path, config.cloudApiBaseUrl), {
      headers: { authorization: `Bearer ${value}` }
    }, config.upstreamTimeoutMs)
    let response = yield* call(token.token)
    if (response.status === 401) {
      yield* discardBody(response)
      token = yield* fetchCloudToken(login)
      if (token.status !== "ok") return yield* fail("Repository registration authentication is unavailable")
      response = yield* call(token.token)
    }
    if (!response.ok) { yield* discardBody(response); return yield* fail(`Repository registrations answered HTTP ${response.status}`) }
    return yield* readBoundedJson(response, limit).pipe(Effect.timeoutOrElse({ duration: config.upstreamTimeoutMs, orElse: () => fail("Repository registration response timed out") }))
  })
  const [identity, raw] = yield* Effect.all([read("/api/user", 16_000), read(`/api/repos/${repo}/repository-jobs`, 1_500_000)], { concurrency: "unbounded" })
  const user = z.object({ id: z.number().int().positive() }).safeParse(identity)
  const body = z.array(z.unknown()).safeParse(raw ?? [])
  if (!user.success || !body.success) return yield* fail("Repository registration state is invalid")
  const mine = body.data.filter(candidate => RegistrationKind.safeParse(candidate).data?.job === job)
  if (mine.length > KNOWN_REGISTRATION_LIMIT) return yield* fail("Repository registrations exceed the recovery limit")
  const result: Extract<SetupRecoveryResponse["registration"], { state: "known" }> = { state: "known" }
  for (const candidate of mine) {
    const parsed = RegistrationRow.safeParse(candidate)
    if (!parsed.success) return yield* fail("Repository registration state is invalid")
    const row = parsed.data
    const field = row.mode === "enabled" ? "active" : "trial"
    const value = row.configuration
    if (result[field] || row.flow_id !== `repository-jobs/${job}` || value.repo !== repo || value.workspace_id !== row.workspace_id
      || value.source_revision !== row.source_revision || value.flow_id !== row.flow_id || value.mode !== row.mode || value.revision !== row.revision || value.digest !== row.digest || setupCandidate({ repo, job, revision: row.revision, draft: value.input }) !== row.digest) return yield* fail("Repository registration identity is inconsistent")
    if (row.schedule !== value.schedule || (row.mode === "enabled" && job === "chores" && row.schedule !== value.input.schedule)) return yield* fail("Repository schedule does not match its registration")
    result[field] = { registrationId: row.id, workspaceId: row.workspace_id, revision: row.revision, digest: row.digest,
      sourceRevision: row.source_revision, enabled: row.enabled, owned: row.user_id === user.data.id, draft: value.input,
      ...(job === "chores" && row.mode === "enabled" && row.enabled && row.schedule && row.next_fire_at
        ? { schedule: { expression: row.schedule, nextFireAt: new Date(row.next_fire_at).toISOString() } } : {}) }
  }
  return result
}).pipe(Effect.catch(error => Effect.succeed({ state: "unavailable", error: error instanceof RecoveryError ? error.message : "Repository registration state is unavailable" } as const)))

/** Discovery reads policy and stored input only. It cannot provision or execute a host. */
export const recoverRepositorySetup = (login: string, repo: string, job: RepositoryJob) => Effect.gen(function* () {
  const registration = yield* registrations(login, repo, job)
  const active = registration.state === "known" && registration.active?.owned ? registration.active : undefined
  const requests = yield* SetupRequests
  const stored = yield* requests.discover(login, repo, job, active).pipe(Effect.catch(() => Effect.succeed({ state: "unavailable", error: "Setup recovery storage is unavailable" } as const)))
  const setup: SetupRecoveryResponse["setup"] = stored.state === "found" ? {
    state: "found", input: stored.record.input, result: publicSetupResult(stored.record),
    ...(stored.record.observationError ? { observationError: stored.record.observationError } : {})
  } : stored
  return { owner: login, repo, job, registration, setup } satisfies SetupRecoveryResponse
})
