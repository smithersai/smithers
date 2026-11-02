/**
 * A job's checkout: one jj workspace of the repository's local mirror per
 * step, at the job's base commit, shared by every generation of the step, and
 * the change read back from it.
 *
 * jj runs with no user configuration, so a host's own settings never change
 * what a checkout holds or what its diff says.
 *
 * Every checkout of a repository shares its mirror's operation log, refs and
 * git worktrees, which jj and git keep in files: ten `jj workspace add`s at
 * once on one mirror fail some of themselves (a packed-ref transaction, or
 * git's config lock). So each command that changes a mirror (fetch, add, the
 * diff that snapshots a checkout, forget) runs one at a time per mirror, and a
 * runner's concurrent jobs queue for it.
 *
 * @since 1.0.0
 */

import type * as AgentRunner from "@smthrs/agent/AgentRunner"
import { resolveJjBinary } from "@smthrs/jj/node/resolveJjBinary"
import { Effect, Schema, Semaphore } from "effect"
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

/** One command's exit code, output, and the first line of its errors. */
interface Ran {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** One gate per mirror, by its resolved path: the commands that change it run one at a time. */
const gates = new Map<string, Semaphore.Semaphore>()

/** `effect`, run while it alone changes `mirror` in this process. */
const exclusive = (mirror: string) => <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const key = resolve(mirror)
    let gate = gates.get(key)
    if (gate === undefined) {
      gate = Semaphore.makeUnsafe(1)
      gates.set(key, gate)
    }
    return gate.withPermits(1)(effect)
  })

/** The first line of a command's errors, with every absolute path replaced: what a log may say of it. */
const reasonOf = (stderr: string): string =>
  (stderr.split("\n").find((line) => line.trim() !== "") ?? "").replace(/\/[^\s'"`:,)]+/g, "<path>").slice(0, 200)

/**
 * Runs `jj args` with no user configuration, for at most `timeoutMs`, in `cwd`
 * when set: its exit code and stdout. Interrupted, it kills the command.
 *
 * @category constructors
 * @since 1.0.0
 */
export const jj = (
  args: ReadonlyArray<string>,
  timeoutMs = 120_000,
  cwd?: string,
  extraEnv: Readonly<Record<string, string>> = {}
): Effect.Effect<Ran> =>
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
        env: { ...process.env, ...extraEnv, JJ_CONFIG: config }
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1
        resume(Effect.succeed({ code, stdout: String(stdout), stderr: String(stderr) }))
      }
    )
  })

const ok = (step: WorkspaceError["step"]) => (ran: Ran) =>
  ran.code === 0
    ? Effect.succeed(ran.stdout)
    : Effect.logWarning("runner.workspace").pipe(
      Effect.annotateLogs({ step, exitCode: ran.code, reason: reasonOf(ran.stderr) }),
      Effect.andThen(Effect.fail(new WorkspaceError({ step })))
    )

/**
 * A read credential for git over HTTPS to one repository (decision 0148), as
 * the host issued it for a job.
 *
 * @category models
 * @since 1.0.0
 */
export interface GitCredential {
  readonly remote: string
  readonly username: string
  readonly password: string
}

/**
 * What `git`, under jj, reads to authenticate to `credential.remote`'s host:
 * an `Authorization` header through `GIT_CONFIG_*` in the command's own
 * environment, never on its command line, in a file or in a log, and only for
 * HTTPS URLs under that host.
 *
 * @category constructors
 * @since 1.0.0
 */
export const gitAuthEnv = (credential: GitCredential): Record<string, string> => {
  const origin = new URL(credential.remote).origin
  const basic = Buffer.from(`${credential.username}:${credential.password}`).toString("base64")
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    GIT_TERMINAL_PROMPT: "0"
  }
}

/**
 * Makes the checkout of `base` from `mirror`: fetches the mirror first when it
 * doesn't have the commit, and clones it first when it doesn't exist yet. With
 * a `credential`, a private repository's fetch and clone authenticate with it.
 *
 * @category constructors
 * @since 1.0.0
 */
export const create = (mirror: string, base: string, checkout: Checkout, credential?: GitCredential) =>
  exclusive(mirror)(Effect.gen(function*() {
    const auth = credential === undefined ? {} : gitAuthEnv(credential)
    if (!existsSync(join(mirror, ".jj")) && credential !== undefined) {
      yield* Effect.sync(() => mkdirSync(dirname(mirror), { recursive: true }))
      yield* jj(["git", "clone", credential.remote, mirror], 600_000, undefined, auth).pipe(Effect.flatMap(ok("fetch")))
    }
    const known = yield* jj(["-R", mirror, "log", "--ignore-working-copy", "--no-graph", "-r", base, "-T", "commit_id"])
    if (known.code !== 0) {
      yield* jj(["-R", mirror, "git", "fetch"], 600_000, undefined, auth).pipe(Effect.flatMap(ok("fetch")))
    }
    yield* Effect.sync(() => mkdirSync(dirname(checkout.dir), { recursive: true }))
    yield* jj(["-R", mirror, "workspace", "add", "--name", checkout.name, "-r", base, checkout.dir]).pipe(
      Effect.flatMap(ok("add"))
    )
  }))

/**
 * Forgets the checkout in its mirror and deletes it and its checkpoint.
 *
 * @category constructors
 * @since 1.0.0
 */
export const remove = (mirror: string, checkout: Checkout) =>
  exclusive(mirror)(jj(["-R", mirror, "workspace", "forget", checkout.name])).pipe(
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
 * exceeds `limits`. The diff snapshots the checkout into `mirror`'s
 * repository, so it waits its turn on the mirror.
 *
 * @category constructors
 * @since 1.0.0
 */
export const changes = (
  checkout: Checkout,
  base: string,
  limits: AgentRunner.Limits,
  mirror: string
): Effect.Effect<AgentRunner.Changes | undefined, WorkspaceError> =>
  Effect.gen(function*() {
    // Run inside the checkout: the summary's paths are relative to the working directory.
    const summary = yield* exclusive(mirror)(jj(
      ["-R", checkout.dir, "diff", "--summary", "--from", base, "--to", "@"],
      120_000,
      checkout.dir
    )).pipe(
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
