import { Uuid, WebCrypto } from "@smthrs/crypto"
import { Effect, Option, Schema } from "effect"
import { entryOf, type FlowName } from "../../flows/registry"
import { WRITE_ID_NAMESPACE } from "../issues/contract"
import { QueuedWrite } from "../issues/schema"
import { IssuesStore } from "../issues/store"
import { OP_ID_NAMESPACE } from "../todos/contract"
import { QueuedOp } from "../todos/schema"
import { TodosStore } from "../todos/store"
import { STEER_ID_NAMESPACE } from "../runs/contract"
import { RunSteers } from "../runs/steers"

const issueWrites = new Set<FlowName>(["issue/create", "issue/comment", "issue/triage", "issue/commitment", "triage/run", "triage/enable", "triage/pause"])
const todoWrites = new Set<FlowName>(["todo/commit", "todo/drop", "todo/Retry"])
export const hasOutboxAdmission = (name: FlowName): boolean => issueWrites.has(name) || todoWrites.has(name) || name === "run/steer"
export const admissionNamespace = (name: FlowName) => issueWrites.has(name) ? WRITE_ID_NAMESPACE : todoWrites.has(name) ? OP_ID_NAMESPACE : STEER_ID_NAMESPACE
const outcome = (queued: boolean) => Option.some(queued ? "queued" as const : "not_admitted" as const)

/** Core transport infrastructure: the existing public flow schemas feed their existing device outboxes. */
export const admitCommand = (name: FlowName, payload: Readonly<Record<string, unknown>>, executionId: string) =>
  Effect.gen(function* () {
    if (!hasOutboxAdmission(name)) return Option.none<"queued" | "not_admitted">()
    const decoded = yield* Schema.decodeUnknownEffect(entryOf(name).flow.payloadSchema as unknown as Schema.Codec<unknown>)(payload).pipe(Effect.result)
    if (decoded._tag === "Failure") return outcome(false)
    const value = decoded.success as Readonly<Record<string, unknown>>
    const id = yield* Uuid.v5(admissionNamespace(name), executionId).pipe(Effect.provide(WebCrypto.layer), Effect.orDie)
    if (issueWrites.has(name)) {
      const write = yield* Schema.decodeUnknownEffect(QueuedWrite)({ ...value, id, op: name,
        title: typeof value.title === "string" ? value.title.trim() : "", number: value.number ?? 0,
        body: value.body ?? value.reason ?? "",
      }).pipe(Effect.orDie)
      const store = yield* IssuesStore
      return outcome((yield* store.queue(write)).queued)
    }
    if (todoWrites.has(name)) {
      const op = yield* Schema.decodeUnknownEffect(QueuedOp)({ ...value, id,
        op: name === "todo/commit" ? "commit" : name === "todo/drop" ? "drop" : "retry",
        title: typeof value.title === "string" ? value.title.trim() : "", prompt: value.prompt ?? "", acceptance: value.acceptance ?? [], number: value.number ?? 0,
      }).pipe(Effect.orDie)
      const store = yield* TodosStore
      return outcome((yield* store.queue(op)).kept)
    }
    const steer = { id, runId: value.runId as string, body: value.body as string }
    return outcome((yield* (yield* RunSteers).queue(steer)).kept)
  })
