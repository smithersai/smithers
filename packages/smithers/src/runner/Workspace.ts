/**
 * A job's checkout: one jj workspace of the repository's local mirror per
 * step, at the job's base commit, shared by every generation of the step, and
 * the change read back from it.
 *
 * jj runs with no user configuration, so a host's own settings never change
 * what a checkout holds or what its diff says: its configuration directory is
 * one this process made, empty and private to the runner's user.
 *
 * A fetch or clone with a credential (decision 0148) never runs in the mirror,
 * whose git and jj configuration an agent can write from its checkout. One
 * git command, the git this process resolved on its own `PATH`, fetches the
 * credential's exact HTTPS remote, given on its command line, into a bare
 * repository under the runner's state directory that only the runner writes
 * to: no link in it or on the way to it is followed, its configuration is
 * rewritten before each fetch, its hooks, alternates and
 * any pointer to another repository removed, git's global and system files
 * unread, and every `GIT_*` variable of the runner's environment dropped. The
 * mirror then fetches from that repository with no credential. An agent
 * running as the runner's user can still read what that user can (decision
 * 0136): see decision 0148.
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
import { Cause, Effect, Option, Schema, Semaphore } from "effect"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  type Stats,
  statSync,
  writeFileSync
} from "node:fs"
import { devNull, tmpdir } from "node:os"
import { delimiter, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path"

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
  return {
    name,
    dir,
    stateDir,
    checkpoint: `${dir}.acp.json`,
    provisioning: `${dir}.provisioning`,
    started: join(stateDir, "started", name)
  }
}

/**
 * The checkout of one step: its workspace name, its directory, its session
 * checkpoint beside it, the mark that says it is still being made
 * (`provisioning`: whatever is in the directory is incomplete, and no agent
 * has run in it), and the record that an agent was about to run in it
 * (`started`, under the state directory but outside `work/`).
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
 * Whether a variable of the runner's environment stays out of a credentialed
 * git command's: every `GIT_*` (tracing, `GIT_CURL_VERBOSE`, configuration
 * from the environment, `GIT_EXEC_PATH`, `GIT_SSH*`, `GIT_ASKPASS`,
 * `GIT_SSL_NO_VERIFY`, `GIT_DIR`), `SSH_ASKPASS`, and jj's own (`JJ_*`,
 * `RUST_LOG`).
 */
const isUnsafe = (name: string): boolean => /^(GIT_|JJ_)/.test(name) || ["SSH_ASKPASS", "RUST_LOG"].includes(name)

/**
 * The environment a command runs in: the runner's (`base`), then `extraEnv`.
 * A jj command (`credentialed` false) also gets jj's own empty configuration
 * directory. A credentialed git command gets none of what `isUnsafe` names,
 * reads neither git's global nor its system file, and gets the credential
 * from `extraEnv` alone.
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
  if (!credentialed) return { ...env, ...extraEnv, JJ_CONFIG: jjConfig() }
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, ...extraEnv }
}

/** The absolute path of the first executable `name` in an absolute directory of the runner's own `PATH`. */
const onPath = (name: string): string | undefined => {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(dir)) continue
    const candidate = join(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // Not here.
    }
  }
  return undefined
}

/**
 * The absolute path of the `git` on the runner's own `PATH`, resolved when
 * first asked; `undefined` when there is none.
 */
let gitPath: string | null | undefined
const resolveGit = (): string | undefined => {
  if (gitPath === undefined) gitPath = onPath("git") ?? null
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
  group = false
): Effect.Effect<Ran> =>
  Effect.suspend(() => {
    const git = resolveGit()
    return run(
      resolveJjBinary().path,
      [
        ...args,
        "--no-pager",
        "--color=never",
        "--config",
        "user.name=smithers-runner",
        "--config",
        "user.email=runner@localhost",
        // Every command runs the git this process resolved, whatever the mirror's jj configuration names: the
        // mirror's configuration is the agent's to write (decision 0148).
        ...(git === undefined ? [] : ["--config", `git.executable-path=${JSON.stringify(git)}`])
      ],
      { ...(cwd === undefined ? {} : { cwd }), env: commandEnv(process.env, {}, false) },
      timeoutMs,
      group
    )
  })

/**
 * A command that makes a checkout (a fetch, a clone's parts, the workspace's
 * add): in a process group of its own, killed whole when the checkout gives
 * way to a Stop, a lost claim or the deadline.
 */
const provisioning = (args: ReadonlyArray<string>, timeoutMs = 120_000) => jj(args, timeoutMs, undefined, true)

/**
 * Runs `file args` for at most `timeoutMs`: its exit code and output.
 * Interrupted or out of time, it is killed, and an interruption completes
 * only once it has exited (at most `KILL_WAIT_MS`), so the mirror's gate is
 * never released to the next command while it still runs. With `group`, it
 * runs in a process group of its own and the whole group is killed, so a
 * helper it started (git's `git-remote-http`, which holds a stalled
 * connection) goes with it; without, it stays in the runner's group.
 */
const run = (
  file: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly env: Record<string, string> },
  timeoutMs: number,
  group = false
): Effect.Effect<Ran> =>
  Effect.callback<Ran>((resume) => {
    const child = spawn(file, [...args], { ...options, detached: group, stdio: ["ignore", "pipe", "pipe"] })
    const out: Array<Buffer> = []
    const err: Array<Buffer> = []
    let size = 0
    const kill = () => {
      try {
        if (child.pid !== undefined) process.kill(group ? -child.pid : child.pid, "SIGKILL")
      } catch {
        // Gone already.
      }
    }
    const collect = (into: Array<Buffer>) => (chunk: Buffer) => {
      size += chunk.byteLength
      if (size <= MAX_OUTPUT_BYTES) into.push(chunk)
      else kill()
    }
    child.stdout.on("data", collect(out))
    child.stderr.on("data", collect(err))
    let exited = () => {}
    const closed = new Promise<void>((done) => (exited = done))
    const timer = setTimeout(kill, timeoutMs)
    let ended = false
    const done = (code: number) => {
      exited()
      if (ended) return
      ended = true
      clearTimeout(timer)
      resume(Effect.succeed({ code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }))
    }
    child.on("error", () => done(1))
    child.on("close", (code) => done(code ?? 1))
    return Effect.promise(async () => {
      clearTimeout(timer)
      kill()
      await Promise.race([closed, new Promise((wait) => setTimeout(wait, KILL_WAIT_MS))])
    })
  })

/** The longest an interrupted command is waited for after it was killed. */
const KILL_WAIT_MS = 10_000

/** The most output a command's stdout and stderr together may write before it is killed. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

const ok = (step: WorkspaceError["step"]) => (ran: Ran) =>
  ran.code === 0
    ? Effect.succeed(ran.stdout)
    : Effect.logWarning("runner.workspace").pipe(
      Effect.annotateLogs({ step, exitCode: ran.code, reason: reasonOf(ran.stderr) }),
      Effect.andThen(Effect.fail(new WorkspaceError({ step })))
    )

/**
 * Runs `git args` (the git this process resolved) in `cwd` with exactly
 * `env`, for at most `timeoutMs`. Interrupted, it kills the command.
 */
const git = (
  path: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env: Record<string, string>,
  timeoutMs = 600_000,
  group = false
): Effect.Effect<Ran> => run(path, args, { cwd, env }, timeoutMs, group)

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
 * What the credentialed `git` reads to authenticate to `credential.remote`'s
 * host: an `Authorization` header through `GIT_CONFIG_*` in the command's own
 * environment, never on its command line, in a file or in a log, and only for
 * URLs under that origin. No terminal prompt.
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
 * The remote a credential may be sent to: HTTPS, or HTTP to this machine's
 * own loopback (a test's server), with no user, password, query or fragment.
 * `undefined` for anything else, which is never fetched with a credential.
 *
 * @category constructors
 * @since 1.0.0
 */
export const trustedRemote = (remote: string): URL | undefined => {
  let url: URL
  try {
    url = new URL(remote)
  } catch {
    return undefined
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]"
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return undefined
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return undefined
  return url
}

/**
 * The bare repository a credentialed fetch for `mirror` writes: under the
 * runner's state directory, `fetch/<16 hex of the mirror's path>.git`, and the
 * runner's alone.
 *
 * @category constructors
 * @since 1.0.0
 */
export const fetchStoreOf = (stateDir: string, mirror: string): string =>
  join(stateDir, "fetch", `${createHash("sha256").update(resolve(mirror)).digest("hex").slice(0, 16)}.git`)

/**
 * The fetch store's configuration, written whole before each credentialed
 * fetch: no hook, no file-system monitor, no automatic gc, TLS verified, and
 * only `scheme` (the remote's own) allowed as a transport.
 */
const storeConfig = (scheme: string) =>
  [
    "[core]",
    "\trepositoryformatversion = 0",
    "\tbare = true",
    `\thooksPath = ${devNull}`,
    "\tfsmonitor = false",
    "[gc]",
    "\tauto = 0",
    "[http]",
    "\tsslVerify = true",
    // A transfer that stalls ends itself, even if the runner that started it is gone.
    "\tlowSpeedLimit = 1",
    "\tlowSpeedTime = 60",
    "[protocol]",
    "\tallow = never",
    `[protocol "${scheme}"]`,
    "\tallow = always",
    ""
  ].join("\n")

/** Each state directory's real path, as this process first resolved it: the root the fetch stores are trusted under. */
const roots = new Map<string, string>()

/**
 * The state directory's real path, every component of which is a real
 * directory and no link: resolved once (the operator's configuration may name
 * it through links), then checked component by component on each use, so a
 * link put in its place since is refused rather than followed.
 */
const trustedRoot = (stateDir: string): string => {
  let real = roots.get(resolve(stateDir))
  if (real === undefined) {
    mkdirSync(stateDir, { recursive: true })
    real = realpathSync(stateDir)
    roots.set(resolve(stateDir), real)
  }
  let path = parse(real).root
  for (const part of real.slice(path.length).split(sep).filter((each) => each !== "")) {
    path = join(path, part)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("the state directory isn't a real directory")
  }
  return real
}

/** Whether `stat` is this process's user's own. */
const owned = (stat: Stats): boolean => process.getuid === undefined || stat.uid === process.getuid()

/**
 * `path` as a real directory of this process's user, mode `0700`: anything
 * else there (a link, a file, another user's) is removed first. Removing a
 * link removes the link, never what it names.
 */
const ownDirectory = (path: string): void => {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (stat !== undefined && (stat.isSymbolicLink() || !stat.isDirectory() || !owned(stat))) {
    rmSync(path, { recursive: true, force: true })
  }
  if (lstatSync(path, { throwIfNoEntry: false }) === undefined) mkdirSync(path, { mode: 0o700 })
  chmodSync(path, 0o700)
}

/**
 * Whether everything under `dir` is a real file or directory of this
 * process's user: no link, no device, socket or pipe, nothing of another
 * user's. Walked without following anything.
 */
const contained = (dir: string): boolean => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !owned(stat)) return false
    if (stat.isDirectory()) {
      if (!contained(path)) return false
    } else if (!stat.isFile()) return false
  }
  return true
}

/**
 * Makes `store` the runner's own bare repository, or puts it back as one.
 * Its root is the trusted state directory (`trustedRoot`), and `fetch/` and
 * the store are real directories of the runner's user. A store holding
 * anything but the runner's own files and directories (a link anywhere in
 * it: its objects, `objects/info` or refs included) is removed whole and made
 * anew. Then its configuration and `HEAD` are written anew (`wx`, so nothing
 * put there in the meantime is written through), and its hooks, alternates
 * and any pointer to another repository removed. Objects and refs stay
 * otherwise: they are data, and they spare a fetch what it already has.
 */
const prepareStore = (stateDir: string, mirror: string, scheme: string): Effect.Effect<string, WorkspaceError> =>
  Effect.try({
    try: () => {
      const root = trustedRoot(stateDir)
      const store = fetchStoreOf(root, mirror)
      ownDirectory(join(root, "fetch"))
      ownDirectory(store)
      if (!contained(store)) {
        rmSync(store, { recursive: true, force: true })
        ownDirectory(store)
      }
      for (
        const path of [
          "config",
          "HEAD",
          "hooks",
          "info",
          "commondir",
          "config.worktree",
          "objects/info/alternates",
          "objects/info/http-alternates"
        ]
      ) rmSync(join(store, path), { recursive: true, force: true })
      for (const path of ["objects", "refs", "refs/heads", "refs/tags"]) ownDirectory(join(store, path))
      writeFileSync(join(store, "config"), storeConfig(scheme), { mode: 0o600, flag: "wx" })
      writeFileSync(join(store, "HEAD"), "ref: refs/heads/main\n", { mode: 0o600, flag: "wx" })
      return store
    },
    catch: () => new WorkspaceError({ step: "fetch" })
  })

/**
 * Fetches every branch and tag of `credential.remote` into the mirror's fetch
 * store with the credential: the one command that carries it. The remote is
 * the credential's own, exactly, on the command line; the store's
 * configuration is the runner's (`prepareStore`); the environment has none of
 * the runner's `GIT_*`, and git's global and system files are unread. Without
 * a resolved `git`, or for a remote `trustedRemote` refuses, nothing runs.
 */
const fetchWithCredential = (
  stateDir: string,
  mirror: string,
  credential: GitCredential
): Effect.Effect<string, WorkspaceError> =>
  Effect.gen(function*() {
    const path = resolveGit()
    const remote = trustedRemote(credential.remote)
    if (path === undefined || remote === undefined) return yield* new WorkspaceError({ step: "fetch" })
    const store = yield* prepareStore(stateDir, mirror, remote.protocol.slice(0, -1))
    yield* git(
      path,
      [
        `--git-dir=${store}`,
        "fetch",
        "--quiet",
        "--no-write-fetch-head",
        "--no-auto-gc",
        "--no-recurse-submodules",
        "--prune",
        remote.href,
        "+refs/heads/*:refs/heads/*",
        "+refs/tags/*:refs/tags/*"
      ],
      store,
      commandEnv(process.env, gitAuthEnv(credential), true),
      600_000,
      true
    ).pipe(Effect.flatMap(ok("fetch")))
    return store
  })

/**
 * Brings what the fetch store holds into `mirror`, with no credential: a
 * missing mirror is made first, with `remote` as its `origin`; then the
 * mirror's git store fetches the store's branches as `origin`'s and its tags,
 * running no hook, and jj imports them.
 */
const fromStore = (mirror: string, store: string, remote: string): Effect.Effect<void, WorkspaceError> =>
  Effect.gen(function*() {
    if (!existsSync(join(mirror, ".jj"))) {
      yield* Effect.sync(() => mkdirSync(dirname(mirror), { recursive: true }))
      yield* provisioning(["git", "init", mirror]).pipe(Effect.flatMap(ok("fetch")))
      yield* provisioning(["-R", mirror, "git", "remote", "add", "origin", remote]).pipe(Effect.flatMap(ok("fetch")))
    }
    const path = resolveGit()
    if (path === undefined) return yield* new WorkspaceError({ step: "fetch" })
    const gitDir = (yield* provisioning(["-R", mirror, "git", "root"]).pipe(Effect.flatMap(ok("fetch")))).trim()
    yield* git(
      path,
      [
        `--git-dir=${gitDir}`,
        "-c",
        `core.hooksPath=${devNull}`,
        "fetch",
        "--quiet",
        "--no-write-fetch-head",
        "--no-auto-gc",
        "--no-recurse-submodules",
        store,
        "+refs/heads/*:refs/remotes/origin/*",
        "+refs/tags/*:refs/tags/*"
      ],
      mirror,
      commandEnv(process.env, {}, true),
      600_000,
      true
    ).pipe(Effect.flatMap(ok("fetch")))
    yield* provisioning(["-R", mirror, "git", "import"]).pipe(Effect.flatMap(ok("fetch")))
  })

/**
 * Makes the checkout of `base` from `mirror`: fetches the mirror first when it
 * doesn't have the commit, and clones it first when it doesn't exist yet. Only
 * then is `credential` asked for, while this checkout alone changes the
 * mirror. With one, the fetch goes through the mirror's fetch store
 * (`fetchStoreOf`), never the mirror's own remote or configuration; without
 * one, an existing mirror fetches its `origin` as before. A missing mirror is
 * cloned only with one.
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
      const store = yield* fetchWithCredential(checkout.stateDir, mirror, cloning.value)
      yield* fromStore(mirror, store, cloning.value.remote)
    }
    const known = yield* provisioning([
      "-R",
      mirror,
      "log",
      "--ignore-working-copy",
      "--no-graph",
      "-r",
      base,
      "-T",
      "commit_id"
    ])
    if (known.code !== 0) {
      const fetching = yield* credential
      if (Option.isNone(fetching)) {
        yield* provisioning(["-R", mirror, "git", "fetch"], 600_000).pipe(Effect.flatMap(ok("fetch")))
      } else {
        const store = yield* fetchWithCredential(checkout.stateDir, mirror, fetching.value)
        yield* fromStore(mirror, store, fetching.value.remote)
      }
    }
    yield* Effect.sync(() => mkdirSync(dirname(checkout.dir), { recursive: true }))
    yield* provisioning(["-R", mirror, "workspace", "add", "--name", checkout.name, "-r", base, checkout.dir]).pipe(
      Effect.flatMap(ok("add"))
    )
  }))

/**
 * The longest one recursive deletion of a checkout may take: a slower one is
 * killed, and the deletion is owed again.
 *
 * @category constants
 * @since 1.0.0
 */
export const DELETE_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Whether `path` is there: `false` only when the file system says it isn't (`ENOENT`, or `ENOTDIR` for a path through
 * a file). Any other answer (`EACCES`, `EIO`, ...) fails: the runner can't tell, so nothing owed is taken as done.
 */
const present = (path: string): Effect.Effect<boolean, WorkspaceError> =>
  Effect.try({
    try: () => {
      try {
        lstatSync(path)
        return true
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === "ENOENT" || code === "ENOTDIR") return false
        throw error
      }
    },
    catch: () => new WorkspaceError({ step: "forget" })
  }).pipe(
    Effect.tapError(() =>
      Effect.logWarning("runner.workspace").pipe(Effect.annotateLogs({ step: "stat", reason: "uncertain" }))
    )
  )

/**
 * Deletes the directory `dir` and everything in it with `rm -rf`, in a
 * process of its own (in a group of its own, killed whole when interrupted or
 * out of time), so a large checkout or a slow filesystem never blocks the
 * runner's event loop: Stop, a lost claim, deadlines and other jobs' heartbeats
 * go on meanwhile. Fails when `rm` failed, ran out of time, or left `dir`.
 */
const deleteTree = (dir: string, timeoutMs = DELETE_TIMEOUT_MS) =>
  Effect.gen(function*() {
    if (!(yield* present(dir))) return
    const ran = yield* run(
      onPath("rm") ?? "/bin/rm",
      ["-rf", "--", dir],
      { env: commandEnv(process.env, {}, false) },
      timeoutMs,
      true
    )
    if (ran.code !== 0 || (yield* present(dir))) {
      yield* Effect.logWarning("runner.workspace").pipe(
        Effect.annotateLogs({ step: "delete", exitCode: ran.code, reason: reasonOf(ran.stderr) })
      )
      return yield* new WorkspaceError({ step: "forget" })
    }
  })

/**
 * Forgets workspace `name` in `mirror` with `command` (`jj` or `provisioning`):
 * done only when the forget succeeded, or the mirror verifiably no longer has
 * the workspace (no mirror at all, as the file system says, or `jj workspace
 * list` doesn't name it). Anything else, a mirror it can't stat included,
 * fails, so the removal stays owed.
 */
const forget = (mirror: string, name: string, command: (args: ReadonlyArray<string>) => Effect.Effect<Ran>) =>
  Effect.gen(function*() {
    if (!(yield* present(join(mirror, ".jj")))) return
    const forgot = yield* command(["-R", mirror, "workspace", "forget", name])
    if (forgot.code === 0) return
    const listed = yield* command(["-R", mirror, "workspace", "list", "-T", "name ++ \"\\n\""])
    if (listed.code === 0 && !listed.stdout.split("\n").includes(name)) return
    yield* Effect.logWarning("runner.workspace").pipe(
      Effect.annotateLogs({ step: "forget", exitCode: forgot.code, reason: reasonOf(forgot.stderr) })
    )
    return yield* new WorkspaceError({ step: "forget" })
  })

/**
 * Forgets the checkout in its mirror and deletes it and its checkpoint. Fails,
 * deleting nothing more, when the mirror still has the workspace or the
 * directory couldn't be deleted (`forget`, `deleteTree`).
 *
 * @category constructors
 * @since 1.0.0
 */
export const remove = (mirror: string, checkout: Checkout) =>
  exclusive(mirror)(forget(mirror, checkout.name, (args) => jj(args))).pipe(
    Effect.andThen(deleteTree(checkout.dir)),
    Effect.andThen(Effect.sync(() => {
      rmSync(checkout.checkpoint, { force: true })
      rmSync(checkout.provisioning, { force: true })
      rmSync(checkout.started, { force: true })
    }))
  )

/** Where the removals still owed for checkouts whose jobs ended are kept, one file each, until done. */
const removalsOf = (stateDir: string) => join(stateDir, "removals")

/**
 * Owes the removal of `checkout` from `mirror` (its job ended): written to disk at once, so the job's slot is freed
 * without waiting for the mirror, and done by `sweep`, after a restart too.
 *
 * @category constructors
 * @since 1.0.0
 */
export const scheduleRemoval = (mirror: string, checkout: Checkout) =>
  Effect.sync(() => {
    mkdirSync(removalsOf(checkout.stateDir), { recursive: true, mode: 0o700 })
    writeFileSync(join(removalsOf(checkout.stateDir), `${checkout.name}.json`), JSON.stringify({ mirror }), {
      mode: 0o600
    })
  })

/**
 * The longest one owed removal may wait for its mirror before the sweep moves on and asks again later.
 *
 * @category constants
 * @since 1.0.0
 */
export const REMOVAL_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Does each removal owed under `stateDir` (`scheduleRemoval`), each for at most `REMOVAL_TIMEOUT_MS`: done, its file
 * goes; else it stays for the next sweep. Never fails.
 *
 * @category constructors
 * @since 1.0.0
 */
export const sweep = (stateDir: string) =>
  Effect.gen(function*() {
    const dir = removalsOf(stateDir)
    const files = yield* Effect.sync(() =>
      existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")) : []
    )
    for (const file of files) {
      const owed = yield* Effect.sync(() => {
        try {
          return JSON.parse(readFileSync(join(dir, file), "utf8")) as { readonly mirror?: unknown }
        } catch {
          return undefined
        }
      })
      const name = file.slice(0, -".json".length)
      const work = join(stateDir, "work", name)
      const checkout: Checkout = {
        name,
        dir: work,
        stateDir,
        checkpoint: `${work}.acp.json`,
        provisioning: `${work}.provisioning`,
        started: join(stateDir, "started", name)
      }
      if (typeof owed?.mirror !== "string") {
        yield* Effect.sync(() => rmSync(join(dir, file), { force: true }))
        continue
      }
      const done = yield* remove(owed.mirror, checkout).pipe(
        Effect.timeout(REMOVAL_TIMEOUT_MS),
        Effect.as(true),
        // A removal that failed or ran out of time is asked again at the next sweep; an interruption is the sweep's own.
        Effect.catchCause((cause) => Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.succeed(false))
      )
      if (done) yield* Effect.sync(() => rmSync(join(dir, file), { force: true }))
    }
  })

/**
 * Forgets an incomplete checkout in its mirror and deletes its directory,
 * keeping its marks: a runner stopped while `jj workspace add` made it.
 *
 * @category constructors
 * @since 1.0.0
 */
export const discard = (mirror: string, checkout: Checkout) =>
  exclusive(mirror)(forget(mirror, checkout.name, (args) => provisioning(args))).pipe(
    Effect.andThen(deleteTree(checkout.dir))
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
