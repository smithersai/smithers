/**
 * Retained external commands, independent of the acquiring scope.
 *
 * @since 1.0.0
 */

import * as CommandLine from "@smthrs/kernel/CommandLine"
import * as Effect from "effect/Effect"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { encodeBase64 } from "../internal/base64.ts"
import { pidDirectory } from "../internal/pidDirectory.ts"
import { sessionSlug } from "../internal/sessionSlug.ts"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import type { Provider } from "./Provider.ts"
import type { Session } from "./Session.ts"
import { capture, type CheckoutOptions, Work } from "./Work.ts"

/**
 * Schema for the identity needed to reattach a retained job.
 *
 * @category schemas
 * @since 1.0.0
 */
export const JobHandle = Schema.Struct({
  id: Schema.String,
  remoteId: Schema.String,
  workdir: Schema.String,
  directory: Schema.String
})
/**
 * The persisted identity of one retained job.
 *
 * @category models
 * @since 1.0.0
 */
export type JobHandle = typeof JobHandle.Type
/**
 * The collected output and checkout work of a completed job.
 *
 * @category schemas
 * @since 1.0.0
 */
export const JobResult = Schema.Struct({
  stdout: Schema.String,
  stderr: Schema.String,
  exitCode: Schema.Int,
  work: Work
})
/**
 * A completed job receipt, durable before machine teardown.
 *
 * @category models
 * @since 1.0.0
 */
export type JobResult = typeof JobResult.Type
/**
 * An observed live process, completed process, or proven loss.
 *
 * @category models
 * @since 1.0.0
 */
export type JobStatus = { readonly _tag: "Running" } | { readonly _tag: "Exited"; readonly exitCode: number } | {
  readonly _tag: "Lost"
}
/**
 * The command, input files, and checkout captured by a job.
 *
 * @category models
 * @since 1.0.0
 */
export interface JobOptions<Payload> {
  readonly command: string | ((payload: Payload, key: string) => string)
  readonly files?:
    | Readonly<Record<string, Uint8Array>>
    | ((payload: Payload, key: string) => Readonly<Record<string, Uint8Array>>)
    | undefined
  readonly capture?: CheckoutOptions & { readonly base?: string | undefined } | undefined
  /** Absolute directory outside the checkout. Default /var/lib/smthrs-jobs. */
  readonly jobDirectory?: string | undefined
}
const q = CommandLine.quote
const fail = (message: string, code: "unavailable" | "spawn_error" | "unknown" = "unavailable") =>
  new ProviderError({ code, message: `sandbox-job: ${message}` })
const run = (session: Session, command: string) =>
  Effect.scoped(Effect.gen(function*() {
    const child = yield* session.spawn(command, {})
    const [stdout, stderr, code] = yield* Effect.all([
      Stream.mkString(Stream.decodeText(child.stdout)),
      Stream.mkString(Stream.decodeText(child.stderr)),
      child.exitCode
    ], { concurrency: "unbounded" })
    return { stdout, stderr, code }
  }))
const receiptSchema = Schema.fromJsonString(JobResult)

/**
 * Create-or-get a command on a retained provider. Collect requires a durable,
 * shared KeyValueStore: its receipt is persisted before machine destruction.
 * An ephemeral provider is refused before any machine is acquired.
 *
 * @category constructors
 * @since 1.0.0
 */
export const job = <Payload = unknown>(provider: Provider, options: JobOptions<Payload>) => {
  if (provider.retained !== true || provider.attach === undefined || provider.destroy === undefined) {
    throw new TypeError("Sandbox.job requires a retained provider with attach and destroy")
  }
  const attach = provider.attach
  const destroy = provider.destroy
  const root = options.jobDirectory ?? provider.jobDirectory ?? "/var/lib/smthrs-jobs"
  if (!root.startsWith("/") || root.includes("\0") || root.split("/").includes("..")) {
    throw new TypeError("Sandbox.job jobDirectory must be an absolute normalized path")
  }
  if (root === pidDirectory || root.startsWith(`${pidDirectory}/`)) {
    throw new TypeError("Sandbox.job jobDirectory must be outside the transient pid directory")
  }
  const validate = (handle: JobHandle, key: string) =>
    handle.id === key && handle.directory === `${root}/${sessionSlug(key)}`
      ? Effect.void :
      Effect.fail(fail("job key or directory differs from handle", "unknown"))
  const readText = (session: Session, path: string) =>
    session.readFile(path).pipe(Effect.map((bytes) => new TextDecoder().decode(bytes)))
  return {
    start: (payload: Payload, key: string) =>
      Effect.scoped(Effect.gen(function*() {
        if (!key.trim()) return yield* Effect.fail(fail("key must not be empty", "spawn_error"))
        const command = typeof options.command === "function" ? options.command(payload, key) : options.command
        const files = typeof options.files === "function" ? options.files(payload, key) : options.files ?? {}
        for (const path of Object.keys(files)) {
          if (
            !path || path.includes("\0") || path.split("/").includes("..") || path === root ||
            path.startsWith(`${root}/`)
          ) {
            return yield* Effect.fail(
              fail("file paths cannot escape the checkout or overwrite job metadata", "spawn_error")
            )
          }
        }
        const session = yield* provider.acquire(key)
        const directory = `${root}/${sessionSlug(key)}`
        const checkout = options.capture?.checkout ?? session.workdir
        if (directory === checkout || directory.startsWith(`${checkout.replace(/\/$/, "")}/`)) {
          return yield* Effect.fail(fail("job directory must be outside the captured checkout", "spawn_error"))
        }
        const at = (name: string) => q(`${directory}/${name}`)
        const writes = Object.entries(files).map(([path, bytes]) => {
          const full = path.startsWith("/") ? path : `${session.workdir}/${path}`
          const parent = full.slice(0, full.lastIndexOf("/"))
          return `mkdir -p ${q(parent)} && printf %s ${q(encodeBase64(bytes))} | base64 -d >${q(full)} || abandon`
        }).join("\n")
        // Fence transport redelivery inside the detached worker, before opening
        // output files or publishing a pid. The admission mkdir alone cannot
        // prevent a transport from executing that launch more than once.
        // PID-only launch receipts distinguish redelivery from a new start.
        // Cancellation tombstones stay outside the checkout, including on local
        // directory teardown, so a delayed launcher cannot start work afterward.
        // Status and cancel address the worker's process group by its pid, so a
        // worker that does not lead a group refuses to run.
        const worker = `printf '%s\n' "$$" >>${at("launches")} || exit 125
kill -0 -$$ 2>/dev/null || { echo 'sandbox-job: the worker leads no process group: no setsid, and /bin/sh has no job control' >&2; exit 125; }
if mkdir ${at("worker")} 2>/dev/null; then :; elif test -d ${at("worker")}; then exit 0; else exit 125; fi
exec >${at("out")} 2>${at("err")} || exit 125
echo $$ >${at("pid.tmp")} && mv ${at("pid.tmp")} ${at("pid")} || exit 125
if test -e ${at("cancelled")}; then code=143; else
(
${command}
)
code=$?
fi
printf '%s\n' "$code" >${at("exit.tmp")} && mv ${at("exit.tmp")} ${at("exit")}`
        // The worker leads a session of its own where the guest has setsid, and
        // otherwise a process group of its own where /bin/sh has job control, as
        // macOS's does.
        const detach = `if command -v setsid >/dev/null 2>&1; then
setsid /bin/sh -c ${q(worker)} </dev/null >/dev/null 2>>${at("launch.err")} &
else
(set -m 2>/dev/null; /bin/sh -c ${q(worker)} </dev/null >/dev/null 2>>${at("launch.err")} &)
fi`
        // The mkdir winner records its launcher pid as `owner`. Any failure
        // before the worker claims its fence takes that fence, so no delayed
        // worker can run, and removes the directory, so a retry with this key
        // launches again. A tombstoned directory stays. A later start that finds
        // an unsettled directory whose owner is dead takes it over the same way.
        const script = `mkdir -p ${q(root)} || exit 125
abandon() {
cat ${at("launch.err")} >&2 2>/dev/null
if mkdir ${at("worker")} 2>/dev/null && test ! -e ${at("cancelled")}; then rm -rf ${q(directory)}; fi
exit 125
}
prepare() {
printf '%s\n' "$$" >${at("owner.tmp")} && mv ${at("owner.tmp")} ${at("owner")} || abandon
printf %s ${q(key)} >${at("key")} || abandon
cd ${q(checkout)} && git rev-parse --verify ${q(`${options.capture?.base ?? "HEAD"}^{commit}`)} >${
          at("base")
        } || abandon
${writes}
if test ! -e ${at("cancelled")}; then
${detach}
i=0; while test ! -f ${at("pid")}; do i=$((i+1)); test "$i" -lt 200 || abandon; sleep 0.01; done
fi
}
settled() { test -f ${at("pid")} || test -f ${at("exit")} || test -e ${at("cancelled")}; }
if mkdir ${q(directory)} 2>/dev/null; then
prepare
else
i=0; while test -d ${q(directory)} && test ! -f ${
          at("owner")
        } && ! settled; do i=$((i+1)); test "$i" -lt 200 || break; sleep 0.01; done
test -d ${q(directory)} || exit 125
if ! settled && ! kill -0 "$(cat ${at("owner")} 2>/dev/null)" 2>/dev/null; then
if mkdir ${at("worker")} 2>/dev/null && test ! -e ${at("cancelled")}; then
rm -rf ${q(directory)} && mkdir ${q(directory)} || exit 125
prepare
else
exit 125
fi
fi
fi`
        const result = yield* run(session, script)
        if (result.code !== 0) {
          return yield* Effect.fail(fail(`launcher failed (${result.code}): ${result.stderr}`, "spawn_error"))
        }
        const recorded = yield* readText(session, `${directory}/key`).pipe(
          Effect.catch((error) => error.code === "not_found" ? Effect.succeed(key) : Effect.fail(error))
        )
        if (recorded !== key) return yield* Effect.fail(fail("job directory belongs to another key", "unknown"))
        return { id: key, remoteId: session.remoteId, workdir: session.workdir, directory } satisfies JobHandle
      })),
    status: (handle: JobHandle, key: string): Effect.Effect<JobStatus, ProviderError> =>
      Effect.scoped(Effect.gen(function*() {
        yield* validate(handle, key)
        const session = yield* attach(handle)
        const result = yield* run(
          session,
          `if test -f ${q(`${handle.directory}/exit`)}; then printf 'Exited '; cat ${
            q(`${handle.directory}/exit`)
          }; elif test -f ${q(`${handle.directory}/pid`)} && kill -0 -$(cat ${
            q(`${handle.directory}/pid`)
          }) 2>/dev/null; then echo Running; else echo Lost; fi`
        )
        if (result.code !== 0) return yield* Effect.fail(fail(`status failed: ${result.stderr}`))
        const value = result.stdout.trim()
        if (value === "Running" || value === "Lost") return { _tag: value } satisfies JobStatus
        if (/^Exited -?\d+$/.test(value)) {
          return { _tag: "Exited", exitCode: Number(value.slice(7)) } satisfies JobStatus
        }
        return yield* Effect.fail(fail("invalid job status", "unknown"))
      })).pipe(
        Effect.catch((error) =>
          error.code === "not_found" ? Effect.succeed<JobStatus>({ _tag: "Lost" }) : Effect.fail(error)
        )
      ),
    collect: (handle: JobHandle, key: string, _exited: { readonly _tag: "Exited"; readonly exitCode: number }) =>
      Effect.gen(function*() {
        yield* validate(handle, key)
        const store = yield* KeyValueStore.KeyValueStore
        const receiptKey = `@smthrs/sandbox/job/collected/${encodeURIComponent(key)}`
        const stored = yield* store.get(receiptKey).pipe(
          Effect.mapError(() => fail("could not read collected receipt"))
        )
        let result: JobResult
        if (stored !== undefined) {
          result = yield* Schema.decodeEffect(receiptSchema)(stored).pipe(
            Effect.mapError(() => fail("invalid collected receipt", "unknown"))
          )
        } else {
          result = yield* Effect.scoped(Effect.gen(function*() {
            const session = yield* attach(handle)
            const [stdout, stderr, exit, base] = yield* Effect.all([
              readText(session, `${handle.directory}/out`),
              readText(session, `${handle.directory}/err`),
              readText(session, `${handle.directory}/exit`),
              readText(session, `${handle.directory}/base`)
            ], { concurrency: "unbounded" })
            if (!/^-?\d+\s*$/.test(exit)) return yield* Effect.fail(fail("invalid exit record", "unknown"))
            const work = yield* capture(session, { checkout: options.capture?.checkout, base: base.trim() })
            return { stdout, stderr, exitCode: Number(exit), work }
          }))
          const encoded = Schema.encodeSync(receiptSchema)(result)
          yield* store.set(receiptKey, encoded).pipe(Effect.mapError(() => fail("could not persist collected receipt")))
        }
        yield* destroy(handle)
        return result
      }),
    cancel: (handle: JobHandle, key: string) =>
      Effect.gen(function*() {
        yield* validate(handle, key)
        yield* Effect.scoped(Effect.gen(function*() {
          const session = yield* attach(handle)
          const d = handle.directory
          const result = yield* run(
            session,
            `mkdir -p ${q(d)} && touch ${q(`${d}/cancelled`)} || exit 125\nif test -f ${
              q(`${d}/pid`)
            }; then kill -TERM -$(cat ${q(`${d}/pid`)}) 2>/dev/null || true; fi\nsleep 2\nif test -f ${
              q(`${d}/pid`)
            }; then kill -KILL -$(cat ${q(`${d}/pid`)}) 2>/dev/null || true; fi`
          )
          if (result.code !== 0) return yield* Effect.fail(fail(`cancel failed: ${result.stderr}`))
        })).pipe(Effect.catch((error) => error.code === "not_found" ? Effect.void : Effect.fail(error)))
        yield* destroy(handle)
      })
  }
}
