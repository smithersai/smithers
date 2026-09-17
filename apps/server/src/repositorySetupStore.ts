import { Context, Data, Effect, Layer, Semaphore } from "effect"
import { z } from "zod"
import { SetupHostInputSchema, SetupOperationResponseSchema, SetupReceiptSchema, type SetupHostInput } from "@smthrs/rpc/RepositorySetup"
import { DurableStorage, namespaceCall, type NativeNamespace } from "./DurableStorage"
import { readBoundedJson, readJsonOrUndefined } from "./Http"

export class SetupStoreError extends Data.TaggedError("SetupStoreError")<{ readonly message: string; readonly status?: number }> {}
export const SetupPlanSchema = z.object({ planId: z.string().min(1), flowId: z.literal("repository/setup"), digest: z.string().min(1),
  executionDigest: z.string().min(1), envelope: z.object({ capabilities: z.array(z.string()), flows: z.array(z.string()),
    budget: z.object({ tokens: z.number().int().positive().max(200_000), milliseconds: z.number().int().positive().max(7_200_000) }), host: z.string().optional() }) })
export const SetupRecordSchema = z.object({ version: z.number().int().nonnegative(), input: SetupHostInputSchema,
  workspaceId: z.string().uuid().optional(),
  binding: z.object({ gatewayId: z.string().min(1), workspaceId: z.string().uuid().optional() }).optional(),
  plan: SetupPlanSchema.optional(), runId: z.string().min(1).optional(), receipt: SetupReceiptSchema,
  result: SetupOperationResponseSchema.optional(), observationError: z.string().max(1000).optional(),
  resultPendingSince: z.number().int().nonnegative().optional() })
export type SetupRecord = z.infer<typeof SetupRecordSchema>
const KeySchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9:_-]+$/)
const CommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), login: z.string().min(1).max(100), input: SetupHostInputSchema }),
  z.object({ action: z.literal("read"), requestId: KeySchema }),
  z.object({ action: z.literal("update"), requestId: KeySchema, expectedVersion: z.number().int().nonnegative(), record: SetupRecordSchema })
])
type Command = z.infer<typeof CommandSchema>
const key = (id: string) => `repository-setup:request:${id}`
export const SETUP_QUEUE_KEY = "repository-setup:pending"
export interface SetupQueue { readonly login: string; readonly requests: Record<string, number> }
const sameInput = (a: SetupHostInput, b: SetupHostInput, resolvedWorkspace?: string) => a.repo === b.repo && a.job === b.job && a.operation === b.operation
  && a.digest === b.digest && a.revision === b.revision && JSON.stringify(a.manual) === JSON.stringify(b.manual) && (a.workspaceId === b.workspaceId ||
    (a.workspaceId === undefined && resolvedWorkspace !== undefined && b.workspaceId === resolvedWorkspace))

/** One lock per existing GatewaySessionRegistry object, never per HTTP request. */
export class SetupStorageMutex extends Context.Service<SetupStorageMutex, Semaphore.Semaphore>()("smithers-server/SetupStorageMutex") {}
export const setupStorageMutexLayer = () => Layer.succeed(SetupStorageMutex, Semaphore.makeUnsafe(1))

/** Internal storage door. The public route supplies the validated login as the object identity. */
export const repositorySetupStorageRequest = (request: Request) => Effect.gen(function* () {
  const decoded = CommandSchema.safeParse(yield* readJsonOrUndefined(request))
  if (!decoded.success) return Response.json({ message: "Invalid setup storage command" }, { status: 400 })
  const command = decoded.data
  const storage = yield* DurableStorage
  const lock = yield* SetupStorageMutex
  return yield* Effect.gen(function* () {
    const id = command.action === "create" ? command.input.requestId : command.requestId
    const old = yield* storage.get<SetupRecord>(key(id))
    if (command.action === "read") return Response.json({ record: old ?? null })
    const queue = (yield* storage.get<SetupQueue>(SETUP_QUEUE_KEY)) ?? { login: command.action === "create" ? command.login : "", requests: {} }
    const enqueue = () => Effect.gen(function* () {
      if (command.action !== "create" || old?.result) return
      if (queue.login !== command.login) return yield* Effect.fail(new SetupStoreError({ status: 409, message: "The setup owner cannot change" }))
      if (!Object.hasOwn(queue.requests, id) && Object.keys(queue.requests).length >= 100) return yield* Effect.fail(new SetupStoreError({ status: 429, message: "Too many setup requests are still pending" }))
      // Schedule before admitting work. A crash between the two writes leaves
      // at most an empty queue item; the alarm removes it without launching.
      if (storage.setAlarm) yield* storage.setAlarm(Date.now() + 5_000)
      yield* storage.put(SETUP_QUEUE_KEY, { ...queue, requests: { ...queue.requests, [id]: Date.now() + 86_400_000 } })
    })
    if (command.action === "create" && old) {
      if (!sameInput(old.input, command.input, old.workspaceId ?? old.binding?.workspaceId)) return Response.json({ message: "This request id already names another setup operation" }, { status: 409 })
      yield* enqueue()
      return Response.json({ record: old })
    }
    if (command.action === "update") {
      if (!old || !sameInput(old.input, command.record.input) || command.record.input.requestId !== id) return Response.json({ message: "The setup request identity cannot change" }, { status: 409 })
      if (old.version !== command.expectedVersion || old.result) return Response.json({ record: old })
    }
    const record: SetupRecord = command.action === "create" ? { version: 0, input: command.input, receipt: {
      requestId: id, revision: command.input.revision, digest: command.input.digest, operation: command.input.operation,
      phase: "queued", updatedAt: Date.now(), results: [], evidence: []
    } } : { ...command.record, version: old!.version + 1 }
    // A single Durable Object value has a byte limit. Refuse before writing
    // rather than losing the receipt for work already admitted.
    if (new TextEncoder().encode(JSON.stringify(record)).byteLength > 120_000) return Response.json({ message: "The setup record is too large; use artifact references for detailed output" }, { status: 413 })
    yield* enqueue()
    yield* storage.put(key(id), record)
    if (record.result && Object.hasOwn(queue.requests, id)) {
      const remaining = { ...queue.requests }; delete remaining[id]
      yield* storage.put(SETUP_QUEUE_KEY, { ...queue, requests: remaining })
    }
    return Response.json({ record })
  }).pipe(lock.withPermits(1), Effect.catchTag("SetupStoreError", error => Effect.succeed(Response.json({ message: error.message }, { status: error.status ?? 503 }))))
})

/** Expiration stops observation, never claims that an unseen host execution stopped. */
export const pendingSetupRequests = () => Effect.gen(function* () {
  const storage = yield* DurableStorage
  const lock = yield* SetupStorageMutex
  return yield* Effect.gen(function* () {
    const queue = yield* storage.get<SetupQueue>(SETUP_QUEUE_KEY)
    if (!queue) return undefined
    const requests: Record<string, number> = {}
    for (const [id, expiresAt] of Object.entries(queue.requests)) {
      const record = yield* storage.get<SetupRecord>(key(id))
      if (!record || record.result) continue
      if (expiresAt > Date.now()) requests[id] = expiresAt
      else yield* storage.put(key(id), { ...record, version: record.version + 1, observationError: "Setup observation expired. Retry to reconnect." })
    }
    const pending = { ...queue, requests }
    yield* storage.put(SETUP_QUEUE_KEY, pending)
    if (Object.keys(requests).length && storage.setAlarm) yield* storage.setAlarm(Date.now() + 5_000)
    return pending
  }).pipe(lock.withPermits(1))
})

export interface SetupRequestsShape {
  readonly create: (login: string, input: SetupHostInput) => Effect.Effect<SetupRecord, SetupStoreError>
  readonly read: (login: string, requestId: string) => Effect.Effect<SetupRecord | undefined, SetupStoreError>
  readonly update: (login: string, previous: SetupRecord, next: SetupRecord) => Effect.Effect<SetupRecord, SetupStoreError>
}
export class SetupRequests extends Context.Service<SetupRequests, SetupRequestsShape>()("smithers-server/SetupRequests") {}
export const setupRequestsLayer = (namespace: NativeNamespace): Layer.Layer<SetupRequests> => {
  const call = (login: string, command: Command) => Effect.gen(function* () {
    const response = yield* namespaceCall("repository-setup", namespace, login, new Request("https://gateway-sessions.internal/repository-setup", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command)
    }))
    const body = yield* readBoundedJson(response, 128_000)
    if (!response.ok) return yield* Effect.fail(new SetupStoreError({ status: response.status, message: typeof (body as { message?: unknown })?.message === "string" ? (body as { message: string }).message : "Setup storage is unavailable" }))
    if ((body as { record?: unknown })?.record == null) return undefined
    const parsed = SetupRecordSchema.safeParse((body as { record: unknown }).record)
    if (!parsed.success) return yield* Effect.fail(new SetupStoreError({ message: "The persisted setup record is invalid" }))
    return parsed.data
  }).pipe(Effect.catch(error => Effect.fail(error instanceof SetupStoreError ? error : new SetupStoreError({ message: "Setup storage is unavailable" }))))
  const required = (record: SetupRecord | undefined) => record === undefined
    ? Effect.fail(new SetupStoreError({ message: "The setup request was not persisted" })) : Effect.succeed(record)
  return Layer.succeed(SetupRequests, {
    create: (login, input) => call(login, { action: "create", login, input }).pipe(Effect.flatMap(required)),
    read: (login, requestId) => call(login, { action: "read", requestId }),
    update: (login, previous, record) => call(login, { action: "update", requestId: previous.input.requestId, expectedVersion: previous.version, record }).pipe(Effect.flatMap(required))
  })
}
