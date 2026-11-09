import { readFileSync } from "node:fs"
import type * as JsonSchema from "../../src/JsonSchema.vibe"
import type * as Load from "../../src/Load.vibe"
import * as Manifest from "../../src/Manifest.vibe"

/** The printed 0017 manifest, with decision 0022's `queue` ids. */
export const queueManifest = (): any =>
  JSON.parse(readFileSync(new URL("../fixtures/queue.plugin.json", import.meta.url), "utf8"))

export const object = (properties: Record<string, JsonSchema.Resolved>): JsonSchema.Resolved => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false
})

export const runAnswer: Load.FlowFacts = {
  capabilities: [],
  minimum: "member",
  personOnly: true,
  system: true,
  payload: object({ runId: { type: "string" }, version: { type: "integer" }, execution: { type: "string" }, value: {} })
}

export const appNavigate: Load.FlowFacts = {
  capabilities: [],
  minimum: "anyone",
  personOnly: false,
  system: true,
  payload: object({ to: { type: "string" } })
}

export const waits: JsonSchema.Resolved = object({
  runId: { type: "string" },
  version: { type: "integer" },
  execution: { type: "string" },
  kind: { type: "string" },
  prompt: { type: "string" },
  options: { type: "array", items: { type: "string" } },
  deadline: { type: "integer" },
  question: { type: "boolean" },
  approval: { type: "boolean" },
  addressedTo: { type: "string" }
})

/** The slice-1 app: views, slots, commands and keybindings, over `run/answer`, `app/navigate` and `core/waits`. */
export const host = (overrides: Partial<Load.HostFacts> = {}): Load.HostFacts => ({
  api: Manifest.PLUGIN_API,
  points: ["views", "slots", "commands", "keybindings"],
  catalog: new Map([["run/answer", runAnswer], ["app/navigate", appNavigate]]),
  queries: new Map([["core/waits", waits]]),
  tierCap: {
    "built-in": () => true,
    repository: (capability) => capability.startsWith("read:"),
    personal: () => false
  },
  ...overrides
})

/** The smallest manifest that loads. */
export const minimal = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  apiVersion: 1,
  id,
  version: "1.0.0",
  title: "Minimal",
  description: "The smallest manifest that loads.",
  requires: { api: "^1.0.0" },
  capabilities: [],
  ...extra
})

export const owned = (tag: string, extra: Partial<Load.OwnedFlow> = {}): Load.OwnedFlow => ({
  tag,
  capabilities: [],
  minimum: "anyone",
  personOnly: false,
  system: false,
  modelInvocable: true,
  ...extra
})
