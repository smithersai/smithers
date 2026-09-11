/**
 * Constructs the Kubernetes Pod sandbox provider.
 *
 * @since 0.1.0
 */
import * as CommandLine from "@smthrs/kernel/CommandLine"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { decodeBase64Bytes, encodeBase64Bytes } from "../internal/base64.ts"
import { configurationFingerprint } from "../internal/configurationFingerprint.ts"
import { environmentInput } from "../internal/environmentInput.ts"
import { checkEnvironmentNames } from "../internal/environmentNames.ts"
import { finalizeWithin } from "../internal/finalizeWithin.ts"
import { parentOf } from "../internal/guestPath.ts"
import { cancelGuard, killScript } from "../internal/killScript.ts"
import { gather, type GatheredRun, providerFailure, remoteProcessOf } from "../internal/localProcess.ts"
import { rootedAt } from "../internal/rootedPath.ts"
import { sessionSlug } from "../internal/sessionSlug.ts"
import type { RemoteProcess } from "../RemoteChildProcessSpawner/Provider.ts"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import type { Provider } from "../Sandbox/Provider.ts"
import type { Session } from "../Sandbox/Session.ts"

interface ResourceValues {
  readonly cpu?: string | undefined
  readonly memory?: string | undefined
}

/**
 * The Pod's CPU and memory requests and limits, as Kubernetes names them.
 *
 * @category models
 * @since 0.1.0
 */
export interface KubernetesSandboxResources {
  readonly requests?: ResourceValues | undefined
  readonly limits?: ResourceValues | undefined
}

/**
 * How the provider reaches its cluster and shapes each session's Pod.
 *
 * @category models
 * @since 0.1.0
 */
export interface KubernetesSandboxOptions {
  readonly spawner: ChildProcessSpawner["Service"]
  readonly image: string
  readonly namespace?: string | undefined
  readonly program?: string | undefined
  readonly context?: string | undefined
  readonly kubeconfig?: string | undefined
  readonly workdir?: string | undefined
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly labels?: Readonly<Record<string, string>> | undefined
  readonly resources?: KubernetesSandboxResources | undefined
  readonly serviceAccount?: string | undefined
  readonly nodeSelector?: Readonly<Record<string, string>> | undefined
  readonly createArgs?: ReadonlyArray<string> | undefined
  readonly namePrefix?: string | undefined
}

const decoder = new TextDecoder()
const pidDirectory = "/tmp/.smthrs-sbx"
const readyTimeout = "300s"
const maximumPodNameLength = 63
const fingerprintLabel = "smithers.dev/sandbox-fingerprint"
const inspectedPod = Schema.Struct({
  metadata: Schema.Struct({ labels: Schema.Record(Schema.String, Schema.String) }),
  spec: Schema.Struct({
    hostNetwork: Schema.optional(Schema.Boolean),
    hostPID: Schema.optional(Schema.Boolean),
    hostIPC: Schema.optional(Schema.Boolean),
    serviceAccountName: Schema.optional(Schema.String),
    containers: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        image: Schema.String,
        securityContext: Schema.optional(Schema.Struct({ privileged: Schema.optional(Schema.Boolean) }))
      })
    ),
    volumes: Schema.optional(Schema.Array(Schema.Struct({ hostPath: Schema.optional(Schema.Unknown) })))
  }),
  status: Schema.Struct({ phase: Schema.String })
})

/**
 * The phases in which a Pod will never run another command. A leftover in one
 * of these is a corpse wearing the session's name, not a machine to reattach:
 * `kubectl wait --for=condition=Ready` would block on it for the full timeout
 * and `exec` would refuse it, so it is deleted and replaced instead.
 */
const terminalPhases = new Set(["Succeeded", "Failed"])

const podNameOf = (prefix: string, sessionKey: string): string => {
  const slug = sessionSlug(sessionKey).toLowerCase().replaceAll(/[^a-z0-9-]/g, "-")
  const candidate = `${prefix.toLowerCase().replaceAll(/[^a-z0-9-]/g, "-")}${slug}`
    .replaceAll(/^-+|-+$/g, "")
  if (candidate.length <= maximumPodNameLength) return candidate
  const digest = slug.slice(slug.lastIndexOf("-"))
  return `${candidate.slice(0, maximumPodNameLength - digest.length).replace(/-+$/, "")}${digest}`
}

const overrideArgs = (name: string, options: KubernetesSandboxOptions): ReadonlyArray<string> => {
  const spec = {
    ...options.serviceAccount === undefined ? {} : { serviceAccountName: options.serviceAccount },
    ...options.nodeSelector === undefined ? {} : { nodeSelector: options.nodeSelector },
    ...options.resources === undefined
      ? {}
      : {
        containers: [{
          name,
          resources: {
            ...options.resources.requests === undefined ? {} : { requests: options.resources.requests },
            ...options.resources.limits === undefined ? {} : { limits: options.resources.limits }
          }
        }]
      }
  }
  return Object.keys(spec).length === 0
    ? []
    : ["--override-type", "strategic", "--overrides", JSON.stringify({ apiVersion: "v1", spec })]
}

/**
 * Builds a sandbox provider whose machines are Kubernetes Pods driven through
 * an injected `kubectl` spawner.
 *
 * The provider creates or reattaches a deterministically named Pod, waits for
 * it to become Ready, and registers forced deletion as the acquiring scope's
 * finalizer. A leftover Pod already in a terminal phase (Succeeded or Failed)
 * is not reattached: `kubectl wait` would block on it for its whole timeout,
 * so on `AlreadyExists` the provider inspects the phase and replaces a
 * terminal Pod with a fresh one. Commands and file transfers use
 * `kubectl exec`, so no host filesystem or platform module is required. File
 * contents cross the text boundary as base64 — written through the exec's
 * stdin, read back with `base64 < path`, a redirect every guest `base64`
 * accepts — and remain byte exact.
 *
 * `spawn` honors the whole session contract. A command's `stdin` bytes travel
 * on the exec's own input channel (`--stdin`), a relative `cwd` is rooted at
 * {@link Session.workdir} before the script's `cd`, and the environment is
 * applied with `env(1)` rather than `export`, because `export` is a special
 * builtin and a name it refuses would abort the whole script instead of one
 * assignment. Names that are not shell identifiers never reach either form:
 * `spawn` refuses them, because the guest `sh -c` that runs the command
 * would drop them. Closing a spawn's scope is the process's lifetime ending:
 * unless the command was already observed to end, the guest process is
 * signalled through the same pid-walk `kill` uses, so a scope cannot close on
 * a still-running guest.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: KubernetesSandboxOptions): Provider => {
  const program = options.program ?? "kubectl"
  const workdir = options.workdir ?? "/workspace"
  const prefix = options.namePrefix ?? "smthrs-sbx-"
  const globals = [
    ...options.context === undefined ? [] : ["--context", options.context],
    ...options.namespace === undefined ? [] : ["--namespace", options.namespace],
    ...options.kubeconfig === undefined ? [] : ["--kubeconfig", options.kubeconfig]
  ]
  const run = (args: ReadonlyArray<string>, stdin?: Uint8Array): Effect.Effect<GatheredRun, ProviderError> =>
    Effect.scoped(
      Effect.gen(function*() {
        const handle = yield* options.spawner.spawn(
          ChildProcess.make(program, [...globals, ...args], stdin === undefined ? {} : { stdin: Stream.make(stdin) })
        ).pipe(
          Effect.mapError(providerFailure("spawn_error", `\`${program} ${args[0]}\` could not start`))
        )
        return yield* gather(handle, `${program} ${args[0]}`)
      })
    )
  const step = (what: string, args: ReadonlyArray<string>): Effect.Effect<GatheredRun, ProviderError> =>
    Effect.flatMap(run(args), (result) =>
      result.code === 0 ? Effect.succeed(result) : Effect.fail(
        new ProviderError({
          code: "unavailable",
          message: `${what}: \`${program} ${args[0]}\` exited ${result.code}: ${result.stderr.trim()}`
        })
      ))

  return {
    acquire: (sessionKey) =>
      Effect.gen(function*() {
        const environment = options.env ?? {}
        const name = podNameOf(prefix, sessionKey)
        const fingerprint = yield* configurationFingerprint({
          provider: "KubernetesSandbox/v1",
          owner: sessionKey,
          name,
          image: options.image,
          workdir,
          namespace: options.namespace,
          context: options.context,
          kubeconfig: options.kubeconfig,
          env: environment,
          labels: options.labels ?? {},
          resources: options.resources,
          serviceAccount: options.serviceAccount,
          nodeSelector: options.nodeSelector,
          createArgs: options.createArgs ?? []
        })
        const labels = Object.entries({ ...options.labels, [fingerprintLabel]: fingerprint })
        const createArgs = [
          "run",
          name,
          "--image",
          options.image,
          "--restart",
          "Never",
          "--labels",
          labels.map(([key, value]) => `${key}=${value}`).join(","),
          ...overrideArgs(name, options),
          ...options.createArgs ?? [],
          "--command",
          "--",
          "sleep",
          "infinity"
        ]
        // Let kubectl render all run flags, then add environment values to
        // the manifest sent over stdin rather than its local argv.
        const create = Effect.gen(function*() {
          if (Object.keys(environment).length === 0) return yield* run(createArgs)
          yield* checkEnvironmentNames(environment)
          const commandIndex = createArgs.indexOf("--command")
          const rendered = yield* run([
            ...createArgs.slice(0, commandIndex),
            "--dry-run=client",
            "-o",
            "json",
            ...createArgs.slice(commandIndex)
          ])
          if (rendered.code !== 0) return rendered
          const manifest = yield* Effect.try({
            try: () => {
              const pod = JSON.parse(decoder.decode(rendered.stdout))
              const container = pod.spec.containers.find((entry: { name: string }) => entry.name === name)
              container.env = [
                ...(container.env ?? []).filter((entry: { name: string }) => !Object.hasOwn(environment, entry.name)),
                ...Object.entries(environment).map(([name, value]) => ({ name, value }))
              ]
              return new TextEncoder().encode(JSON.stringify(pod))
            },
            catch: providerFailure("spawn_error", "kubectl did not render a valid Pod manifest")
          })
          return yield* run(["create", "-f", "-"], manifest)
        })
        yield* Effect.acquireRelease(
          Effect.gen(function*() {
            const created = yield* create
            if (created.code === 0) return
            if (!/(?:AlreadyExists|already exists)/i.test(created.stderr)) {
              return yield* Effect.fail(
                new ProviderError({
                  code: "unavailable",
                  message: `the pod ${name} could not be created from ${options.image}: ${created.stderr.trim()}`
                })
              )
            }
            // The name is held by a previous acquire's leftover. A live one
            // is reattached; one in a terminal phase is replaced, because the
            // Ready wait below would otherwise block on it until its timeout.
            // Validate ownership before adopting OR deleting a terminal Pod.
            const inspected = yield* step(`the pod ${name} could not be inspected`, ["get", "pod", name, "-o", "json"])
            const held = yield* Effect.try({
              try: () => Schema.decodeUnknownSync(inspectedPod)(JSON.parse(decoder.decode(inspected.stdout))),
              catch: providerFailure("unavailable", `the pod ${name} has no verifiable configuration`)
            })
            if (
              held.metadata.labels[fingerprintLabel] !== fingerprint ||
              !held.spec.containers.some((container) => container.name === name && container.image === options.image) ||
              (options.serviceAccount !== undefined && held.spec.serviceAccountName !== options.serviceAccount) ||
              ((options.createArgs?.length ?? 0) === 0 && (held.spec.hostNetwork === true ||
                held.spec.hostPID === true || held.spec.hostIPC === true ||
                held.spec.containers.some((container) => container.securityContext?.privileged === true) ||
                held.spec.volumes?.some((volume) => volume.hostPath !== undefined)))
            ) {
              return yield* Effect.fail(
                new ProviderError({
                  code: "unavailable",
                  message: `the pod ${name} does not match the requested configuration or owner`
                })
              )
            }
            if (!terminalPhases.has(held.status.phase)) return
            yield* step(`the finished pod ${name} could not be replaced`, [
              "delete",
              `pod/${name}`,
              "--force",
              "--grace-period=0"
            ])
            const recreated = yield* create
            if (recreated.code !== 0) {
              return yield* Effect.fail(
                new ProviderError({
                  code: "unavailable",
                  message: `the pod ${name} could not be recreated from ${options.image}: ${recreated.stderr.trim()}`
                })
              )
            }
          }),
          () =>
            finalizeWithin(
              Effect.ignore(run(["delete", `pod/${name}`, "--force", "--grace-period=0"]), { log: "Warn" }),
              `pod ${name}`
            )
        )
        yield* step(`the pod ${name} did not become Ready`, [
          "wait",
          "--for=condition=Ready",
          `pod/${name}`,
          `--timeout=${readyTimeout}`
        ])
        yield* step(`the workspace ${workdir} could not be prepared in ${name}`, [
          "exec",
          name,
          "--",
          // The absolute path prevents a Pod-wide PATH override from
          // disabling the provider's own workspace-preparation shell.
          "/bin/sh",
          "-c",
          `mkdir -p ${CommandLine.quote(workdir)} && rm -rf ${pidDirectory} && mkdir -p ${pidDirectory}`
        ])

        let nextPidfile = 0
        const pidfiles = new WeakMap<RemoteProcess, string>()
        const resolveCwd = rootedAt(workdir)
        const deliver = (pidfile: string, signal: string): Effect.Effect<void, ProviderError> =>
          Effect.flatMap(
            run([
              "exec",
              name,
              "--",
              // The absolute path prevents a Pod-wide PATH override from
              // disabling the provider's own signal-delivery shell.
              "/bin/sh",
              "-c",
              killScript(pidfile, signal.replace(/^SIG/, ""))
            ]),
            (result) =>
              result.code === 0 ? Effect.void : Effect.fail(
                new ProviderError({
                  code: "unknown",
                  message: `the signal ${signal} could not be delivered in ${name}: ${result.stderr.trim()}`
                })
              )
          )
        const session: Session = {
          id: sessionKey,
          remoteId: name,
          workdir,
          spawn: Effect.fnUntraced(function*(command, spawnOptions) {
            yield* checkEnvironmentNames(spawnOptions.env)
            const pidfile = `${pidDirectory}/${nextPidfile++}.pid`
            const stdin = spawnOptions.stdin
            const entries = Object.entries(spawnOptions.env ?? {})
            const environment = [
              ...entries.flatMap(([key, value]) => value === undefined ? ["-u", CommandLine.quote(key)] : []),
              ...entries.flatMap(([key, value]) => value === undefined ? [] : [CommandLine.quote(`${key}=${value}`)])
            ]
            // `env(1)`, not `export`: `export` is a POSIX special builtin, so
            // a name it refuses ends the whole non-interactive script. `env`
            // carries any name to the process it starts, but the guest `sh -c`
            // rebuilds its environment from shell identifiers as it starts, so
            // `checkEnvironmentNames` refuses the rest up front rather than
            // letting the guest shell drop them unseen. GNU coreutils,
            // busybox, and BSD `env` all support `-u`, so an undefined value
            // deletes a variable the Pod was created with instead of keeping
            // it, which is what `undefined` means for a local command too.
            // Every `-u` precedes every assignment, because `env` stops
            // reading options at the first operand and `env A=1 -u B prog`
            // runs `-u` as the program. The shell after the prefix is absolute
            // for the reason the prefix exists at all: `env` resolves its
            // program through the environment it just built, so a caller's
            // `PATH` override would keep a bare `sh` from ever starting. The
            // pid survives the whole chain: `exec` replaces the recorded shell
            // with env, env replaces itself with `/bin/sh`, and `sh -c` execs
            // a lone simple command.
            const input = environmentInput(environment, stdin)
            const script = [
              `cd ${CommandLine.quote(resolveCwd(spawnOptions.cwd ?? ""))}`,
              `echo $$ > ${pidfile}`,
              cancelGuard(pidfile),
              `${input.script}exec ${input.prefix}/bin/sh -c ${CommandLine.quote(command)}`
            ].join(" && ")
            const handle = yield* options.spawner.spawn(
              ChildProcess.make(program, [
                ...globals,
                "exec",
                // The exec has a real input channel; it is asked for only
                // when there is input to carry.
                ...input.stdin === undefined ? [] : ["--stdin"],
                name,
                "--",
                // The absolute path prevents a Pod-wide PATH override from
                // disabling the provider's own command-wrapper shell.
                "/bin/sh",
                "-c",
                script
              ], input.stdin === undefined ? {} : { stdin: input.stdin })
            ).pipe(
              Effect.mapError(providerFailure("spawn_error", `\`${command}\` could not start in ${name}`))
            )
            const raw = remoteProcessOf(handle, command)
            let ended = false
            const process: RemoteProcess = {
              ...raw,
              exitCode: Effect.tap(raw.exitCode, () =>
                Effect.sync(() => {
                  ended = true
                }))
            }
            // Closing the process scope ends the local kubectl client, which
            // the guest does not notice. The contract says the scope IS the
            // process's lifetime, so the finalizer signals the guest side
            // too, unless the command has already been seen to end.
            yield* Effect.addFinalizer(() =>
              ended
                ? Effect.void
                : finalizeWithin(
                  Effect.ignore(deliver(pidfile, "SIGTERM"), { log: "Warn" }),
                  `pod ${name} process ${pidfile}`
                )
            )
            pidfiles.set(process, pidfile)
            return process
          }),
          kill: (process, signal) =>
            Effect.suspend(() => {
              const pidfile = pidfiles.get(process)
              /* v8 ignore next 3 -- every process returned by spawn is recorded and there is no other process source */
              if (pidfile === undefined) {
                return Effect.fail(new ProviderError({ code: "unknown", message: "unrecognized process" }))
              }
              return deliver(pidfile, signal)
            }),
          readFile: (path) =>
            Effect.flatMap(
              run([
                "exec",
                name,
                "--",
                // The absolute path prevents a Pod-wide PATH override from
                // disabling the provider's own file-read shell.
                "/bin/sh",
                "-c",
                // Redirected, not positional: BSD `base64` takes no file
                // operand, and the redirect reads the same on every guest.
                `test -e ${CommandLine.quote(path)} || exit 9; base64 < ${CommandLine.quote(path)}`
              ]),
              (result) =>
                result.code === 0
                  ? decodeBase64Bytes(result.stdout, `for ${path}`)
                  : result.code === 9
                  ? Effect.fail(new ProviderError({ code: "not_found", message: `the pod holds nothing at ${path}` }))
                  : Effect.fail(
                    new ProviderError({
                      code: "unknown",
                      message: `the pod could not read ${path}: ${result.stderr.trim()}`
                    })
                  )
            ),
          writeFile: (path, content) =>
            Effect.scoped(
              Effect.gen(function*() {
                const parent = parentOf(path)
                const script = parent === undefined
                  ? `base64 -d > ${CommandLine.quote(path)}`
                  : `mkdir -p ${CommandLine.quote(parent)} && base64 -d > ${CommandLine.quote(path)}`
                const handle = yield* options.spawner.spawn(
                  ChildProcess.make(program, [
                    ...globals,
                    "exec",
                    "-i",
                    name,
                    "--",
                    // The absolute path prevents a Pod-wide PATH override
                    // from disabling the provider's own file-write shell.
                    "/bin/sh",
                    "-c",
                    script
                  ], {
                    stdin: Stream.make(encodeBase64Bytes(content))
                  })
                ).pipe(Effect.mapError(providerFailure("spawn_error", `the write to ${path} could not start`)))
                const result = yield* gather(handle, script)
                if (result.code !== 0) {
                  return yield* Effect.fail(
                    new ProviderError({
                      code: "unknown",
                      message: `the pod could not write ${path}: ${result.stderr.trim()}`
                    })
                  )
                }
              })
            ),
          ping: Effect.flatMap(run(["exec", name, "--", "true"]), (result) =>
            result.code === 0 ? Effect.void : Effect.fail(
              new ProviderError({
                code: "unavailable",
                message: `the pod ${name} did not answer: ${result.stderr.trim()}`
              })
            ))
        }
        return session
      })
  }
}
