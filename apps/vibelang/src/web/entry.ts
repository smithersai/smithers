// The browser boundary: picks the backend, injects the stylesheet and starts the Foldkit runtime, once.
// The live Factory when this origin's `/api/health` says `agent: "live"` (wiki/decisions/0010-live-agent.md); the mock
// otherwise, with no backend and no model (0004): on `pnpm dev` and `vite preview`, on a deployment without the API
// Worker, and whenever the page asks for it with `?agent=mock` or the `vibelang.agent` storage key set to `mock`.
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { Runtime } from "foldkit"
import { health, LiveFactory } from "../core/LiveFactory.vibe"
import { MockFactory } from "../core/MockFactory.vibe"
import { Flags, init, Message, Model, subscriptions, update, viewTransition } from "./main.vibe"
import { stylesheet } from "./styles.ts"
import { view } from "./view.ts"

/** Whether this page asked for the mock agent. Storage can be unavailable; that asks for nothing. */
function askedForMock(): boolean {
  if (new URLSearchParams(location.search).get("agent") === "mock") return true
  try {
    return localStorage.getItem("vibelang.agent") === "mock"
  } catch {
    return false
  }
}

const origin = location.origin
const live = !askedForMock() && await Effect.runPromise(
  health(origin).pipe(
    Effect.map((answer) => answer.agent === "live"),
    Effect.timeout("3 seconds"),
    Effect.orElseSucceed(() => false),
    Effect.provide(FetchHttpClient.layer),
  ),
)
const mode = live ? "live" : "mock"

const style = document.createElement("style")
style.textContent = stylesheet()
document.head.append(style)

const application = Runtime.makeApplication({
  Model,
  Flags,
  init,
  update,
  view,
  subscriptions: subscriptions(document, document),
  viewTransition,
  resources: live ? LiveFactory(origin).pipe(Layer.provide(FetchHttpClient.layer)) : MockFactory,
  container: document.getElementById("root")!,
  devTools: { Message },
})

Runtime.run(application, { flags: Effect.sync(() => ({ session: crypto.randomUUID().slice(0, 8), mode, name: "Guest", reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches })) })
