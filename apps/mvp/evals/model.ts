import { HostModel } from "@smthrs/model-host"
import { Effect } from "effect"
import { DEFAULT_CHAT_MODEL } from "../worker/ModelRoles.vibe"

/**
 * The deployment's default model, as ChatApi builds it: `CHAT_MODEL` and its key from the environment. Its provider
 * calls go through `fetch`: on Node, the host's HTTP/1.1 provider fetch, since Node's own fetch wedges on an HTTP/2
 * session the provider tore down (`EgressHttpClient.providerFetch`).
 */
export const defaultModel = (fetch: typeof globalThis.fetch) =>
  Effect.gen(function* () {
    return yield* HostModel
  }).pipe(Effect.provide(HostModel.layerConfig("CHAT_MODEL", DEFAULT_CHAT_MODEL, { fetch })))
