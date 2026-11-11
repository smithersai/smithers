/** The host's Jev evaluator: the native subscription judge every flow host binds. */
import { environmentDispatcher, layerRebuildableRequestExecutor, layerSeatEvaluator } from "@smthrs/cli/NodeControl"
import type * as Evaluator from "@smthrs/model/Evaluator"
import { Layer } from "effect"
import type * as HttpClient from "effect/http/HttpClient"

/** Use the native subscription judge over the host's proxy-aware transport.
 * Seat resolution is lazy, so newly connected accounts work without a restart.
 * Missing subscriptions and invalid verdicts fail closed when asked to judge. */
export const evaluatorLayer = (
  environment: Readonly<Record<string, string | undefined>>,
  jevHttp?: Layer.Layer<HttpClient.HttpClient>
): Layer.Layer<Evaluator.Evaluator> =>
  layerSeatEvaluator(environment, jevHttp).pipe(
    Layer.provide(layerRebuildableRequestExecutor(environmentDispatcher(environment)))
  )
