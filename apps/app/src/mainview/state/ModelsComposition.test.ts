/*
 * The models controller at the composition root: the `model.*` flows reach it
 * through the one command map, and a test the card still holds as requested is
 * launched again after identity loads, so boot cannot supersede its result.
 */
import { expect, test } from "bun:test"
import { MODEL_CATALOG_PATH, MODEL_TEST_PATH } from "@smthrs/rpc/AgentApiRoutes"
import type { ConfiguredModel, ModelCatalog, ModelTestResult } from "@smthrs/rpc/ConfiguredModel"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { MODELS_CARD_ID } from "./controller/models"
import { memoryStorage, unavailableAgent, unavailableRepositories, waitFor } from "./TestFixtures"

const createAppController = scopedControllers()

const mine: ConfiguredModel = { id: "mine", protocol: "openai-chat", baseUrl: "https://api.cerebras.ai", modelId: "qwen-3-coder-480b", credential: "CEREBRAS_API_KEY" }
const catalog: ModelCatalog = { models: [], credentials: [{ name: "CEREBRAS_API_KEY", present: true, origins: ["https://api.cerebras.ai"] }], seats: ["explainer"] }
const passed: ModelTestResult = { ok: true, latencyMs: 12, sample: "ok" }

const host = () => {
  const paths: Array<string> = []
  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    const path = new URL(input instanceof Request ? input.url : String(input), "http://local.test").pathname
    paths.push(path)
    return Response.json(path === MODEL_TEST_PATH ? passed : path === MODEL_CATALOG_PATH ? catalog : {})
  }
  return { paths, fetchImpl }
}

const modelsCard = (store: Awaited<ReturnType<typeof createAppStore>>) => {
  const card = store.collections.cards.get(MODELS_CARD_ID)
  return card?.kind === "models" ? card : undefined
}

test("the model flows run through the registry, and a requested test survives a reload", async () => {
  const storage = memoryStorage()
  const first = await createAppStore({ kind: "localStorage", storage }, { seedWiki: false })
  // A host that never answers the test: the request is all the first session leaves behind.
  const silent = createAppController(first, unavailableRepositories, unavailableAgent, {
    fetchImpl: (input) => new URL(input instanceof Request ? input.url : String(input), "http://local.test").pathname === MODEL_TEST_PATH
      ? new Promise<Response>(() => {})
      : Promise.resolve(Response.json(catalog))
  })
  expect(await silent.commands.run("model.save", "--name mine --protocol openai-chat --model qwen-3-coder-480b --credential CEREBRAS_API_KEY --url https://api.cerebras.ai")).toEqual({ status: "executed", value: "saved mine" })
  expect(first.collections.models.get("mine")).toMatchObject(mine)
  expect(await silent.commands.run("model.test", "mine")).toEqual({ status: "executed", value: "Requested" })
  expect(modelsCard(first)?.payload.testing).toEqual(["mine"])
  await silent.dispose()
  await first.dispose?.()

  const second = await createAppStore({ kind: "localStorage", storage }, { seedWiki: false })
  expect(modelsCard(second)?.payload.testing).toEqual(["mine"])
  const answering = host()
  const reloaded = createAppController(second, unavailableRepositories, unavailableAgent, { fetchImpl: answering.fetchImpl })
  expect(answering.paths).toEqual([])
  await reloaded.loadSession()
  await waitFor(() => second.collections.models.get("mine")?.lastTest !== undefined)
  expect(answering.paths).toContain(MODEL_TEST_PATH)
  expect(second.collections.models.get("mine")?.lastTest?.result).toEqual(passed)
  expect(modelsCard(second)?.payload.testing).toEqual([])
})
