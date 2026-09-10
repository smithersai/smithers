/**
 * Opens one SQL client over a database layer and keeps its connection open
 * for the enclosing scope.
 *
 * Suites that need two genuine connections over one file call this twice
 * inside one `Effect.scoped`; closing the scope closes both.
 *
 * @since 1.0.0
 */
import { Context, Effect, Layer, type Scope } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Builds `layer` and returns the `SqlClient` it provides.
 *
 * @since 1.0.0
 * @category constructors
 */
export const connect = <E, R>(
  layer: Layer.Layer<SqlClient.SqlClient, E, R>
): Effect.Effect<SqlClient.SqlClient, E, R | Scope.Scope> =>
  Effect.map(Layer.build(layer), (context) => Context.get(context, SqlClient.SqlClient))
