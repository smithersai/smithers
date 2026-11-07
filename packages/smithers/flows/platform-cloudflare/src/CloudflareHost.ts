import type * as SecureRandom from "effect/crypto/SecureRandom"
/**
 * The closed Host surface for a Cloudflare Worker or Durable Object.
 *
 * A Worker has WebCrypto, `fetch` and nothing else a flow host usually
 * reaches for: no filesystem, no child processes and no jj. This bundle
 * provides the same five Host tags `NodeHost`, `BunHost` and `BrowserHost`
 * provide, plus `effect/Crypto` and the engine's `OwnerIdentity`, so the
 * durable engine composes on Cloudflare exactly as it does elsewhere. The
 * three services a Worker cannot serve are present and refuse every call, so
 * a flow that reaches for one meets a typed failure at the call instead of a
 * missing-service defect at composition.
 *
 * @since 1.0.0
 */

import { WebCrypto } from "@smthrs/crypto"
import { OwnerIdentity } from "@smthrs/engine-store"
import * as Jj from "@smthrs/jj"
import type * as EffectDigest from "effect/crypto/Digest"
import type { FileSystem } from "effect/FileSystem"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import type { HttpClient } from "effect/http/HttpClient"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import * as Refusals from "./internal/Refusals.ts"

/**
 * The services {@link layer} provides: the five closed Host tags, `Crypto`,
 * and the engine's `OwnerIdentity`.
 *
 * @category models
 * @since 1.0.0
 */
export type CloudflareHost =
  | FileSystem
  | Path.Path
  | ChildProcessSpawner
  | Jj.Jj
  | HttpClient
  | (EffectDigest.Digest | SecureRandom.SecureRandom)
  | OwnerIdentity.OwnerIdentity

/** Effect's fetch client, told never to follow a redirect on its own. */
const layerHttpClient: Layer.Layer<HttpClient> = Layer.provide(
  FetchHttpClient.layer,
  Layer.succeed(FetchHttpClient.RequestInit)({ redirect: "manual" })
)

/**
 * Provides the closed Host surface on Cloudflare.
 *
 * - `Crypto` is WebCrypto: `WebCrypto.layer` from `@smthrs/crypto`, which
 *   reads randomness only when a caller asks for it.
 * - `OwnerIdentity` is `OwnerIdentity.layerWithoutPid`: a Worker has no
 *   process id, and the one `nodejs_compat` reports can be the same for two
 *   isolates of one object, so every owner carries a drawn incarnation
 *   number instead. `Ownership.singleIncarnationLiveness`, the engine's
 *   liveness check here, relies on the difference.
 * - `Path` is Effect's POSIX path service.
 * - `HttpClient` is Effect's fetch client with `redirect: "manual"`, so a
 *   `3xx` comes back to the caller and the capability kernel decides every hop.
 * - `FileSystem` fails every call with a `PermissionDenied` `PlatformError`,
 *   and `ChildProcessSpawner` fails every spawn with a `NotFound` one; both
 *   describe themselves as `not_installed`. `Jj` fails every operation with
 *   `JjError` code `not_installed`.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer: Layer.Layer<CloudflareHost> = Layer.mergeAll(
  OwnerIdentity.layerWithoutPid,
  Path.layer,
  layerHttpClient,
  Refusals.layerFileSystem,
  Refusals.layerChildProcessSpawner,
  Jj.layerNoop({})
).pipe(Layer.provideMerge(WebCrypto.layer))
