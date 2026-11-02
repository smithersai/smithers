/**
 * A job's checkout: one jj workspace of the repository's local mirror per
 * step, at the job's base commit, shared by every generation of the step, and
 * the change read back from it.
 *
 * jj runs with no user configuration, so a host's own settings never change
 * what a checkout holds or what its diff says: its configuration directory is
 * one this process made, empty and private to the runner's user.
 *
 * A fetch or clone with a credential (decision 0148) runs git with tracing
 * off whatever the runner's environment or git's global and system files say,
 * and with the git this process resolved on its own `PATH`, whatever jj
 * configuration the mirror holds. An agent running as the runner's user can
 * still read what that user can (decision 0136): see decision 0148.
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
import { Effect, Option, Schema, Semaphore } from "effect"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync
} from "node:fs"
import { devNull, tmpdir } from "node:os"
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

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

/** jj's configuration directory: made once by this process, empty, readable and writable by its user alone. */
let configDir: string | undefined
const jjConfig = (): string => {
  if (configDir === undefined || !existsSync(configDir)) {
    configDir = mkdtempSync(join(tmpdir(), "smithers-runner-jj-"))
    chmodSync(configDir, 0o700)
  }
  return configDir
}

/**
 * Whether an environment variable would let a credentialed git or jj write
 * what it does, read configuration besides the command's own, or run another
 * program in git's place: git's tracing (`GIT_TRACE*`, `GIT_CURL_VERBOSE`),
 * git configuration from the environment (`GIT_CONFIG*`), git's helper
 * programs' directory (`GIT_EXEC_PATH`), and jj's own (`JJ_*`, `RUST_LOG`).
 */
const isUnsafe = (name: string): boolean =>
  /^(GIT_TRACE|GIT_CONFIG|JJ_)/.test(name) ||
  ["GIT_CURL_VERBOSE", "GIT_EXEC_PATH", "GIT_REDACT_COOKIES", "RUST_LOG"].includes(name)

/**
 * The environment a jj command runs in: the runner's (`base`), with jj's own empty
 * configuration directory. With a credential (`credentialed`), without what
 * `isUnsafe` names, with git's tracing set off (an environment setting wins
 * over git's global and system files, and trace2 reads no repository's), and
 * git's global and system files unread; then `extraEnv` on top.
 *
 * @category constructors
 * @since 1.0.0
 */
export const commandEnv = (
  base: Readonly<Record<string, string | undefined>>,
  extraEnv: Readonly<Record<string, string>>,
  credentialed: boolean
): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && !(credentialed && isUnsafe(name))) env[name] = value
  }
  if (credentialed) {
    for (
      const name of [
        "GIT_TRACE",
        "GIT_TRACE2",
        "GIT_TRACE2_EVENT",
        "GIT_TRACE2_PERF",
        "GIT_TRACE_CURL",
        "GIT_TRACE_PACKET",
        "GIT_TRACE_PACKFILE",
        "GIT_TRACE_PERFORMANCE",
        "GIT_TRACE_SETUP",
        "GIT_TRACE_SHALLOW",
        "GIT_CURL_VERBOSE"
      ]
    ) env[name] = "0"
    env.GIT_CONFIG_NOSYSTEM = "1"
    env.GIT_CONFIG_GLOBAL = devNull
  }
  return { ...env, ...extraEnv, JJ_CONFIG: jjConfig() }
}

/**
 * The absolute path of the `git` on the runner's own `PATH`, resolved when
 * first asked; `undefined` when there is none.
 */
let gitPath: string | null | undefined
const resolveGit = (): string | undefined => {
  if (gitPath === undefined) {
    gitPath = null
    for (const dir of (process.env.PATH ?? "").split(delimiter)) {
      if (!isAbsolute(dir)) continue
      const candidate = join(dir, "git")
      try {
        accessSync(candidate, constants.X_OK)
        if (statSync(candidate).isFile()) {
          gitPath = candidate
          break
        }
      } catch {
        // Not here.
      }
    }
  }
  return gitPath ?? undefined
}

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
  extraEnv: Readonly<Record<string, string>> = {},
  credentialed = false
): Effect.Effect<Ran> =>
  Effect.callback<Ran>((resume, signal) => {
    const git = resolveGit()
    execFile(
      resolveJjBinary().path,
      [
        ...args,
        "--no-pager",
        "--color=never",
        "--config",
        "user.name=smithers-runner",
        "--config",
        "user.email=runner@localhost",
        // Every command runs the git this process resolved, whatever the mirror's jj configuration names: jj runs git
        // for more than a fetch, and the mirror's configuration is the agent's to write (decision 0148).
        ...(git === undefined ? [] : ["--config", `git.executable-path=${JSON.stringify(git)}`])
      ],
      {
        signal,
        timeout: timeoutMs,
        ...(cwd === undefined ? {} : { cwd }),
        maxBuffer: 64 * 1024 * 1024,
        env: commandEnv(process.env, extraEnv, credentialed)
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
 * HTTPS URLs under that host. The same entries, which git ranks above any
 * repository's configuration, run no hook (a `reference-transaction` hook
 * would see this environment), verify TLS, and drop any pinned address for a
 * host.
 *
 * @category constructors
 * @since 1.0.0
 */
export const gitAuthEnv = (credential: GitCredential): Record<string, string> => {
  const origin = new URL(credential.remote).origin
  const basic = Buffer.from(`${credential.username}:${credential.password}`).toString("base64")
  const entries: ReadonlyArray<readonly [string, string]> = [
    [`http.${origin}/.extraheader`, `AUTHORIZATION: basic ${basic}`],
    ["core.hooksPath", devNull],
    ["http.sslVerify", "true"],
    ["http.curloptResolve", ""]
  ]
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(entries.length), GIT_TERMINAL_PROMPT: "0" }
  entries.forEach(([key, value], n) => {
    env[`GIT_CONFIG_KEY_${n}`] = key
    env[`GIT_CONFIG_VALUE_${n}`] = value
  })
  return env
}

/**
 * Runs `jj args` (a fetch or clone) with `credential` when there is one: git
 * gets it from `gitAuthEnv`, and runs as the absolute `git` this process
 * resolved (as every jj command does here), overriding any
 * `git.executable-path` in the mirror's or anyone's jj configuration. Without
 * a resolved `git`, a credentialed command fails.
 */
const fetching = (args: ReadonlyArray<string>, credential: Option.Option<GitCredential>) => {
  if (Option.isNone(credential)) return jj(args, 600_000).pipe(Effect.flatMap(ok("fetch")))
  if (resolveGit() === undefined) return Effect.fail(new WorkspaceError({ step: "fetch" }))
  return jj(
    args,
    600_000,
    undefined,
    gitAuthEnv(credential.value),
    true
  )
    .pipe(Effect.flatMap(ok("fetch")))
}

/**
 * Makes the checkout of `base` from `mirror`: fetches the mirror first when it
 * doesn't have the commit, and clones it first when it doesn't exist yet. Only
 * then is `credential` asked for, while this checkout alone changes the
 * mirror: a private repository's fetch and clone authenticate with what it
 * gives, a public one's go without. A missing mirror is cloned only with one.
 *
 * @category constructors
 * @since 1.0.0
 */
export const create = <E = never>(
  mirror: string,
  base: string,
  checkout: Checkout,
  credential: Effect.Effect<Option.Option<GitCredential>, E> = Effect.succeed(Option.none())
): Effect.Effect<void, WorkspaceError | E> =>
  exclusive(mirror)(Effect.gen(function*() {
    if (!existsSync(join(mirror, ".jj"))) {
      const cloning = yield* credential
      if (Option.isNone(cloning)) return yield* new WorkspaceError({ step: "fetch" })
      yield* Effect.sync(() => mkdirSync(dirname(mirror), { recursive: true }))
      yield* fetching(["git", "clone", cloning.value.remote, mirror], cloning)
    }
    const known = yield* jj(["-R", mirror, "log", "--ignore-working-copy", "--no-graph", "-r", base, "-T", "commit_id"])
    if (known.code !== 0) yield* fetching(["-R", mirror, "git", "fetch"], yield* credential)
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
