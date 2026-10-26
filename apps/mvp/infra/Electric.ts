// What ChatApi needs to reach Electric in production, and nothing else: the container and its gateway Worker live in
// infra/ElectricGateway.ts, which alchemy.run.ts declares. Under `alchemy dev` ChatApi reaches the compose Electric.
import * as Cloudflare from "alchemy/Cloudflare"
import * as Output from "alchemy/Output"
import { Context, Effect, Option } from "effect"
import { GATEWAY_BINDING, GATEWAY_URL } from "./ElectricUpstream.ts"

/** The gateway ChatApi binds in production. alchemy.run.ts provides it while it declares ChatApi. */
export class Endpoint extends Context.Service<Endpoint, {
  /** The gateway Worker's script name. */
  readonly service: Output.Output<string>
}>()("@smthrs/mvp/infra/Electric/Endpoint") {}

/**
 * Binds the gateway to the Worker being declared as the service binding `ELECTRIC_GATEWAY`, and `ELECTRIC_URL` to
 * `GATEWAY_URL`, from `Endpoint`, so its Effect `Config` (`ShapeProxy.config`) reads the URL and `upstream`
 * (infra/ElectricUpstream.ts) finds the binding at runtime. Without an `Endpoint` it does nothing: under `alchemy dev`
 * the Worker keeps the compose Electric, and at runtime the bindings are already there.
 */
export const bind = Effect.gen(function* () {
  const endpoint = yield* Effect.serviceOption(Endpoint)
  if (Option.isNone(endpoint)) return
  const self = yield* Cloudflare.Worker
  yield* self.bind`${GATEWAY_BINDING}`({
    bindings: [{ type: "service", name: GATEWAY_BINDING, service: endpoint.value.service }],
  })
  yield* Output.named(Output.literal(GATEWAY_URL), "ELECTRIC_URL")
})
