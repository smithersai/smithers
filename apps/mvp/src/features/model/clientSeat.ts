import type { FlowEngineLike } from "@smthrs/agent"
import { Model, ModelError, ModelProxy } from "@smthrs/model"
import { Effect } from "effect"

/** An injected host model has a stable request identity. Browsers have no model route of their own.
 * @throws {never}
 */
export const clientSeat = (origin: string, role: string, model?: Model.Model): {
  readonly model: Model.Model
  readonly route: FlowEngineLike.RouteResolver
} => ({
  model: model ?? Model.makeNoop(),
  route: {
    prepare: model === undefined
      ? () => Effect.fail(new ModelError.ModelError({ code: "no_route", message: "No model seat is configured." }))
      : ModelProxy.prepare({ url: `${origin}/seats/${role}` }),
  },
})
