import { Effect } from "effect"
import { runners } from "../../boundary"
import { DEVICE_ADOPTED_EVENT } from "../auth/contract"
import { type Page, reload } from "../../page"
import { lead, retry, wentOffline } from "./actions"
import type { ChatStore } from "./store"

// The browser's connectivity and focus events on `target` (the window), bound while the scope is open, each running
// its action with the services it was bound with:
// - `offline`: the pill says Offline at once;
// - `online`: chat syncs and sends at once instead of waiting out its backoff;
// - the device adopted in place (`DEVICE_ADOPTED_EVENT`, src/device/identity.ts): the same, so a write queued as nobody's
//   goes again now, as the person's, and a shape waiting out its backoff asks again under them;
// - `pageshow` from the back/forward cache: the page reloads, because the device store's connections closed when it
//   was hidden (TanStack DB's browser persistence README);
// - `focus` (the person switched to this tab) and `focusin` (something in it took focus, such as the composer): this
//   tab leads the outbox, so what the person asks here is sent from here (decision 0002 §1).
export const bindConnectivity = Effect.fnUntraced(function* (target: EventTarget) {
  const { runSync: run } = runners(yield* Effect.context<ChatStore | Page>(), "chat")
  const onOffline = () => run(wentOffline)
  const onOnline = () => run(retry("online"))
  const onAdopted = () => run(retry("adopted"))
  const onPageShow = (event: Event) => {
    if ((event as PageTransitionEvent).persisted) run(reload)
  }
  const onFocus = () => run(lead)
  const bindings: ReadonlyArray<readonly [string, (event: Event) => void]> = [
    ["offline", onOffline],
    ["online", onOnline],
    [DEVICE_ADOPTED_EVENT, onAdopted],
    ["pageshow", onPageShow],
    ["focus", onFocus],
    ["focusin", onFocus],
  ]
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      for (const [type, listener] of bindings) target.addEventListener(type, listener)
    }),
    () =>
      Effect.sync(() => {
        for (const [type, listener] of bindings) target.removeEventListener(type, listener)
      }),
  )
})
