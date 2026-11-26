import { Context, Effect, Fiber } from "effect"
import type { Persistence } from "@smthrs/effect-tanstack-db"
import { Otlp } from "@smthrs/observability"
import { telemetryExport } from "../telemetryExport"

/** The engine uses the same OTLP payload transform as the tab. */
export const engineOtlp = (options: Omit<Otlp.Options, "transform">) =>
  Otlp.layerFetch({ ...options, transform: telemetryExport })

/**
 * The persistence host takes a Promise. Keep its wait scoped to the worker watcher.
 * @throws {never}
 */
export const persistenceOptionsOnFailure = <D extends Persistence.Database>(
  services: Context.Context<never>,
  watching: Fiber.Fiber<unknown>,
  failure: new () => Error,
  options: Persistence.Options<D>,
) => {
  const failed = Effect.runPromiseWith(services)(Fiber.join(watching)).then(() => {
    throw new failure()
  })
  // expected: the race handles the rejection once the persistence host calls open.
  failed.catch(() => {})
  return { ...options, open: () => Promise.race([Promise.resolve(options.open()), failed]) }
}
