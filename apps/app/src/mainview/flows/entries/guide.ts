import { Schema } from "effect"
import type { FlowEntry } from "../registry"
import type { CommandActions } from "./Declare"
import { CardTarget,flow,NoPayload } from "./Declare"

export const guideFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({ name: "input.mode", summary: "Choose Normal, Vim, or Dictation input mode", args: "<mode>",
    input: Schema.Struct({ mode: Schema.Literals(["normal", "vim", "dictation"]) }),
    handler: ({ mode }) => actions.setInputMode(mode) }),
  flow({ name: "debug.reset", summary: "Clear this app’s local data, sign out, and restart as a new user", input: NoPayload,
    confirm: "clear all local Smithers app data and start fresh",
    handler: () => actions.debugReset() }),
  flow({ name: "tutorial.live.inspect", hidden: true, summary: "Inspect a live tutorial step", args: "<cardId> <eventId>", input: Schema.Struct({ cardId: Schema.String, eventId: Schema.String }), handler: ({ cardId, eventId }) => actions.inspectLiveTutorial(cardId, eventId) }),
  flow({ name: "tutorial.live.retry", summary: "Reconnect or retry a live tutorial run", args: "<cardId>", input: CardTarget, handler: ({ cardId }) => actions.retryLiveTutorial(cardId) }),
]
