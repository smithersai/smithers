/**
 * Builds a Cloudflare Sandbox provider.
 *
 * @since 0.1.0
 */

import * as CommandLine from "@smthrs/kernel/CommandLine"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { attemptIn } from "../internal/attempt.ts"
import { decodeBase64, encodeBase64 } from "../internal/base64.ts"
import { environmentCommand } from "../internal/environmentCommand.ts"
import { checkEnvironmentNames } from "../internal/environmentNames.ts"
import { finalizeWithin } from "../internal/finalizeWithin.ts"
import { parentOf } from "../internal/guestPath.ts"
import { rootedAt } from "../internal/rootedPath.ts"
import { sessionSlug } from "../internal/sessionSlug.ts"
import { stdinRedirect } from "../internal/stdinRedirect.ts"
import { warnTeardown } from "../internal/teardownWarning.ts"
import type { RemoteProcess } from "../RemoteChildProcessSpawner/Provider.ts"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import { type NetworkPolicy, refuseNetworkPolicy } from "../Sandbox/NetworkPolicy.ts"
import type { Provider } from "../Sandbox/Provider.ts"
import { refuseResourceLimits, type ResourceLimits } from "../Sandbox/ResourceLimits.ts"
import type { Session } from "../Sandbox/Session.ts"
import type { Sdk } from "./Sdk.ts"

/**
 * One instance type the Worker deployed: its `containers[].instance_type`
 * size and the Durable Object binding that serves it.
 *
 * `name` is the caller's label for diagnostics and becomes the prefix of
 * every remote id; `cpus` and `memoryMib` must match what the Worker
 * deployed, because the provider selects by them and cannot read them back.
 *
 * @category models
 * @since 1.0.0
 */
export interface CloudflareSandboxInstance<Binding> {
  readonly name: string
  readonly cpus: number
  readonly memoryMib: number
  readonly binding: Binding
}

/**
 * How the provider reaches its Worker binding and shapes each session's
 * Durable Object sandbox.
 *
 * Pass `binding` for one Worker binding of undeclared size, or `instances`
 * for the sizes the Worker deployed; never both.
 *
 * @category models
 * @since 0.1.0
 */
export interface CloudflareSandboxOptions<Binding> {
  /**
   * Restrictions refused: egress control lives on the Worker's Sandbox class, outside this provider. `"none"` or an allowlist makes `make` throw rather than hand
   * out a machine with a network it did not ask for; `"open"`, which restricts nothing, is accepted.
   */
  readonly network?: NetworkPolicy | undefined
  /**
   * With `instances`, `cpus` and `memoryMib` select the smallest declared
   * instance that has at least both; see {@link selectInstance}. With
   * `binding`, whose size is undeclared, they are refused. `timeoutSecs` is
   * always refused: `sleepAfter` is an idle timeout, not a lifetime. A refused
   * ceiling makes `make` throw rather than hand out a machine without it.
   */
  readonly limits?: ResourceLimits | undefined
  readonly sdk: Sdk<Binding>
  /** The Durable Object binding of a Worker whose instance type is not declared. */
  readonly binding?: Binding | undefined
  /** The instance types the Worker deployed, the first being the default. */
  readonly instances?: ReadonlyArray<CloudflareSandboxInstance<Binding>> | undefined
  /**
   * Scope closure leaves the sandbox running. The provider then supplies
   * `attach`, which reaches the same Durable Object without preparing it, and
   * an idempotent `destroy`.
   */
  readonly retained?: true | undefined
  readonly execution?: "exec" | "process" | undefined
  readonly workdir?: string | undefined
  readonly sleepAfter?: string | number | undefined
  readonly keepAlive?: boolean | undefined
}

const refuse = (message: string): never => {
  throw new TypeError(`cloudflare-sandbox: ${message}`)
}

const lifetimeReason = "`sleepAfter` is an idle timeout, not a lifetime"

/**
 * Validates declared instance types and returns the one `limits` selects.
 *
 * Without a requested `cpus` or `memoryMib`, the first declared instance is
 * selected. Otherwise the selection is the smallest instance, ordered by
 * `cpus` and then `memoryMib`, that has at least every requested ceiling. A
 * request no instance holds, a `timeoutSecs`, or a malformed declaration
 * throws a `TypeError`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const selectInstance = <Binding>(
  instances: ReadonlyArray<CloudflareSandboxInstance<Binding>>,
  limits?: ResourceLimits | undefined
): CloudflareSandboxInstance<Binding> => {
  if (instances.length === 0) refuse("instances must declare at least one instance type")
  const names = new Set<string>()
  for (const { cpus, memoryMib, name } of instances) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) refuse(`instance names must match [A-Za-z0-9._-]+: ${JSON.stringify(name)}`)
    if (names.has(name)) refuse(`instances declare ${name} twice`)
    names.add(name)
    if (!Number.isFinite(cpus) || cpus <= 0) refuse(`instance ${name} cpus must be a positive number: ${cpus}`)
    if (!Number.isInteger(memoryMib) || memoryMib <= 0) {
      refuse(`instance ${name} memoryMib must be a positive integer: ${memoryMib}`)
    }
  }
  const { cpus, memoryMib } = refuseResourceLimits("cloudflare-sandbox", limits, ["timeoutSecs"], lifetimeReason) ??
    {}
  if (cpus === undefined && memoryMib === undefined) return instances[0]!
  const holding = instances
    .filter((instance) => instance.cpus >= (cpus ?? 0) && instance.memoryMib >= (memoryMib ?? 0))
    .sort((left, right) => left.cpus - right.cpus || left.memoryMib - right.memoryMib)
  return holding[0] ?? refuse(
    `no declared instance has at least ${
      [...cpus === undefined ? [] : [`${cpus} cpus`], ...memoryMib === undefined ? [] : [`${memoryMib} MiB`]]
        .join(" and ")
    }; declared: ${
      instances.map((instance) => `${instance.name} (${instance.cpus} cpus, ${instance.memoryMib} MiB)`).join(", ")
    }`
  )
}

const encoder = new TextEncoder()

const failed = (code: ProviderError["code"], message: string, cause: unknown): ProviderError =>
  new ProviderError({ code, message: `cloudflare sandbox: ${message}`, cause })

const attempt = attemptIn("cloudflare sandbox")

const errorCodeOf = (cause: unknown): unknown =>
  typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined

const processOf = (stdout: string, stderr: string, exitCode: number): RemoteProcess => ({
  stdout: Stream.make(encoder.encode(stdout)),
  stderr: Stream.make(encoder.encode(stderr)),
  exitCode: Effect.succeed(exitCode)
})

/**
 * Builds a provider backed by Cloudflare Sandbox Durable Objects.
 *
 * The Worker binding is the credential and infrastructure handle; with
 * `instances`, the selected instance's binding is, and its name prefixes the
 * remote id. Acquiring a session resolves its key-derived Durable Object id,
 * disables the SDK's implicit default shell session, and registers
 * `destroy()` on the acquiring scope. A `retained` provider registers nothing:
 * `attach` resolves the same Durable Object without creating the workdir, and
 * `destroy` ends it. The SDK cannot tell a running container from one
 * Cloudflare stopped after `sleepAfter`, so a command after such a stop runs
 * on a fresh container with an empty disk. `exec` mode uses the completed command result. `process` mode waits
 * for the detached handle and fetches its logs before it reports an outcome,
 * and a handle that reports no exit status at all is a provider failure, not
 * an invented one.
 *
 * The SDK's command options carry no input channel, so `spawn` stages
 * `options.stdin` as a temporary file outside the checkout and redirects the command from it, and
 * a relative `cwd` is rooted at the session workdir. File payloads use the
 * SDK's base64 encoding and the text is read from the result's `content`
 * field. This preserves arbitrary bytes without importing host modules.
 *
 * Command output is not byte-exact here. The SDK reports a command's stdout
 * and stderr as strings, so what this provider streams is those strings
 * re-encoded as UTF-8: a command whose output is not valid UTF-8, such as a
 * tarball or a compiled binary written to stdout, comes back changed. File
 * transfer is byte-exact regardless, so a caller that needs bytes has the
 * command write a file and reads it back with `readFile`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <Binding>(options: CloudflareSandboxOptions<Binding>): Provider => {
  refuseNetworkPolicy("cloudflare-sandbox", options.network)
  if ((options.binding === undefined) === (options.instances === undefined)) {
    refuse("pass exactly one of `binding` and `instances`")
  }
  if (options.instances === undefined) {
    refuseResourceLimits(
      "cloudflare-sandbox",
      options.limits,
      ["cpus", "memoryMib", "timeoutSecs"],
      `the Worker's \`containers[].instance_type\` sets CPU and memory, and ${lifetimeReason}`
    )
  }
  const selected = options.instances === undefined ? undefined : selectInstance(options.instances, options.limits)
  const placement = selected === undefined
    ? { binding: options.binding as Binding, prefix: "" }
    : { binding: selected.binding, prefix: `${selected.name}-` }
  const workdir = options.workdir ?? "/workspace"
  const remoteIdOf = (sessionKey: string): string => `${placement.prefix}${sessionSlug(sessionKey)}`

  const resolve = (remoteId: string) =>
    Effect.try({
      try: () =>
        options.sdk.getSandbox(placement.binding, remoteId, {
          enableDefaultSession: false,
          ...options.keepAlive === undefined ? {} : { keepAlive: options.keepAlive },
          ...options.sleepAfter === undefined ? {} : { sleepAfter: options.sleepAfter }
        }),
      catch: (cause) => failed("unavailable", `could not resolve ${remoteId}`, cause)
    })

  // A retained identity names this provider's instance type and key; any
  // other would resolve, and so boot, an unrelated Durable Object.
  const identified = (session: Pick<Session, "id" | "remoteId">): Effect.Effect<string, ProviderError> =>
    session.remoteId === remoteIdOf(session.id)
      ? Effect.succeed(session.remoteId)
      : Effect.fail(
        failed("spawn_error", `${session.remoteId} is not this provider's sandbox for ${session.id}`, undefined)
      )

  const sessionOf = (
    sessionKey: string,
    remoteId: string,
    sandbox: ReturnType<Sdk<Binding>["getSandbox"]>
  ): Session => {
    const writeFile: Session["writeFile"] = (path, content) =>
      Effect.gen(function*() {
        const parent = parentOf(path)
        if (parent !== undefined) {
          yield* attempt(
            () => sandbox.mkdir(parent, { recursive: true }),
            "unknown",
            `could not create the parent of ${path}`
          )
        }
        yield* attempt(
          () => sandbox.writeFile(path, encodeBase64(content), { encoding: "base64" }),
          "unknown",
          `could not write ${path}`
        )
      })

    // The SDK's exec and process options carry no standard input, so the
    // bytes are staged as a temporary file outside the checkout and the command reads from it.
    const redirect = stdinRedirect({
      workdir,
      writeFile,
      remove: (path) =>
        Effect.flatMap(
          attempt(() => sandbox.exec(`rm -f ${CommandLine.quote(path)}`), "unknown", `could not remove ${path}`),
          (result) =>
            result.exitCode === 0 ? Effect.void : Effect.fail(
              failed("unknown", `could not remove ${path}: command exited ${result.exitCode}`, undefined)
            )
        )
    })
    const resolveCwd = rootedAt(workdir)

    const spawn: Session["spawn"] = (command, spawnOptions) =>
      Effect.flatMap(
        Effect.andThen(checkEnvironmentNames(spawnOptions.env), redirect(command, spawnOptions.stdin)),
        (fed) => {
          const guest = environmentCommand(fed, spawnOptions.env)
          const commandOptions = {
            cwd: resolveCwd(spawnOptions.cwd ?? ""),
            env: guest.env
          }
          return options.execution === "process"
            ? Effect.flatMap(
              attempt(
                async () => {
                  const started = await sandbox.startProcess(guest.command, commandOptions)
                  const exit = await started.waitForExit()
                  const logs = await started.getLogs()
                  return {
                    ...logs,
                    exitCode: exit.exitCode ?? started.exitCode
                  }
                },
                "spawn_error",
                `process failed for ${command}`
              ),
              (result) =>
                result.exitCode === undefined
                  ? Effect.fail(
                    failed("spawn_error", `the sandbox reported no exit status for \`${command}\``, result)
                  )
                  : Effect.succeed(processOf(result.stdout, result.stderr, result.exitCode))
            )
            : Effect.map(
              attempt(
                () => sandbox.exec(guest.command, commandOptions),
                "spawn_error",
                `exec failed for ${command}`
              ),
              (result) => processOf(result.stdout, result.stderr, result.exitCode)
            )
        }
      )

    const session: Session = {
      id: sessionKey,
      remoteId,
      workdir,
      spawn,
      readFile: (path) =>
        Effect.flatMap(
          Effect.tryPromise({
            try: () => sandbox.readFile(path, { encoding: "base64" }),
            catch: (cause) =>
              errorCodeOf(cause) === "FILE_NOT_FOUND"
                ? failed("not_found", `nothing exists at ${path}`, cause)
                : failed("unknown", `could not read ${path}`, cause)
          }),
          (result) => decodeBase64(result.content, `for ${path}`)
        ),
      writeFile,
      ping: Effect.flatMap(
        attempt(() => sandbox.exec("true", { cwd: workdir }), "unavailable", `could not ping ${remoteId}`),
        (result) =>
          result.exitCode === 0
            ? Effect.void
            : Effect.fail(failed("unavailable", `${remoteId} failed its ping`, result))
      )
    }
    return session
  }

  return {
    acquire: (sessionKey) =>
      Effect.gen(function*() {
        const remoteId = remoteIdOf(sessionKey)
        const sandbox = yield* options.retained === true ? resolve(remoteId) : Effect.acquireRelease(
          resolve(remoteId),
          (sandbox) =>
            finalizeWithin(
              Effect.ignore(
                attempt(() => sandbox.destroy(), "unknown", `could not destroy ${remoteId}`).pipe(
                  Effect.tapError((error) => warnTeardown("cloudflare", "destroy", error))
                )
              ),
              `cloudflare sandbox ${remoteId}`
            )
        )
        yield* attempt(
          () => sandbox.mkdir(workdir, { recursive: true }),
          "unavailable",
          `could not create ${workdir}`
        )
        return sessionOf(sessionKey, remoteId, sandbox)
      }),
    ...options.retained === true ?
      {
        retained: true as const,
        attach: (session: Pick<Session, "id" | "remoteId">) =>
          Effect.flatMap(
            identified(session),
            (remoteId) => Effect.map(resolve(remoteId), (sandbox) => sessionOf(session.id, remoteId, sandbox))
          ),
        destroy: (session: Pick<Session, "id" | "remoteId">) =>
          Effect.flatMap(
            identified(session),
            (remoteId) =>
              Effect.flatMap(
                resolve(remoteId),
                (sandbox) => attempt(() => sandbox.destroy(), "unavailable", `could not destroy ${remoteId}`)
              )
          )
      } :
      {}
  }
}
