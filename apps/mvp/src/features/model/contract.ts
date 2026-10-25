import { Config, Schema } from "effect"

// The model endpoint's contract between the browser's agent and ChatApi (docs/features/model-endpoint.md): the one
// home of the values both sides share, and of the settings that belong to a role. It imports only `effect`, which
// every side has.

/** The metered model endpoint: `POST <route>/<role>` with a JSON `ModelRequest`, answered as NDJSON model events. */
export const MODEL_ROUTE = "/api/model"

/**
 * What a model call is for. Each role is answered by the model an admin set for it (`admin/SetModel`), or by the
 * deployment's default model when no admin has. `coding` is the `todo` run's agent (decision 0033): until an admin
 * sets it, it answers with the `agent` role's model.
 */
export const MODEL_ROLES = ["agent", "coding", "renderer", "judge", "summary"] as const

/** One of {@link MODEL_ROLES}. */
export type ModelRole = (typeof MODEL_ROLES)[number]

/**
 * Lease window for an answer's durable host, renewed by confirmed engine
 * heartbeats even while the model reasons or a tool produces no output.
 * It bounds abandoned/disconnected hosts, rather than model response time.
 */
export const AGENT_LIVE_SECONDS = 30

/** `ANSWER_TURN_LIVE_SECONDS`: an integer of at least five seconds (the engine pulses each second), {@link AGENT_LIVE_SECONDS} when unset. */
export const agentLiveSeconds = Config.schema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(5)), "ANSWER_TURN_LIVE_SECONDS")
  .pipe(Config.withDefault(AGENT_LIVE_SECONDS))

/** A quota or credit refusal needs intervention; a plain rate limit can recover with backoff. */
export const quotaRefused = (code: string, httpStatus?: number): boolean =>
  httpStatus === 402 || code === "quota_exceeded" || code === "out_of_credit"
