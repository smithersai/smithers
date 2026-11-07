// The test host supplies only the resource layer and an observation of the actual rendered model.
import type { Layer } from "effect"
import { Runtime } from "foldkit"
import type { Factory } from "../../src/core/Factory.vibe"
import { Flags, init, Model, subscriptions, update, viewTransition } from "../../src/web/main.vibe"
import { view } from "../../src/web/view.ts"

export function application(node: HTMLElement, resources: Layer.Layer<Factory>, observe: (model: Model) => void) {
  return Runtime.makeApplication({
    Model, Flags, init, update,
    view: (model, h) => { observe(model); return view(model, h) },
    subscriptions: subscriptions(document, document), viewTransition,
    resources, container: node,
  })
}
