// The browser boundary: picks the backend, injects the stylesheet and starts the Foldkit runtime, once.
// Mock mode means no backend and no model (wiki/decisions/0004-mock-mode.md). Until the live agent lands (brick 1b in
// wiki/roadmap.md), the mock backend is the only one.
import { Effect } from "effect"
import { Runtime } from "foldkit"
import { MockFactory } from "../core/MockFactory.vibe"
import { Flags, init, Message, Model, subscriptions, update, viewTransition } from "./main.vibe"
import { stylesheet } from "./styles.ts"
import { view } from "./view.ts"

const mode = "mock" as const

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
  resources: MockFactory,
  container: document.getElementById("root")!,
  devTools: { Message },
})

Runtime.run(application, { flags: Effect.sync(() => ({ session: crypto.randomUUID().slice(0, 8), mode, name: "Guest", reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches })) })
