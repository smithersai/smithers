/**
 * Commits model frames to the durable Go turn journal under a fenced grant.
 *
 * @since 1.0.0-rc.0
 */
import type * as Model from "@smthrs/model/Model"
import {
  AgentTurnCursorSchema,
  agentTurnJournalDigestInput,
  AgentTurnJournalReplySchema
} from "@smthrs/rpc/AgentTurnJournal"
import type { AgentTurnCursor, AgentTurnJournalReply } from "@smthrs/rpc/AgentTurnJournal"
import type { AgentTurnFrame, FetchLike, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import { Effect } from "effect"
import { runModelTurn } from "./ModelTurnHost.ts"
import type { ModelTurnOptions } from "./ModelTurnHost.ts"

/**
 * One short-lived capability for an already accepted chat turn.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface DurableChatGrant {
  readonly turnId: string
  readonly ownerId: number
  readonly repositoryId?: number
  readonly runId: string
  readonly legId: string
  readonly generation: number
  readonly token: string
  readonly cursor: AgentTurnCursor
  readonly expiresAt: string
  readonly request: StartAgentTurnRequest
  readonly producerBaseUrl: string
}

type CommitReply = Extract<AgentTurnJournalReply, { readonly status: "committed" | "duplicate" }>

const asError = (cause: unknown): Error => cause instanceof Error ? cause : new Error("chat producer request failed")

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

const commitReply = async (response: Response): Promise<CommitReply> => {
  if (!response.ok) throw new Error(`chat producer commit refused (${response.status})`)
  const parsed = AgentTurnJournalReplySchema.safeParse(await response.json())
  if (!parsed.success || (parsed.data.status !== "committed" && parsed.data.status !== "duplicate")) {
    throw new Error("chat producer commit returned an invalid receipt")
  }
  return parsed.data
}

/**
 * Writes exact, hash-checked batches for one producer generation.
 *
 * @category services
 * @since 1.0.0-rc.0
 */
export class DurableChatProducer {
  private cursor: AgentTurnCursor
  private readonly callbackBaseUrl: string
  private readonly grant: DurableChatGrant
  private readonly fetchImpl: FetchLike

  constructor(
    callbackBaseUrl: string,
    grant: DurableChatGrant,
    fetchImpl: FetchLike = fetch.bind(globalThis)
  ) {
    this.callbackBaseUrl = callbackBaseUrl
    this.grant = grant
    this.fetchImpl = fetchImpl
    this.cursor = AgentTurnCursorSchema.parse(grant.cursor)
  }

  providerStarted(): Effect.Effect<void, Error> {
    const url = new URL("/internal/chat/provider-started", this.callbackBaseUrl)
    url.searchParams.set("turnId", this.grant.turnId)
    url.searchParams.set("generation", String(this.grant.generation))
    return Effect.tryPromise({
      try: (signal) =>
        this.fetchImpl(url, {
          method: "POST",
          signal,
          headers: { authorization: `Bearer ${this.grant.token}` }
        }),
      catch: asError
    }).pipe(
      Effect.flatMap((response) =>
        response.ok ? Effect.void : Effect.fail(new Error(`chat provider start refused (${response.status})`))
      )
    )
  }

  write(frame: AgentTurnFrame): Effect.Effect<void, Error> {
    const expected = this.cursor
    const body = JSON.stringify({
      turnId: this.grant.turnId,
      generation: this.grant.generation,
      expected,
      frames: [frame]
    })
    const invoke = (signal: AbortSignal) =>
      this.fetchImpl(new URL("/internal/chat/commit", this.callbackBaseUrl), {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${this.grant.token}` },
        body
      }).then(commitReply)
    return Effect.tryPromise({ try: invoke, catch: asError }).pipe(
      Effect.catch(() => Effect.tryPromise({ try: invoke, catch: asError })),
      Effect.flatMap((reply) =>
        Effect.tryPromise({
          try: async () => {
            const expectedHash = await sha256Hex(agentTurnJournalDigestInput("batch", {
              version: 1,
              runId: expected.runId,
              legId: expected.legId,
              batch: expected.batch + 1,
              from: expected.position + 1,
              previousHash: expected.hash,
              frames: [frame]
            }))
            if (
              reply.batch.runId !== expected.runId || reply.batch.legId !== expected.legId ||
              reply.batch.batch !== expected.batch + 1 || reply.batch.from !== expected.position + 1 ||
              reply.batch.previousHash !== expected.hash || reply.batch.hash !== expectedHash ||
              reply.cursor.hash !== reply.batch.hash ||
              reply.cursor.batch !== reply.batch.batch ||
              reply.cursor.position !== reply.batch.from + reply.batch.frames.length - 1
            ) {
              throw new Error("chat producer receipt did not extend the committed cursor")
            }
            this.cursor = reply.cursor
          },
          catch: asError
        })
      )
    )
  }
}

/**
 * Streams one model leg and durably commits each projected frame.
 *
 * @category runners
 * @since 1.0.0-rc.0
 */
export const runDurableChatTurn = (
  model: Model.Model,
  grant: DurableChatGrant,
  options: ModelTurnOptions,
  callbackBaseUrl: string = grant.producerBaseUrl,
  fetchImpl?: FetchLike
): Effect.Effect<void, Model.ModelFailure | Error> => {
  const producer = new DurableChatProducer(callbackBaseUrl, grant, fetchImpl)
  return Effect.gen(function*() {
    yield* producer.providerStarted()
    yield* runModelTurn(model, grant.request, options, (frame) => producer.write(frame))
  })
}
