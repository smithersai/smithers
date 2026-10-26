// The agent's contract between the browser's engine and ChatApi (docs/features/agent.md#the-answer-routes): the one
// home of the values both sides share. Nothing here imports a library, so every side can.

/**
 * The answer routes, the server's write path for answers the browser's agent gives:
 * - `GET <route>/<answerId>`: the question and the history before it, once every earlier answer has settled;
 * - `PATCH <route>/<answerId>`: renew the owned host lease independently of visible progress;
 * - `POST <route>/<answerId>`: the answer's text and parts while it streams, then how it settled.
 */
export const ANSWERS_ROUTE = "/api/answers"

/** The largest body `POST /api/answers/<id>` reads: 256 KiB. */
export const MAX_ANSWER_BODY_BYTES = 256 * 1024

/** The most frames one answer may take before it ends `unfinished`. */
export const MAX_FRAMES = 8

/**
 * How long one answer's run may wait for its turn while the queue before it doesn't move, counted from when an earlier
 * answer last settled (or from the ask, if later), before it settles the answer `unfinished`. A burst is answered in
 * turn however long it is, as long as each answer ahead settles within this. The host may set its own
 * (src/features/agent/host.ts).
 */
export const ANSWER_TURN_WAIT = "10 minutes"

/** How long `chat/Settle` keeps trying to land an answer while the answer routes are unreachable. */
export const ANSWER_SETTLE_WITHIN = "10 minutes"

/**
 * What the agent records in the engine worker (docs/observability.md#browser), by name, and the attributes they carry:
 * its run and model calls (`@smthrs/agent`, its `ModelStep`), the model endpoint's client (`@smthrs/model`'s
 * `ModelProxy` and `Model.withGenAiSpan`; the `agent` seat's model is `agent`), and the answer routes' HTTP calls. A
 * tool call's span names its flow, so each flow the agent may call lists its own. ChatApi's relay keeps exactly what
 * src/telemetry.ts merges from every feature; none of these fields carries a prompt, an answer or a provider's text.
 */
export const AGENT_TELEMETRY = {
  records: [
    "chat.answer.heartbeat.failed",
    "chat.answer.exchange",
    "chat.answer.exchange.timeout",
    "smithers_answer_exchange_timeouts",
    "chat.answer.progress",
    "chat.answer.progress.failed",
    "smithers_answer_progress_writes",
    "memory.catalog_unavailable",
    "smithers_memory_catalog_unavailable",
    "invoke_agent",
    "chat agent",
    "ModelStep",
    "model.proxy.stream",
    "A model step's earlier call was cut off mid-flight; calling the provider again",
    "A checkpoint could not be pinned",
    "A supervisor reading could not be recorded",
    "agent_model_step_calls",
    "agent_model_step_replays",
    "agent_model_step_redispatches",
    "smithers_model_proxy_requests",
    "smithers_model_proxy_duration_ms",
    "smithers_model_proxy_first_event_ms",
    "flows_seat_active",
    "flows_quota_park",
    "flows_agent_structured_output_rejections",
    "flows_agent_structured_output_exhausted",
    "agent.cell",
  ],
  fields: [
    "operation",
    "answerId",
    "outcome",
    "transition",
    "work",
    "calls",
    "code",
    "status",
    "gen_ai.operation.name",
    "gen_ai.request.model",
    "gen_ai.provider.name",
    "gen_ai.conversation.id",
    "gen_ai.response.finish_reasons",
    "gen_ai.response.id",
    "gen_ai.usage.input_tokens",
    "gen_ai.usage.output_tokens",
    "gen_ai.usage.cost",
    "smithers.model.served_tier",
    "smithers.model.attempts",
    "smithers.model.request_bytes",
    "smithers.model.prepared_ms",
    "smithers.model.signed_ms",
    "smithers.model.sent_ms",
    "smithers.model.headers_ms",
    "smithers.model.first_event_ms",
    "smithers.model.first_thinking_ms",
    "smithers.model.first_output_ms",
    "smithers.model.last_output_ms",
    "smithers.model.completed_ms",
    "smithers.model.closed_ms",
    "smithers.model.failed_tries",
    "smithers.model_step.name",
    "smithers.model_step.outcome",
    "smithers.model_step.error_code",
    "smithers.model.proxy.request_id",
    "smithers.model.proxy.invocation_id",
    "smithers.model.proxy.outcome",
    "smithers.model.proxy.events",
    "smithers.model.proxy.duration_ms",
    "smithers.model.proxy.first_event_ms",
    "smithers.model.proxy.request_bytes",
    "step",
    "model",
    "side",
    "requestId",
    "invocationId",
    "traceId",
    "modelId",
    "provider",
    "errorCode",
    "errorTag",
    "feature",
    "events",
    "firstEventMs",
    "requestBytes",
    "inputTokens",
    "outputTokens",
    "checkpoint",
    "frame",
  ],
} as const
