import { Effect, Layer, Schema } from "effect"
import { answerAskingTab } from "./askingTab"
import { doorChannel } from "./contract"

// The tab's side of run credentials (decision 0017 slice 0, src/flows/credentials.ts): before a root run of a person's
// flow sends its first request, the engine asks which door it came through, and only the tab that dispatched it answers
// (src/flows/askingTab.ts), with the door it remembers (`TabRequests`). A person door means the person's own press. No
// answer, from a tab closed or reloaded since, means the run gets a credential, as any run nobody pressed does. The tab
// also says whether its sign-in row says nobody is signed in: a run nobody pressed then goes signed out without asking
// for a credential the server would refuse.

/** What the engine asks: nothing more than the door every reply carries. */
export const DoorCall = Schema.Struct({})

/**
 * What the tab answers besides the door: `signedOut` when its sign-in row says nobody is signed in. Optional, so a tab
 * of an earlier build, which answers nothing more, still answers.
 */
export const DoorAnswer = Schema.Struct({ signedOut: Schema.optional(Schema.Boolean) })

/**
 * Answers engine `name`'s door channel for this tab's dispatches until its scope closes, saying `signedOut` as the
 * tab's sign-in says it (`signedOut`, src/features/auth/store.ts, which src/boot.ts passes where `AuthStore` is); an app
 * without sign-in says nothing of it.
 */
export const tabDoors = (host: { readonly name: string; readonly signedOut?: Effect.Effect<boolean> }) =>
  Layer.effectDiscard(
    answerAskingTab({
      channel: doorChannel(host.name),
      input: DoorCall,
      answer: () => Effect.map(host.signedOut ?? Effect.succeed(false), (out) => ({ signedOut: out })),
    }),
  )
