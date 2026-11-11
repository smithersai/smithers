/**
 * The machines `S.Remotes` declares, offered to the actions this host runs.
 *
 * The same declaration `smthrs ci --remote` reads. The workspace file is
 * evaluated the first time an action asks for a remote, never at startup, so
 * a host whose flows reach no machine never loads it. Each remote's transport
 * is spawned with the host's own contained spawner, not the confined one an
 * action's commands get: the operator declared the transport, and
 * `remote:acquire:<name>` (checked by `Remotes.make`) is what admits
 * an action to it.
 *
 * @since 1.0.0
 * @private
 */

import type * as PackageDiscovery from "@smthrs/build-cli/PackageDiscovery"
import type * as PackageLoader from "@smthrs/build-cli/PackageLoader"
import { digestSync } from "@smthrs/crypto/Sha256"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import { CommandSandbox, HttpSandbox, RemoteChildProcessSpawner, Remotes, type Sandbox } from "@smthrs/sandbox"
import type * as WorkspaceDeclaration from "@smthrs/targets/WorkspaceDeclaration"
import * as Effect from "effect/Effect"
import { HttpClient } from "effect/http/HttpClient"
import * as Layer from "effect/Layer"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"

type Declared = Readonly<Record<string, WorkspaceDeclaration.RemoteDeclaration>>

const { ProviderError } = RemoteChildProcessSpawner

// `S.Workspace`'s `remotes`, read from the project's workspace file.
const load = async (root: string): Promise<Declared> => {
  const discovery: typeof PackageDiscovery = await import("@smthrs/build-cli/PackageDiscovery")
  const loader: typeof PackageLoader = await import("@smthrs/build-cli/PackageLoader")
  const file = await discovery.workspaceFileOf(root)
  if (file === undefined) return {}
  return (await loader.loadWorkspaceDeclaration(root, file)).remotes?.remotes ?? {}
}

// The guest directory and machine a session key names. A key is the caller's
// free text, so the directory carries a readable prefix and a digest that
// keeps two keys apart.
const placement = (session: string, machines: number) => {
  const digest = digestSync(session)
  const readable = session.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 48)
  return {
    directory: `${readable}-${digest.slice(0, 12)}`,
    machine: Number.parseInt(digest.slice(0, 8), 16) % machines
  }
}

const providerOf = (
  declared: Declared,
  remote: string,
  session: string,
  environment: Readonly<Record<string, string | undefined>>,
  spawner: ChildProcessSpawner["Service"],
  client: HttpClient
): Effect.Effect<Sandbox.Provider, RemoteChildProcessSpawner.ProviderError> => {
  const declaration = Object.hasOwn(declared, remote) ? declared[remote] : undefined
  if (declaration === undefined) {
    const names = Object.keys(declared)
    return Effect.fail(
      new ProviderError({
        code: "not_found",
        message: `the workspace declares no remote ${JSON.stringify(remote)}; ${
          names.length === 0 ? "it declares none" : `it declares ${names.join(", ")}`
        } (S.Workspace remotes)`
      })
    )
  }
  if (declaration._tag === "RemoteCommand") {
    const { directory, machine } = placement(session, declaration.machines.length)
    return Effect.succeed(CommandSandbox.make({
      spawner,
      prefix: declaration.machines[machine]!,
      workdir: `${declaration.workdir.replace(/\/+$/, "")}/${directory}`,
      name: `remote ${remote}`
    }))
  }
  const token = environment[declaration.token.env] || declaration.token.fallback
  if (token === undefined) {
    return Effect.fail(
      new ProviderError({
        code: "unavailable",
        message: `remote ${remote}'s token is not set: export ${declaration.token.env}`
      })
    )
  }
  return Effect.succeed(HttpSandbox.make({
    url: declaration.url,
    token,
    client,
    limits: declaration.limits
  }))
}

/**
 * Provides `Remotes.Remotes` over the remotes the project at `root` declares.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (options: {
  readonly root: string
  readonly environment: Readonly<Record<string, string | undefined>>
}): Layer.Layer<Remotes.Remotes, never, GrantStore.GrantStore | ChildProcessSpawner | HttpClient> =>
  Layer.effect(Remotes.Remotes)(Effect.gen(function*() {
    const grants = yield* GrantStore.GrantStore
    const spawner = yield* ChildProcessSpawner
    const client = yield* HttpClient
    const declared = yield* Effect.cached(Effect.tryPromise({
      try: () => load(options.root),
      catch: (cause) =>
        new ProviderError({
          code: "unavailable",
          message: `the workspace's remotes could not be read: ${String(cause)}`
        })
    }))
    return Remotes.make({
      grants,
      provider: (remote, session) =>
        Effect.flatMap(
          declared,
          (remotes) => providerOf(remotes, remote, session, options.environment, spawner, client)
        )
    })
  }))
