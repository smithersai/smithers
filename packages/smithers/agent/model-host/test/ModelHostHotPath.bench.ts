import { describe, test } from "vitest"
import * as LocalModel from "../src/LocalModel.ts"
import { StreamingCredentialCutter } from "../src/StreamingCredentialCutter.ts"

const secret = "sk-ant-api03-verySecretCredentialValue9876543210abcdef"
const extraSecret = "ghp_additionalSecretTokenValue0123456789"

const streamChunks: ReadonlyArray<string> = Array.from({ length: 150 }, (_, i) => {
  if (i === 40) return "prefix text sk-ant-api03-verySecret"
  if (i === 41) return "CredentialValue9876543210abcdef suffix text"
  return `chunk-${i}: normal model output delta with code tokens const x = ${i};\n`
})

const env = {
  ANTHROPIC_API_KEY: secret,
  CEREBRAS_API_KEY: "csk-bench-cerebras-key-123456",
  AI_GATEWAY_API_KEY: "gw-bench-key-123456"
}

const bindingInput = {
  id: "cerebras",
  protocol: "openai-chat",
  baseUrl: "https://api.cerebras.ai/v1",
  modelId: "llama-3.3-70b",
  credential: "CEREBRAS_API_KEY"
}

describe("model-host hot paths", () => {
  test("StreamingCredentialCutter across 150 chunks", async ({ bench }) => {
    await bench("redact split credentials across 150 streamed chunks", () => {
      const cutter = new StreamingCredentialCutter(secret, [extraSecret])
      for (const chunk of streamChunks) {
        cutter.push(chunk)
      }
      cutter.finish()
    }).run({ time: 120, warmupTime: 30 })
  })

  test("LocalModel.planOnLocal and localModelCatalog", async ({ bench }) => {
    await bench("plan local model binding + build model catalog", () => {
      LocalModel.planOnLocal(bindingInput, env)
      LocalModel.localModelCatalog(env)
    }).run({ time: 120, warmupTime: 30 })
  })
})
