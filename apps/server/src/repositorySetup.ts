import { Effect } from "effect"
import { REPOSITORY_SETUP_API, RepositoryJobSchema, SetupHostInputSchema, SetupOperationSchema } from "@smthrs/rpc/RepositorySetup"
import { ExecutionContext } from "./Environment"
import { isRelayRepoName, type GatewaySessions } from "./gateway"
import { readBoundedJson, type Transport } from "./Http"
import { requireWorkflowSession } from "./workflows"
import type { ServerConfig } from "./Config"
import { SetupRequests, SetupStoreError, type SetupRecord } from "./repositorySetupStore"
import { advanceRepositorySetup, observeRepositorySetup } from "./repositorySetupExecution"
import { publicSetupResult, recoverRepositorySetup } from "./repositorySetupRecovery"

const recordOf = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
const answer = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store" } })
type Services = SetupRequests | GatewaySessions | Transport | ServerConfig

/** Acknowledges durable intent before provisioning, model work, or job completion. */
export const handleRepositorySetup = (request: Request): Effect.Effect<Response, never, Services | ExecutionContext> => Effect.gen(function* () {
  const session = yield* requireWorkflowSession(request)
  if (session instanceof Response) return session
  const url = new URL(request.url)
  const part = url.pathname.slice(REPOSITORY_SETUP_API.length + 1)
  const requests = yield* SetupRequests
  if (request.method === "GET" && part === "state") {
    const repo = url.searchParams.get("repo") ?? "", job = RepositoryJobSchema.safeParse(url.searchParams.get("job"))
    if (!isRelayRepoName(repo) || !job.success) return answer(400, { message: "Choose a repository setup" })
    return answer(200, yield* recoverRepositorySetup(session.login, repo, job.data))
  }
  let record: SetupRecord | undefined
  if (request.method === "POST") {
    const operation = SetupOperationSchema.safeParse(part)
    if (!operation.success) return answer(404, { message: "Unknown setup operation" })
    const raw = yield* readBoundedJson(request, 64_000).pipe(Effect.catch(() => Effect.succeed(undefined)))
    const decoded = SetupHostInputSchema.safeParse({ ...recordOf(raw), operation: operation.data })
    if (!decoded.success || !isRelayRepoName(decoded.data.repo)) return answer(400, { message: "Choose a repository and a valid setup draft" })
    record = yield* requests.create(session.login, decoded.data)
    if (record.observationError && !record.result) record = yield* requests.update(session.login, record, { ...record, observationError: undefined })
  } else if (request.method === "GET" && (part === "request" || part === "observe")) {
    const requestId = url.searchParams.get("requestId") ?? ""
    if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(requestId)) return answer(400, { message: "Choose a setup request" })
    record = yield* requests.read(session.login, requestId)
    if (!record || record.input.repo !== url.searchParams.get("repo") || record.input.job !== url.searchParams.get("job")) return answer(404, { message: "Setup request not found" })
    if (part === "observe") {
      if (!record.result) yield* observeRepositorySetup(session.login, requestId)
      record = (yield* requests.read(session.login, requestId))!
      return record.observationError ? answer(503, { message: record.observationError }) : answer(record.result ? 200 : 202, publicSetupResult(record))
    }
  } else return answer(405, { message: "Method not allowed" })
  if (!record.result) {
    const context = yield* Effect.context<Services>()
    yield* (yield* ExecutionContext).waitUntil(advanceRepositorySetup(session.login, record.input.requestId).pipe(Effect.provide(context)))
  }
  return record.observationError ? answer(503, { message: record.observationError }) : answer(record.result ? 200 : 202, publicSetupResult(record))
}).pipe(Effect.catch(error => Effect.succeed(answer(error instanceof SetupStoreError ? error.status ?? 503 : 503, { message: error.message }))))
