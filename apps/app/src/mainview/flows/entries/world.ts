/*
 * The `world.*` names: hidden aliases of the `wiki.*` flows in entries/wiki.ts.
 *
 * Will renamed World to Wiki (2026-09-07). The old names stay registered so a
 * parked `command.deferred` row, a recommender answer, a saved transcript or a
 * script written before the rename still resolves, but every one is hidden:
 * the slash menu, the agent's taught catalog and the recommender list only the
 * wiki.* names. Each alias calls the same controller action its wiki.* twin
 * calls; the summaries name the canonical flow so a caller learns the new name.
 */
import { Schema } from "effect"
import { flow, NoPayload } from "./Declare"
import type { FlowEntry } from "../registry"
import type { CommandActions } from "./Declare"

/** The bare `world` alias of `wiki`, registered beside the other surface switches. */
export const worldSurfaceFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "world",
    summary: "Alias of wiki",
    hidden: true,
    input: NoPayload,
    handler: () => actions.showWorld()
  })
]

/** The `world.*` aliases of the `wiki.*` flows. */
export const worldFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "world.new-note",
    summary: "Alias of wiki.new-note",
    hidden: true,
    input: NoPayload,
    handler: () => actions.createWorldDocument()
  }),
  flow({
    name: "world.select",
    summary: "Alias of wiki.select",
    hidden: true,
    args: "<documentId>",
    input: Schema.Struct({ documentId: Schema.String }),
    handler: ({ documentId }) => actions.selectWorldDocument(documentId)
  }),
  flow({
    name: "world.delete",
    summary: "Alias of wiki.delete",
    hidden: true,
    args: "<documentId>",
    input: Schema.Struct({ documentId: Schema.String }),
    handler: ({ documentId }) => actions.removeWorldDocument(documentId)
  }),
  flow({
    name: "world.delete.confirm",
    summary: "Alias of wiki.delete.confirm",
    hidden: true,
    userOnly: true,
    userOnlyReason: "a confirm-dialog answer is the human's",
    input: NoPayload,
    handler: () => actions.confirmWorldDelete()
  }),
  flow({
    name: "world.delete.cancel",
    summary: "Alias of wiki.delete.cancel",
    hidden: true,
    userOnly: true,
    userOnlyReason: "a confirm-dialog answer is the human's",
    input: NoPayload,
    handler: () => actions.cancelWorldDelete()
  })
]
