/*
 * The `chat` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { flow, NoPayload } from "./Declare"
import type { FlowEntry, Namespace, Recommendation } from "../registry"
import type { CommandActions } from "./Declare"

/** The `chat` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "chat", label: "Chat", summary: "The conversation: send, stop, retry, clear" }

/** While the model types, stopping is the only next step; away from the chat, returning to it leads. */
export const recommendations: ReadonlyArray<Recommendation> = [
  { name: "chat.stop", when: (state) => state.typing, exclusive: true, rank: () => 0 },
  { name: "chat", when: (state) => state.surface !== "chat", rank: () => 0 }
]

/** `chat.surfaces`, the composer's surfaces menu, registered beside the appearance flows. */
export const chatSurfacesFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => {
  const SURFACES = {
    name: "chat.surfaces",
    summary: "Open the surfaces menu",
    input: NoPayload,
    handler: () => actions.toggleSurfacesMenu()
  }
  return [
  /*
   * `chat.*` — the conversation's own controls. C-1 (wave 13): the composer's
   * surfaces-menu trigger is a flow like every other affordance — the button
   * dispatches /chat.surfaces, and the name typed opens the same menu.
   */
  flow(SURFACES)
  ]
}

/** The bare `chat` switch and the conversation's own controls. */
export const chatFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => {
  const RETRY = {
    name: "chat.retry",
    summary: "Retry the last turn",
    input: NoPayload,
    handler: () => actions.retryLastTurn()
  }
  const SEND = {
    name: "chat.send",
    summary: "Submit the composer",
    userOnly: true,
    userOnlyReason: "the composer is the human's; the model is already the turn, and sending would nest one",
    args: "<text>",
    input: Schema.Struct({ text: Schema.String }),
    handler: ({ text }: { readonly text: string }) => {
      actions.send(text)
    }
  }
  /*
   * Local archive/start-new is always available. Optional summarization may
   * fail without changing the conversation; it never replaces existing notes.
   */
  const CLEAR = {
    name: "chat.clear",
    summary: "Archive this conversation and start fresh; optionally summarize into Wiki notes",
    confirm: "archive this conversation and start a new one",
    args: "[--summarize]",
    input: Schema.Struct({ summarize: Schema.optional(Schema.Boolean) }),
    handler: (options: { readonly summarize?: boolean }) => actions.clearConversation(options)
  }
  return [
  flow({
    /*
     * The three surface switches (chat, world, connect) are the app's own top
     * level, so they alone stay bare: `/chat` under any prefix reads wrong.
     */
    name: "chat",
    summary: "Back to the conversation",
    input: NoPayload,
    handler: () => actions.showChat()
  }),
  flow(RETRY),
  flow({
    name: "chat.stop",
    summary: "Stop the current response",
    userOnly: true,
    userOnlyReason: "stopping the model's own turn is the human's Escape key",
    input: NoPayload,
    handler: () => actions.stop()
  }),
  flow(SEND),
  flow(CLEAR)
  ]
}

/** The clipboard copy: a browser gesture that needs no controller call, so the block keeps the uniform signature. Registered after the frame flows. */
export const chatCopyFlows = (_actions: CommandActions): ReadonlyArray<FlowEntry> => {
  const COPY_MESSAGE = {
    name: "chat.copy-message",
    summary: "Copy a message to the clipboard",
    hidden: true,
    userOnly: true,
    userOnlyReason: "the clipboard write is the human's browser gesture",
    args: "<text>",
    input: Schema.Struct({ text: Schema.String }),
    /*
     * A.26: `void navigator.clipboard.writeText(...)` let the browser's
     * NotAllowedError escape as an unhandled rejection — the only trace was
     * a POST to /api/client-errors, and the human who pressed Copy was told
     * nothing at all. The refusal is awaited and answered.
     */
    handler: async ({ text }: { readonly text: string }) => {
      const clipboard = navigator.clipboard
      if (clipboard === undefined) {
        return "This browser won't give Smithers the clipboard — select the text and copy it yourself."
      }
      try {
        await clipboard.writeText(text)
      } catch (cause) {
        return cause instanceof Error && cause.name === "NotAllowedError"
          ? "The browser refused the clipboard — it only allows a copy while the page has focus."
          : "The copy didn't go through — select the text and copy it yourself."
      }
    }
  }
  return [
  flow(COPY_MESSAGE)
  ]
}

/** `chat.reload` and `chat.commands`, registered after the review and findings flows. */
export const chatReloadFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => {
  /* The one-keystroke recovery: reload the window (dev loop, stuck states). */
  const RELOAD = {
    name: "chat.reload",
    summary: "Reload the app",
    input: NoPayload,
    handler: () => actions.reloadApp()
  }
  /*
   * The full catalog as a chat message: the slash menu caps at 8 for calm,
   * so THIS is where "show me everything" lives — for the user typed, and
   * for the agent answering "what can you do".
   */
  const COMMANDS = {
    name: "chat.commands",
    summary: "List everything Smithers can do",
    input: NoPayload,
    handler: () => actions.showCommandCatalog()
  }
  return [
  flow(RELOAD),
  flow(COMMANDS)
  ]
}
