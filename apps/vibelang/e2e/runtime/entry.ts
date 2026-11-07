// Built only in e2e mode. It runs the real app with a faulty transport layer and exposes read-only observations.
import { Effect } from "effect"
import { Runtime } from "foldkit"
import { faultyFactory, trace } from "../../test/support/FaultyFactory.vibe"
import { application } from "../../test/support/application.ts"
import { init } from "../../src/web/main.vibe"
import { stylesheet } from "../../src/web/styles.ts"
import { canonical } from "./probe.vibe"

const style = document.createElement("style")
style.textContent = stylesheet()
document.head.append(style)
const observation = trace()
let model = init({ session: "browser", mode: "mock", name: "Guest" }).model
const requestedFault = new URLSearchParams(location.search).get("fault")
const fault = requestedFault === "refuse" ? "refuse" : requestedFault === "end" ? "end" : requestedFault === "disconnect" ? "disconnect" : "drop"
const program = application(document.getElementById("root")!, faultyFactory(fault, observation), value => { model = value })
window.recovery = {
  snapshot: () => ({ client: model.client, subscriptions: observation.subscriptions, delivered: observation.delivered.map(event => event.seq) }),
  canonical: () => Effect.runPromise(canonical(observation)),
}
Runtime.run(program, { flags: Effect.succeed({ session: "browser", mode: "mock", name: "Guest" }) })
