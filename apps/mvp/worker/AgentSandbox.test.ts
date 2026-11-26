import * as QuickJSWorkerd from "@smthrs/harness/QuickJSWorkerd"
import { Layer } from "effect"
import { expect, test } from "vitest"
import * as AgentSandbox from "./AgentSandbox.vibe"

test("both worker sandbox layers use the workerd variant exports", () => {
  expect(AgentSandbox.variant).toBe(QuickJSWorkerd.variant)
  expect(AgentSandbox.variantFrom).toBe(QuickJSWorkerd.variantFrom)
  expect(Layer.isLayer(AgentSandbox.layer)).toBe(true)
  expect(Layer.isLayer(AgentSandbox.defaults)).toBe(true)
})
