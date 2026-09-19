/*
 * The `experimental` flows: one per hidden mock, derived from the registry.
 *
 * Every other namespace module writes its flows as literals, because a
 * shipped flow is a decision someone made once. These are generated from
 * experimental/Manifest.ts instead: a mock is one file plus one manifest
 * row, and paying for it again here would be the manifest's second copy.
 * The manifest holds identity alone, so registering thirty-one flows does
 * not pull thirty-one drawings into the boot path.
 * The selection flow is a literal in FlowName.ts. Pane-opening names remain
 * dynamic, like a repository's own flow leaves.
 *
 * The block registers only when the snapshot says the flag is on, so a
 * session without VITE_SMITHERS_EXPERIMENTAL has no experimental flow to
 * find, disclose or run — the same gate the plugins surface uses.
 */
import { EXPERIMENTAL_MANIFEST } from "../../experimental/Manifest"
import { Schema } from "effect"
import { flow, NoPayload } from "./Declare"
import type { CommandActions } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"

/** The `experimental` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = {
  id: "experimental",
  label: "Experimental",
  summary: "Hidden mocks of abstractions that have no UI yet"
}

/** The `experimental` flows registered as one aggregator block. */
export const experimentalFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "experimental.set",
    summary: "Set one experimental pane selection",
    hidden: true,
    discloseToAgent: true,
    args: "<JSON: {cardId, key, value}>",
    form: { args: (payload) => JSON.stringify(payload) },
    input: Schema.Struct({ cardId: Schema.String, key: Schema.String, value: Schema.String }),
    handler: ({ cardId, key, value }) => actions.setExperimentalProp(cardId, key, value)
  }),
  ...EXPERIMENTAL_MANIFEST.map((entry) =>
    flow({
      name: `experimental.${entry.id}`,
      summary: entry.summary,
      input: NoPayload,
      handler: () => actions.openExperimentalPane(entry.id)
    })
  )
]
