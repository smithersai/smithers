import { Schema } from "effect"
import type { FlowEntry } from "../registry"
import type { CommandActions } from "./Declare"
import { flow,NoPayload } from "./Declare"

export const guideFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({ name: "input.mode", summary: "Choose Normal, Vim, or Dictation input mode", args: "<mode>",
    input: Schema.Struct({ mode: Schema.Literals(["normal", "vim", "dictation"]) }),
    handler: ({ mode }, _signal, _call, gesture) => gesture?.inputModeChanged ?? actions.setInputMode(mode) }),
  flow({ name: "debug.reset", summary: "Clear this app’s local data, sign out, and restart as a new user", input: NoPayload,
    confirm: "clear all local Smithers app data and start fresh",
    handler: () => actions.debugReset() }),
]
