import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as Manifest from "../src/Manifest.ts"

const expectedNames = [
  "read",
  "write",
  "edit",
  "ls",
  "glob",
  "grep",
  "bash",
  "test",
  "shell_command",
  "apply_patch",
  "update_plan",
  "fetch",
  "http-post",
  "explore",
  "webfetch",
  "websearch",
  "lsp"
] as const

const forbiddenActions = ["fs:write", "net:post", "proc:spawn"] as const

const hasAction = (capability: string, action: string): boolean =>
  capability === action || capability.startsWith(`${action}:`)

describe("Manifest", () => {
  it("registers every standard flow", () => {
    expect(Object.keys(Manifest.flows)).toEqual(expectedNames)
    expect(Manifest.names).toEqual(expectedNames)
    expect(Object.keys(Manifest.handlers)).toEqual(expectedNames.filter((name) => name !== "explore"))
    expect(Object.isFrozen(Manifest.flows)).toBe(true)
    expect(Object.isFrozen(Manifest.handlers)).toBe(true)
    expect(Object.isFrozen(Manifest.names)).toBe(true)
  })

  it("reaches a narrowing for every registered name", () => {
    // Fourteen modules exported `effectsFor` and three did not, and no map
    // reached any of them: a host holding a flow name and a decoded input had
    // to serialize conflicts against the registry-time worst case for every
    // call. The registry is the entry point, so every name owes an entry.
    expect(Object.keys(Manifest.effectsFor)).toEqual(expectedNames)
    expect(Object.isFrozen(Manifest.effectsFor)).toBe(true)
    for (const name of Manifest.names) {
      expect(typeof Manifest.effectsFor[name]).toBe("function")
    }
    // The three that had no narrowing at all answer the static envelope, which
    // is the honest answer for a patch that names its files inside its own
    // text, a bare command line, and a flow that touches nothing.
    expect(Manifest.effectsFor["apply_patch"]({ input: "" })).toEqual(Manifest.flows["apply_patch"].effects)
    expect(Manifest.effectsFor["shell_command"]({ command: "true" })).toEqual(
      Manifest.flows["shell_command"].effects
    )
    expect(Manifest.effectsFor["update_plan"]({ plan: [] })).toEqual(Manifest.flows["update_plan"].effects)
  })

  it("keeps declaration metadata aligned with registry keys", () => {
    for (const [key, flow] of Object.entries(Manifest.flows)) {
      expect(flow.name).toBe(key)
      expect(flow.description?.trim()).not.toBe("")
      expect(Schema.isSchema(flow.input)).toBe(true)
      expect(Schema.isSchema(flow.output)).toBe(true)
    }
  })

  it("keeps the read-only seat projection free of mutating authority", () => {
    expect(Manifest.readOnly).toEqual([
      "read",
      "ls",
      "glob",
      "grep",
      "fetch",
      "explore",
      "webfetch",
      "lsp"
    ])
    expect(Manifest.readOnly).not.toContain("websearch")
    expect(Object.isFrozen(Manifest.readOnly)).toBe(true)

    for (const name of Manifest.readOnly) {
      const capabilities = Manifest.flows[name].capabilities
      for (const action of forbiddenActions) {
        expect(capabilities.some((capability) => hasAction(capability, action))).toBe(false)
      }
    }
  })
})
