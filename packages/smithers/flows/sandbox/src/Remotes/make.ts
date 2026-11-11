/**
 * Constructs the declared-machines service.
 *
 * @since 1.0.0
 */

import * as Capability from "@smthrs/capability/Capability"
import type { PermissionError } from "@smthrs/capability/Permission"
import type * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import type { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import type { Provider } from "../Sandbox/Provider.ts"
import type { Session } from "../Sandbox/Session.ts"

/**
 * The declared machines, by remote name.
 *
 * `acquire` opens a session under `session` on a machine of the remote named
 * `remote`, for the acquiring scope. The same key lands on the same machine
 * and the same guest directory, so a retried action resumes where it was.
 * It fails with a `PermissionError` when the calling action may not
 * `remote:acquire` that name, and with `ProviderError` `not_found` when the
 * workspace declares no such remote.
 *
 * @category services
 * @since 1.0.0
 */
export interface Remotes {
  readonly acquire: (
    remote: string,
    session: string
  ) => Effect.Effect<Session, ProviderError | PermissionError, Scope.Scope>
}

/**
 * Service key for the declared machines.
 *
 * @category services
 * @since 1.0.0
 */
export const Remotes: Context.Service<Remotes, Remotes> = Context.Service("@smthrs/sandbox/Remotes")

/**
 * What {@link make} closes over.
 *
 * @category models
 * @since 1.0.0
 */
export interface MakeOptions {
  /** The grant store whose current ceiling the capability is checked against. */
  readonly grants: GrantStore.Service
  /**
   * The provider for one session on a declared remote. Fails with
   * `not_found` for a name the workspace does not declare.
   */
  readonly provider: (remote: string, session: string) => Effect.Effect<Provider, ProviderError>
}

/**
 * Builds {@link Remotes} over a host's providers. The capability check comes
 * first, so a refused action starts no transport and asks for no provider.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (options: MakeOptions): Remotes => ({
  acquire: (remote, session) =>
    Effect.suspend(() => options.grants.check(Capability.make("remote:acquire", remote), { session })).pipe(
      Effect.andThen(options.provider(remote, session)),
      Effect.flatMap((provider) => provider.acquire(session))
    )
})
