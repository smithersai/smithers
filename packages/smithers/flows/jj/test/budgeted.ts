import * as Layer from "effect/Layer"
import * as NodeJj from "../src/node/NodeJj.ts"

/**
 * A NodeJj layer whose startup probe may take a loaded host's full minute.
 *
 * The 5 s production deadline is covered by NodeJjVersion under the test
 * clock. Suites that spawn a real jj or a shell shim assert other contracts,
 * and a busy machine must not turn their startup latency into a red.
 */
export const budgeted = <A, E, R>(layer: Layer.Layer<A, E, R>): Layer.Layer<A, E, R> =>
  Layer.provide(layer, Layer.succeed(NodeJj.StartupTimeoutMs, 60_000))
