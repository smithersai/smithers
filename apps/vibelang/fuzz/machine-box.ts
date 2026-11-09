// Stays .ts: node:child_process and node:fs are Node host APIs. A Cloudflare container whose commands are real local
// processes, as packages/smithers/flows/platform-cloudflare/test/fixtures/ProcessContainer.ts, for fuzz targets only.
import { Data, Effect, Sink, Stream } from "effect"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Readable } from "node:stream"

export class BoxFailure extends Data.TaggedError("BoxFailure")<{ readonly operation: string }> {}
export type BoxFault = "start" | "stuck" | "setup" | "snapshot" | "destroy" | "exec" | "running"

const WORKSPACE = "/workspace"
const CALLS = "/var/lib/vibelang/calls"
const read = (stream: Readable): Stream.Stream<Uint8Array, BoxFailure> =>
  Stream.fromAsyncIterable(stream as AsyncIterable<Uint8Array>, () => new BoxFailure({ operation: "stream" })).pipe(Stream.map((chunk) => new Uint8Array(chunk)))

/** The container's paths are absolute in the product; here they live under one temporary directory. */
export function makeBox() {
  const root = mkdtempSync(join(tmpdir(), "vibelang-box-"))
  const workspace = join(root, "workspace")
  const calls = join(root, "calls")
  mkdirSync(workspace)
  mkdirSync(calls)
  const faults = new Set<BoxFault>()
  const state = { running: false, starts: 0, destroys: 0, snapshots: 0, restored: [] as Array<unknown>, executed: [] as Array<string> }
  const attempt = (fault: BoxFault, operation: string) => faults.has(fault) ? Effect.fail(new BoxFailure({ operation })) : Effect.void
  const box = {
    get running() { return Effect.flatMap(attempt("running", "running"), () => Effect.succeed(state.running)) },
    start: (options: { readonly containerSnapshot?: unknown }) => Effect.flatMap(attempt("start", "start"), () => Effect.sync(() => {
      state.starts += 1
      if (options.containerSnapshot !== undefined) state.restored.push(options.containerSnapshot)
      state.running = !faults.has("stuck")
    })),
    setInactivityTimeout: () => Effect.void,
    interceptOutboundHttp: () => Effect.void,
    interceptAllOutboundHttp: () => Effect.void,
    interceptOutboundHttps: () => Effect.void,
    destroy: () => Effect.sync(() => {
      state.destroys += 1
      if (!faults.has("destroy")) state.running = false
    }),
    snapshotContainer: () => Effect.flatMap(attempt("snapshot", "snapshot"), () => Effect.sync(() => ({ id: `snapshot-${++state.snapshots}` }))),
    exec: (argv: Array<string>, options: { readonly user?: string; readonly cwd?: string; readonly env?: Record<string, string>; readonly stdin?: "pipe" }) => Effect.gen(function*() {
      yield* attempt("exec", "exec")
      // Root's one command prepares the product's absolute directories, which exist here already.
      if (options.user === "0:0") return { stdin: undefined, stdout: undefined, stderr: undefined, exitCode: Effect.succeed(faults.has("setup") ? 1 : 0) }
      const script = argv.slice(1).map((part) => part.replaceAll(CALLS, calls).replaceAll(WORKSPACE, workspace))
      state.executed.push(script.at(-1) ?? "")
      const child = yield* Effect.acquireRelease(
        Effect.sync(() => spawn(argv[0]!, script, { cwd: (options.cwd ?? WORKSPACE).replace(WORKSPACE, workspace), env: { PATH: process.env.PATH, ...options.env, HOME: workspace }, stdio: [options.stdin === "pipe" ? "pipe" : "ignore", "pipe", "pipe"] })),
        (spawned) => Effect.sync(() => spawned.exitCode === null && spawned.kill("SIGKILL")),
      )
      const exited = new Promise<number>((resolve) => child.once("close", (code) => resolve(code ?? 137)))
      return {
        stdin: child.stdin === null ? undefined : Sink.forEach((chunk: Uint8Array) => Effect.promise(() => new Promise<void>((resolve) => child.stdin!.write(chunk, () => resolve())))).pipe(Sink.mapEffect(() => Effect.sync(() => void child.stdin!.end()))),
        stdout: read(child.stdout!), stderr: read(child.stderr!), exitCode: Effect.promise(() => exited),
      }
    }),
  }
  return { box, faults, state, dispose: () => rmSync(root, { recursive: true, force: true }) }
}

/** A Durable Object namespace; workerd throws from getByName when a binding is broken, which a target can ask for. */
export function namespaceOf<A>(healthy: () => boolean, stub: A): { getByName(name: string): A } {
  return { getByName: () => { if (!healthy()) throw new Error("no binding"); return stub } }
}
