import { describe, test } from "vitest"
import * as ConfiguredModel from "../src/ConfiguredModel.ts"
import * as Sha256 from "../src/Sha256.ts"
import * as WebUrl from "../src/WebUrl.ts"

const payload16k = "The quick brown fox jumps over the lazy dog. ".repeat(360)

const hostCredentials = ConfiguredModel.hostModelCredentials({
  CEREBRAS_API_KEY: "csk-bench-secret-value-0123456789abcdef",
  ANTHROPIC_API_KEY: "sk-ant-api03-bench-secret-value-9876543210"
})

const binding = {
  id: "cerebras",
  protocol: "openai-chat",
  baseUrl: "https://api.cerebras.ai/v1",
  modelId: "llama-3.3-70b",
  credential: "CEREBRAS_API_KEY"
}

const sampleSecret = "sk-ant-api03-verySecretTokenValue9876543210"
const sampleOutput = `Model output line with ${sampleSecret} embedded inside ${"log data ".repeat(40)}`

const testUrls = [
  "https://github.com/smithersai/smithers/pull/4242",
  "http://localhost:3000/runs/abc-123",
  "javascript:alert(1)"
]

const testPaths = [
  "/api/runs/run-123/events",
  "/repos/smithersai/smithers",
  "//evil.example/steal"
]

describe("rpc hot paths", () => {
  test("Sha256.digestSync on 16 KiB payload", async ({ bench }) => {
    await bench("pure-JS SHA-256 over 16 KiB UTF-8 string", () => {
      Sha256.digestSync(payload16k)
    }).run({ time: 120, warmupTime: 30 })
  })

  test("ConfiguredModel.planModelBinding and cutModelCredential", async ({ bench }) => {
    await bench("plan model binding + cut credential from sample output", () => {
      ConfiguredModel.planModelBinding(binding, hostCredentials)
      ConfiguredModel.cutModelCredential(sampleOutput, sampleSecret)
    }).run({ time: 120, warmupTime: 30 })
  })

  test("WebUrl schema validation", async ({ bench }) => {
    await bench("validate 3 HTTP URLs + 3 relative URL paths", () => {
      for (const url of testUrls) {
        WebUrl.HttpUrlSchema.safeParse(url)
      }
      for (const path of testPaths) {
        WebUrl.RelativeUrlPathSchema.safeParse(path)
      }
    }).run({ time: 120, warmupTime: 30 })
  })
})
