import { Context, Effect, Layer } from "effect"
import { hide, setChannel, setLimits } from "./actions"
import type { AlertChannelName, SandboxLimitsRequest } from "./schema"
import { FlowDispatch } from "../../flows/dispatch"
import { SpendStore } from "./store"

// Spend alerts as a frontend sees them (docs/features/spend-alerts.md): a live query to read and a plain function to
// act, with no Effect in sight. The bell and notifications panel read `open`.

type Store = SpendStore["Service"]

/** What a frontend reads live. */
export interface SpendQueries {
  readonly open: Store["open"]["tanstack"]
  /** The channels an Admin turned on. */
  readonly channels: Store["channelList"]["tanstack"]
  /** The latest receipts, newest first. */
  readonly receipts: Store["receipts"]["tanstack"]
  /** This tab's saves that haven't landed. */
  readonly saves: Store["pending"]["tanstack"]
  /** The sandbox limits an Admin set: none while the defaults hold. */
  readonly limits: Store["limitRows"]["tanstack"]
  /** This tab's save of the sandbox limits that hasn't landed. */
  readonly limitSaves: Store["limitPending"]["tanstack"]
}

/** What an Admin does, as plain functions. Each returns at once. */
export interface SpendActions {
  /** Hides alert `id` and every earlier one on this device. */
  readonly hide: (id: string) => void
  /** Sets where spend alerts go on `channel`; none turns it off. */
  readonly setChannel: (channel: AlertChannelName, destinations: ReadonlyArray<string>) => void
  /** Sets the sandbox limits. */
  readonly setLimits: (limits: SandboxLimitsRequest) => void
}

export class Spend extends Context.Service<Spend, { readonly queries: SpendQueries; readonly actions: SpendActions }>()(
  "@smthrs/mvp/spend/Spend",
) {
  /** Binds the store's query and the action for frontends, run with the services this layer was built with. */
  static readonly layer = Layer.effect(
    Spend,
    Effect.gen(function* () {
      const store = yield* SpendStore
      const run = Effect.runSyncWith(yield* Effect.context<SpendStore | FlowDispatch>())
      return Spend.of({
        queries: {
          open: store.open.tanstack,
          channels: store.channelList.tanstack,
          receipts: store.receipts.tanstack,
          saves: store.pending.tanstack,
          limits: store.limitRows.tanstack,
          limitSaves: store.limitPending.tanstack,
        },
        actions: {
          hide: (id) => run(hide(id)),
          setChannel: (channel, destinations) => run(setChannel(channel, destinations)),
          setLimits: (limits) => run(setLimits(limits)),
        },
      })
    }),
  )
}

/** The spend layer's value: what frontends get. */
export type SpendView = Spend["Service"]
