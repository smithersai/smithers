import { Effect } from "effect"

/** A fresh invocation key for one `POST /api/hosted-model` change (worker/HostedModel.vibe). */
export const invocationKey = Effect.sync(() => crypto.randomUUID())
