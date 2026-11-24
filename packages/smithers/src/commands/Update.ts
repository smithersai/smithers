/**
 * `smthrs update`: the registry check, after the shared guard.
 *
 * @since 1.0.0
 */

import { Effect, Option } from "effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as CliError from "../CliError.ts"
import * as Update from "../Update.ts"
import { packageVersion } from "../Version.ts"
import * as Globals from "./Globals.ts"

const registryUnavailable = () =>
  new CliError.Refused({
    fault: "dependency",
    code: "registry_unreachable",
    message: "Could not reach the npm registry. Check your network and retry."
  })

/**
 * Compares the installed version with the registry's dist-tags.
 * @category constructors
 * @since 1.0.0
 */
export const check = (
  globals: Globals.Options
): Effect.Effect<Update.Status, CliError.UnsupportedError | CliError.Refused> =>
  Effect.gen(function*() {
    yield* Globals.guard(globals)
    const fetchFn = Option.getOrElse(yield* Effect.serviceOption(FetchHttpClient.Fetch), () => globalThis.fetch)
    const tags = yield* Effect.tryPromise({
      try: async () => {
        const response = await fetchFn(Update.registryUrl, { signal: AbortSignal.timeout(10_000) })
        // An error page or a non-object body carries no dist-tags; reading one
        // as empty would report the install as current.
        if (!response.ok) throw registryUnavailable()
        const document: unknown = await response.json()
        if (typeof document !== "object" || document === null || Array.isArray(document)) {
          throw registryUnavailable()
        }
        return document as Record<string, string>
      },
      catch: registryUnavailable
    })
    return Update.compare(packageVersion, tags)
  })
