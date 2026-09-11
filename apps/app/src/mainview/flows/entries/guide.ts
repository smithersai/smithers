import { Schema } from "effect"
import { flow, NoPayload } from "./Declare"
import type { CommandActions } from "./Declare"
import type { FlowEntry } from "../registry"

export const guideFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({ name: "tut", summary: "Replay the Smithers introduction from the beginning", input: NoPayload,
    handler: () => actions.guideAct("restart") }),
  flow({ name: "tut.more", hidden: true, summary: "Watch Smithers demonstrate the optional capabilities", input: NoPayload,
    handler: () => actions.guideAct("reel-start") }),
  flow({ name: "debug.reset", summary: "Clear this app’s local data, sign out, and restart as a new user", input: NoPayload,
    confirm: "clear all local Smithers app data and restart onboarding",
    handler: () => actions.debugReset() }),
  flow({
    name: "onboarding.act",
    summary: "Guide the onboarding lesson, open or close the conversation, update the optional profile, or end the tutorial (action finish)",
    args: "<action> [value]",
    input: Schema.Struct({ action: Schema.String, value: Schema.optional(Schema.String) }),
    handler: ({ action, value }) => actions.guideAct(action, value),
  }),
]
