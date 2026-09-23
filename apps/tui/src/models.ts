/**
 * The seats the model picker offers: only providers this machine can reach.
 *
 * A seat is `provider:modelId`, resolved by the Smithers native seat resolver.
 * Detection is `smithers`' own (`@smthrs/cli/Providers`): a codex login makes
 * `openai:*` seats run on the ChatGPT subscription, and a provider key makes
 * that provider's seats available.
 */
import * as Providers from "@smthrs/cli/Providers"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"

export interface Model {
  readonly seat: string
  readonly label: string
  readonly provider: string
}

export const delegateModels = {
  quince: "openai:gpt-5.6-quince",
  cerebras: Providers.defaultSeat.cerebras,
  chat: "openai:gpt-5.6-chat",
  gpt: "openai:gpt-5.6",
  luna: "openai:gpt-6-luna",
  sol: "openai:gpt-6-sol",
  astra: "openai:gpt-6-astra"
} as const
export type DelegateModel = keyof typeof delegateModels

const subscription: ReadonlyArray<Omit<Model, "provider">> = [
  { seat: "openai:gpt-6-sol", label: "GPT-6 Sol" },
  { seat: "openai:gpt-6-astra", label: "GPT-6 Astra" },
  { seat: "openai:gpt-5.6-sol", label: "GPT-5.6 Sol" }
]

const byProvider: Readonly<Record<Providers.Candidate, ReadonlyArray<Omit<Model, "provider">>>> = {
  "codex-subscription": subscription,
  openai: subscription,
  "kimi-k3": [{ seat: Providers.defaultSeat["kimi-k3"], label: "Kimi K3" }],
  gemini: [{ seat: Providers.defaultSeat.gemini, label: "Gemini 2.5 Pro" }],
  openrouter: [{ seat: Providers.defaultSeat.openrouter, label: "GPT-5.6 Sol" }],
  cerebras: [{ seat: Providers.defaultSeat.cerebras, label: "Qwen 3.8" }]
}

const anthropic: ReadonlyArray<Omit<Model, "provider">> = [
  { seat: "anthropic:claude-opus-5-5", label: "Claude Opus 5.5" },
  { seat: "anthropic:claude-fable-5-1", label: "Claude Fable 5.1" }
]

export interface Available {
  readonly models: ReadonlyArray<Model>
  readonly defaultSeat: string | undefined
  readonly workerSeat: string | undefined
  /** The process environment plus what the chosen credentials need. */
  readonly environment: Record<string, string | undefined>
}

export const detect = (environment: NodeJS.ProcessEnv): Available => {
  const detections = Providers.detect({
    environment,
    homeDirectory: homedir(),
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8")
      } catch {
        return undefined
      }
    }
  }).filter((detection) => detection.available)
  const subscribed = detections.some((detection) => detection.id === "codex-subscription")
  const models: Array<Model> = []
  for (const detection of detections) {
    // One OpenAI route at a time: the subscription wins over an API key.
    if (detection.id === "openai" && subscribed) continue
    for (const model of byProvider[detection.id]) models.push({ ...model, provider: detection.label })
  }
  if ((environment.ANTHROPIC_API_KEY ?? "") !== "") {
    for (const model of anthropic) models.push({ ...model, provider: "Anthropic" })
  }
  return {
    models,
    defaultSeat: environment.SMITHERS_TUI_SEAT ?? models.find((model) => model.seat.startsWith("cerebras:"))?.seat ?? models[0]?.seat,
    workerSeat: environment.SMITHERS_TUI_WORKER_SEAT ?? models.find((model) => !model.seat.startsWith("cerebras:"))?.seat ?? models[0]?.seat,
    environment: {
      ...environment,
      ...(subscribed && environment.SMITHERS_OPENAI_AUTH === undefined ? { SMITHERS_OPENAI_AUTH: "chatgpt" } : {})
    }
  }
}
