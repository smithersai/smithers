/*
 * The `secrets` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { flow, RepoTarget } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `secrets` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "secrets", label: "Secrets", summary: "Secrets a repository's sessions may use" }

/** The `secrets` flows registered as one aggregator block. */
export const secretsFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "secrets.connect", summary: "Connect Claude for coding in your repositories", runtime: ["cloud"],
    requires: ["signed-in"], input: Schema.Struct({ value: Schema.optional(Schema.String) }),
    form: { submitLabel: "Connect", fields: { value: { label: "Claude setup token", kind: "write-only", required: true } } },
    confirm: () => "connect Claude for coding",
    handler: (_input, _signal, _call, gesture) => actions.connectCodingProvider(gesture)
  }),
  flow({
    name: "secrets.connections", summary: "List coding connections", runtime: ["cloud"],
    requires: ["signed-in"], input: Schema.Struct({}),
    handler: () => actions.listCodingProviders()
  }),
  flow({
    name: "secrets.revoke", summary: "Revoke coding connection", runtime: ["cloud"],
    requires: ["signed-in"], args: "<id>", input: Schema.Struct({ id: Schema.String }),
    confirm: payload => `revoke coding connection ${String(payload["id"])}`,
    handler: ({ id }) => actions.revokeCodingProvider(id)
  }),
  flow({
    name: "secrets.list",
    summary: "Show the secrets a repository's sessions may use: names and bindings, never values",
    runtime: ["cloud"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    prepare: ({ repo }) => actions.listSecrets.preload?.(repo),
    handler: ({ repo }) => actions.listSecrets(repo)
  })
]
