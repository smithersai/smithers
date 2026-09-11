import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const source = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")

const importsAgentFromBridge = /import type \{[^}]*\bNativeAgent\b[^}]*\} from "[^"]*NativeBridge"/

describe("agent port placement", () => {
  test("the host-neutral contract is declared beside the runtime, not in the Electrobun bridge", () => {
    expect(source("./AgentPort.ts")).toContain("export interface AgentPort")
    const bridge = source("../native/NativeBridge.ts")
    // The bridge still owns the Electrobun-backed values, and only those.
    expect(bridge).toContain("Electroview.defineRPC")
    expect(bridge).not.toMatch(/export interface (NativeAgent|AgentPort)\b/)
  })

  test("every implementation binds the contract from the runtime module", () => {
    for (const file of ["./Runtime.ts", "../native/WebAgent.ts", "../chain/ChainRuntime.ts"]) {
      const implementation = source(file)
      expect(implementation).toContain("AgentPort")
      expect(implementation).not.toMatch(importsAgentFromBridge)
    }
  })
})
