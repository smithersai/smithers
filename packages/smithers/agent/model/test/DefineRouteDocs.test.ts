import { Redacted, Result } from "effect"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import { expect, it } from "vitest"
import { Auth, Endpoint, Framing } from "../src/index.ts"
import * as Route from "../src/Route.ts"

it("the documented Cerebras structured-output route targets chat completions", () => {
  const guide = readFileSync(new URL("../docs/guides/define-a-route.md", import.meta.url), "utf8")
  const snippet = [...guide.matchAll(/```ts\n([\s\S]*?)```/g)]
    .find(([, code]) => code?.includes("id: \"cerebras\""))?.[1]
  expect(snippet).toBeDefined()

  // Execute the copyable example through Route and Endpoint with a local placeholder key.
  const endpointUrl = runInNewContext(`${snippet}\nroute.endpoint.url`, {
    Route,
    Redacted,
    Result,
    process: { env: { CEREBRAS_API_KEY: "test-key" } }
  })

  expect(endpointUrl).toBe("https://api.cerebras.ai/v1/chat/completions")
})

for (const id of ["openrouter", "ollama", "gemini", "cerebras"]) {
  it(`documents the provider identity for ${id}`, () => {
    const guide = readFileSync(new URL("../docs/guides/define-a-route.md", import.meta.url), "utf8")
    const snippet = [...guide.matchAll(/```ts\n([\s\S]*?)```/g)]
      .find(([, code]) => code?.includes(`id: "${id}"`))![1]!
    const name = id === "ollama" ? "ollama" : id === "gemini" ? "gemini" : "route"
    const provider = runInNewContext(`${snippet}\n${name}.providerName`, {
      Route,
      Redacted,
      Result,
      process: {
        env: { OPENROUTER_API_KEY: "placeholder", GEMINI_API_KEY: "placeholder", CEREBRAS_API_KEY: "placeholder" }
      }
    })
    expect(provider).toBe(id)
  })
}

it("documents the custom route provider identity", () => {
  const guide = readFileSync(new URL("../docs/guides/define-a-route.md", import.meta.url), "utf8")
  const snippet = [...guide.matchAll(/```ts\n([\s\S]*?)```/g)]
    .find(([, code]) => code?.includes("id: \"my-provider\""))![1]!.replace(/^import .*$/gm, "")
  const myProtocol = Result.getOrThrow(Route.openai({ apiKey: Redacted.make("placeholder") })).protocol
  const provider = runInNewContext(`${snippet}\nResult.getOrThrow(route).providerName`, {
    Auth,
    Endpoint,
    Framing,
    Route,
    Redacted,
    Result,
    myProtocol,
    process: { env: { MY_PROVIDER_API_KEY: "placeholder" } }
  })
  expect(provider).toBe("my-provider")
})
