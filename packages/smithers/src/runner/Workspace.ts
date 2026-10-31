/**
 * A job's checkout: one jj workspace of the repository's local mirror per
 * step, at the job's base commit, shared by every generation of the step, and
 * the change read back from it.
 *
 * jj runs with no user configuration, so a host's own settings never change
 * what a checkout holds or what its diff says.
 *
 * @since 1.0.0
 */

import type * as AgentRunner from "@smthrs/agent/AgentRunner"
import { resolveJjBinary } from "@smthrs/jj/node/resolveJjBinary"
import { Effect, Schema } from "effect"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve, sep } from "node:path"

/**
 * A jj command failed, or a path left the checkout.
 *
 * @category errors
 * @since 1.0.0
 */
export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()("@smthrs/cli/Runner/WorkspaceError", {
  step: Schema.Literals(["fetch", "add", "diff", "read", "forget"])
}) {}

/**
 * The checkout's name and directory for the step whose key's origin is
 * `origin`: the first 16 hex of the origin's SHA-256, under `<state>/work`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const of = (stateDir: string, origin: string) => {
  const name = `job-${createHash("sha256").update(origin).digest("hex").slice(0, 16)}`
  const dir = join(stateDir, "work", name)
  return { name, dir, checkpoint: `${dir}.acp.json` }
}

/**
 * The checkout of one step: its workspace name, its directory, and its
 * session checkpoint beside it.
 *
 * @category models
 * @since 1.0.0
 */
export type Checkout = ReturnType<typeof of>

/** One command's exit code and output. */
interface Ran {
  readonly code: number
  readonly stdout: string
}

/**
 * Runs `jj args` with no user configuration, for at most `timeoutMs`, in `cwd`
 * when set: its exit code and stdout. Interrupted, it kills the command.
 *
 * @category constructors
 * @since 1.0.0
 */
export const jj = (args: ReadonlyArray<string>, timeoutMs = 120_000, cwd?: string): Effect.Effect<Ran> =>
  Effect.callback<Ran>((resume, signal) => {
    // An empty configuration directory: jj reads no user or host settings.
    const config = join(tmpdir(), "smithers-runner-jj-config")
    mkdirSync(config, { recursive: true })
    execFile(
      resolveJjBinary().path,
      [
        ...args,
        "--no-pager",
        "--color=never",
        "--config",
        "user.name=smithers-runner",
        "--config",
        "user.email=runner@localhost"
      ],
      {
        signal,
        timeout: timeoutMs,
        ...(cwd === undefined ? {} : { cwd }),
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, JJ_CONFIG: config }
      },
      (error, stdout) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1
        resume(Effect.succeed({ code, stdout: String(stdout) }))
      }
    )
  })

const ok = (step: WorkspaceError["step"]) => (ran: Ran) =>
  ran.code === 0
    ? Effect.succeed(ran.stdout)
    : Effect.logWarning("runner.workspace").pipe(
      Effect.annotateLogs({ step, exitCode: ran.code }),
      Effect.andThen(Effect.fail(new WorkspaceError({ step })))
    )

/**
 * Makes the checkout of `base` from `mirror`: fetches the mirror first when it
 * doesn't have the commit.
 *
 * @category constructors
 * @since 1.0.0
 */
export const create = (mirror: string, base: string, checkout: Checkout) =>
  Effect.gen(function*() {
    const known = yield* jj(["-R", mirror, "log", "--ignore-working-copy", "--no-graph", "-r", base, "-T", "commit_id"])
    if (known.code !== 0) {
      yield* jj(["-R", mirror, "git", "fetch"], 600_000).pipe(Effect.flatMap(ok("fetch")))
    }
    yield* Effect.sync(() => mkdirSync(dirname(checkout.dir), { recursive: true }))
    yield* jj(["-R", mirror, "workspace", "add", "--name", checkout.name, "-r", base, checkout.dir]).pipe(
      Effect.flatMap(ok("add"))
    )
  })

/**
 * Forgets the checkout in its mirror and deletes it and its checkpoint.
 *
 * @category constructors
 * @since 1.0.0
 */
export const remove = (mirror: string, checkout: Checkout) =>
  jj(["-R", mirror, "workspace", "forget", checkout.name]).pipe(
    Effect.andThen(Effect.sync(() => {
      rmSync(checkout.dir, { recursive: true, force: true })
      rmSync(checkout.checkpoint, { force: true })
    }))
  )

/**
 * Whether the checkout's directory exists.
 *
 * @category predicates
 * @since 1.0.0
 */
export const exists = (checkout: Checkout): boolean => existsSync(checkout.dir)

/** One line of `jj diff --summary`: its kind and the paths it names. */
const parseSummary = (line: string): { readonly added: Array<string>; readonly deleted: Array<string> } => {
  const kind = line[0]
  const rest = line.slice(2)
  if (kind === "D") return { added: [], deleted: [rest] }
  if (kind === "R" || kind === "C") {
    // `prefix{old => new}suffix`, or `old => new` when nothing is shared.
    const braced = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(rest)
    const [from, to] = braced === null
      ? rest.split(" => ") as [string, string]
      : [`${braced[1]}${braced[2]}${braced[4]}`, `${braced[1]}${braced[3]}${braced[4]}`]
    return { added: [to.replace(/\/\//g, "/")], deleted: kind === "R" ? [from.replace(/\/\//g, "/")] : [] }
  }
  return { added: [rest], deleted: [] }
}

/**
 * The checkout's change against `base`: each added or modified file's
 * contents in base64, and each deleted path; `undefined` when the change
 * exceeds `limits`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const changes = (
  checkout: Checkout,
  base: string,
  limits: AgentRunner.Limits
): Effect.Effect<AgentRunner.Changes | undefined, WorkspaceError> =>
  Effect.gen(function*() {
    // Run inside the checkout: the summary's paths are relative to the working directory.
    const summary = yield* jj(
      ["-R", checkout.dir, "diff", "--summary", "--from", base, "--to", "@"],
      120_000,
      checkout.dir
    ).pipe(
      Effect.flatMap(ok("diff"))
    )
    const added = new Set<string>()
    const deleted = new Set<string>()
    for (const line of summary.split("\n")) {
      if (line.trim() === "") continue
      const parsed = parseSummary(line)
      for (const path of parsed.added) added.add(path)
      for (const path of parsed.deleted) deleted.add(path)
    }
    for (const path of added) deleted.delete(path)
    if (added.size + deleted.size > limits.files) return undefined
    const root = resolve(checkout.dir)
    let bytes = 0
    const additions: Array<{ path: string; contents: string }> = []
    for (const path of [...added].sort()) {
      const file = resolve(root, path)
      if (!file.startsWith(`${root}${sep}`) || relative(root, file) !== path) {
        return yield* new WorkspaceError({ step: "read" })
      }
      const read = yield* Effect.try({
        try: () => (statSync(file).isFile() ? readFileSync(file) : undefined),
        catch: () => new WorkspaceError({ step: "read" })
      })
      if (read === undefined) continue
      bytes += read.byteLength
      if (bytes > limits.bytes) return undefined
      additions.push({ path, contents: read.toString("base64") })
    }
    return { additions, deletions: [...deleted].sort() }
  })
