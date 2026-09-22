import * as CodexAuth from "@smthrs/cli/CodexAuth"
import * as OpenAIChatGPT from "@smthrs/model/OpenAIChatGPT"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import * as Route from "@smthrs/model/Route"
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import * as FlowEngineLike from "@smthrs/agent/FlowEngineLike"
import { Effect, Redacted } from "effect"

export type TutorialModelSettings =
  | { readonly provider: "chatgpt"; readonly modelId: string; readonly authFile: string }
  | { readonly provider: "openai" | "gemini"; readonly modelId: string; readonly apiKey: string }

export function modelSettings(environment: Readonly<Record<string, string | undefined>>): TutorialModelSettings {
  const provider = environment.TUTORIAL_PROVIDER ?? "chatgpt"
  const modelId = environment.TUTORIAL_MODEL ?? (provider === "chatgpt" ? "gpt-5.6-luna" : undefined)
  if (!modelId) throw new Error("Configure TUTORIAL_MODEL before starting")
  if (provider === "chatgpt") {
    const authFile = environment.TUTORIAL_CHATGPT_AUTH_FILE
    if (!authFile) throw new Error("Configure TUTORIAL_CHATGPT_AUTH_FILE with the tutorial's subscription session")
    return { provider, modelId, authFile }
  }
  if (provider !== "openai" && provider !== "gemini") throw new Error("Unsupported tutorial provider")
  const apiKey = provider === "gemini" ? environment.GEMINI_API_KEY : environment.OPENAI_API_KEY
  if (!apiKey) throw new Error("Configure the selected tutorial provider credential")
  return { provider, modelId, apiKey }
}

// A store captures its executor, whose dispatcher belongs to one run's scope.
// Never retain that transport in a process-global file cache after scope close.
// CodexAuth's file lock coordinates refreshes across independent run scopes.
const stores = new WeakMap<RequestExecutor.RequestExecutor, Map<string, CodexAuth.Store>>()
export const modelSeats = (settings: TutorialModelSettings) => Effect.gen(function*() {
  const executor = yield* RequestExecutor.RequestExecutor
  const resolve = <Body, Frame, Event, State>(config: Route.Config<Body, Frame, Event, State>) => Effect.gen(function*() {
    const model = yield* Route.toModel(config)
    return SeatResolver.make({ resolve: id => Effect.succeed(Seat.make({
      id, model, modelId: settings.modelId, route: FlowEngineLike.routeResolver(config), contextWindowTokens: 32000,
    })) })
  })
  if (settings.provider === "chatgpt") {
    let owned = stores.get(executor)
    if (!owned) { owned = new Map(); stores.set(executor, owned) }
    let store = owned.get(settings.authFile)
    if (!store) {
      store = CodexAuth.make({ file: settings.authFile, executor })
      owned.set(settings.authFile, store)
    }
    return yield* Effect.fromResult(OpenAIChatGPT.make({ auth: store.auth({ modelId: settings.modelId }) })).pipe(Effect.flatMap(resolve))
  }
  if (settings.provider === "gemini") return yield* Effect.fromResult(Route.openaiChatCompatible({
    id: "gemini", baseUrl: "https://generativelanguage.googleapis.com", path: "/v1beta/openai/chat/completions", apiKey: Redacted.make(settings.apiKey),
  })).pipe(Effect.flatMap(resolve))
  return yield* Effect.fromResult(Route.openai({ apiKey: Redacted.make(settings.apiKey) })).pipe(Effect.flatMap(resolve))
})
