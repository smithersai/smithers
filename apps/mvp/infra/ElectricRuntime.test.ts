// Real Alchemy declaration discovery, without contacting a cloud provider or deploying anything.
import * as Output from "alchemy/Output"
import { Redacted } from "effect"
import { expect, test } from "vitest"
import { DATABASE_URL_BINDING } from "./ElectricRuntime.ts"
import { discover } from "./test/electric-stack.ts"

test("the gateway binds the runtime's namespace and preserves the existing Electric container resource", async () => {
  const stack = await discover()
  expect(Object.keys(stack.resources).sort()).toEqual([
    "Electric", "ElectricGateway", "ElectricRuntime",
  ])
  const owner = stack.resources["ElectricRuntime"].Props as { exports: Record<string, unknown> }
  const gateway = stack.resources["ElectricGateway"].Props as { exports: Record<string, unknown> }
  expect(Object.keys(owner.exports).sort()).toEqual(["ElectricObject", "default"])
  expect(Object.keys(gateway.exports)).toEqual(["default"])
  // Inspect Outputs directly: their dynamic toJSON intentionally omits them from JSON.stringify.
  type Binding = { name: string; scriptName?: unknown; transferredFrom?: unknown }
  const namespace = (worker: string) => stack.bindings[worker].flatMap(({ data }) =>
    (data as { bindings?: Array<Binding> }).bindings ?? []).find((binding) => binding.name === "ElectricObject")!
  const gatewayNamespace = namespace("ElectricGateway")
  expect(Output.isOutput(gatewayNamespace.scriptName)).toBe(true)
  const script = gatewayNamespace.scriptName
  expect(Output.isPropExpr(script)).toBe(true)
  if (!Output.isPropExpr(script)) throw new Error("missing owner projection")
  expect(script.identifier).toBe("workerName")
  expect(Output.isResourceExpr(script.expr)).toBe(true)
  if (!Output.isResourceExpr(script.expr)) throw new Error("missing owner resource")
  expect(script.expr.src.LogicalId).toBe("ElectricRuntime")
  expect(namespace("ElectricRuntime").scriptName).toBeUndefined()
  expect(namespace("ElectricRuntime").transferredFrom).toEqual(["ElectricGateway"])
})

test("the database secret binds only to the owner, never to the gateway", async () => {
  const stack = await discover(Output.literal(Redacted.make("test-only-sentinel")))
  const owner = stack.resources["ElectricRuntime"].Props as { env: Record<string, unknown> }
  const gateway = stack.resources["ElectricGateway"].Props as { env: Record<string, unknown> }
  expect(owner.env[DATABASE_URL_BINDING]).toBeDefined()
  expect(gateway.env[DATABASE_URL_BINDING]).toBeUndefined()
})
