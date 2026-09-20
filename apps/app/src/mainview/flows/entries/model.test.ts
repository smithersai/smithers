import { expect, test } from "bun:test"
import { modelFlows } from "./model"
import type { CommandActions } from "./Declare"
import { payloadFor } from "../SlashPayload"

test("/model is the namespace's bare door: it lists the models and their seats", () => {
  let listed = 0
  const actions = { listModels: () => { listed += 1; return { value: "Requested" } } } as unknown as CommandActions
  const entries = modelFlows(actions)
  const entry = entries.find(row => row.declaredName === "model")!
  expect(entry).toBeDefined()
  expect(entry.metadata.hidden).toBe(true)
  expect(entry.metadata.summary).toBe(entries.find(row => row.declaredName === "model.list")!.metadata.summary)
  expect(payloadFor("model", "", entry.metadata.grammar)).toEqual({ payload: {} })
})
