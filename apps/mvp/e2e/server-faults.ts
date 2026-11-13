import type { BrowserContext } from "@playwright/test"
import { guard } from "./target"

// DevChatApi injects these services at the host, so old and current browser builds use the same switches.
// Headers keep fault selection separate from session cookies and device-principal binding.
/** Faults scoped to this browser context. The real stack handler and shape authorization still run. */
export const serverFaults = (context: BrowserContext) => {
  guard("localServer")
  const headers: Record<string, string> = {}
  const set = (name: string, value: string) => {
    headers[name] = value
    return context.setExtraHTTPHeaders({ ...headers })
  }
  return {
    shapes: {
      hold: (shape: "issues" | "todos" | "todos-live") => set("x-smithers-test-shapes", shape),
      heal: () => set("x-smithers-test-shapes", ""),
    },
    stack: {
      refuse: () => set("x-smithers-test-stack", "refuse"),
      heal: () => set("x-smithers-test-stack", ""),
    },
  }
}
