/**
 * Shared workspace test fixtures: a throwaway git repository, git helpers
 * that read the host repository without changing it, and host-directory
 * machines that serve the `Workspace.Machines` contract with real `sh` and
 * `git` for the suites that do not boot a microVM.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { ProviderError } from "@smthrs/sandbox/RemoteChildProcessSpawner"
import type { Session } from "@smthrs/sandbox/Sandbox"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { execFileSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs"
import { dirname, join } from "node:path"
import type * as Workspace from "../src/Workspace.ts"
import { tempDir } from "./support.ts"

/** Runs git in `repo` and returns trimmed stdout. */
export const git = (repo: string, ...args: Array<string>): string =>
  execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.test",
      GIT_CONFIG_NOSYSTEM: "1"
    }
  }).trim()

/**
 * A git repository with one commit: `lib.txt` saying `hello`, and
 * `check.sh`, which passes only when `lib.txt` says `hello world`.
 */
export const fixtureRepo = (): { readonly repo: string; readonly commit: string } => {
  const repo = tempDir()
  git(repo, "init", "-q", "-b", "main")
  writeFileSync(join(repo, "lib.txt"), "hello\n")
  writeFileSync(join(repo, "README.md"), "# Fixture\n")
  writeFileSync(
    join(repo, "check.sh"),
    "grep -qx 'hello world' lib.txt && echo ok || { echo 'lib.txt is wrong' >&2; exit 1; }\n"
  )
  git(repo, "add", "-A")
  git(repo, "commit", "-q", "-m", "initial")
  return { repo, commit: git(repo, "rev-parse", "HEAD") }
}

/** Everything that proves the host checkout was left alone. */
export const checkoutState = (repo: string) => ({
  head: git(repo, "rev-parse", "HEAD"),
  symbolic: git(repo, "symbolic-ref", "HEAD"),
  status: git(repo, "status", "--porcelain", "--untracked-files=all"),
  index: readFileSync(join(repo, ".git", "index")).toString("base64"),
  lib: readFileSync(join(repo, "lib.txt"), "utf8")
})

const failure = (message: string) => (cause: unknown) => new ProviderError({ code: "unknown", message, cause })

const hostSession = (key: string, workdir: string): Session => ({
  id: key,
  remoteId: workdir,
  workdir,
  spawn: (command, options) =>
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner
      const handle = yield* spawner.spawn(
        ChildProcess.make("sh", ["-c", command], { cwd: options.cwd ?? workdir, extendEnv: true })
      )
      return {
        stdout: Stream.mapError(handle.stdout, failure("stdout")),
        stderr: Stream.mapError(handle.stderr, failure("stderr")),
        exitCode: Effect.mapError(Effect.map(handle.exitCode, Number), failure("exit"))
      }
    }).pipe(Effect.mapError(failure("spawn")), Effect.provide(NodeServices.layer)),
  readFile: (path) =>
    Effect.try({
      try: () => new Uint8Array(readFileSync(path)),
      catch: (cause) => new ProviderError({ code: "not_found", message: `nothing at ${path}`, cause })
    }),
  writeFile: (path, content) =>
    Effect.try({
      try: () => {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, content)
      },
      catch: failure(`could not write ${path}`)
    })
})

const slug = (key: string) => key.replaceAll(/[^A-Za-z0-9._-]/g, "-")

/**
 * Host-directory machines under `root`: workspaces are directories that
 * survive their scope, fresh machines are removed when theirs closes, and a
 * base is a captured directory a new machine starts as a copy of. A
 * workspace boundary for tests only, never an isolation boundary.
 */
export const hostMachines = (
  root: string = tempDir(),
  bases: string = tempDir(),
  options: {
    /** Whether a capture loses the guest's last writes, as a stop that does not finish gracefully can. */
    readonly loseWrites?: ((name: string) => boolean) | undefined
  } = {}
) => {
  const opened: Array<string> = []
  const boots: Array<{ readonly key: string; readonly boot: Workspace.Boot | undefined }> = []
  const captured = new Map<string, number>()
  let sequence = 0
  const open = (key: string, workdir: string, boot: Workspace.Boot | undefined) => {
    if (!existsSync(workdir) && boot?.base !== undefined) cpSync(join(bases, boot.base), workdir, { recursive: true })
    mkdirSync(workdir, { recursive: true })
    opened.push(key)
    boots.push({ key, boot })
    return hostSession(key, workdir)
  }
  const machines: Workspace.Machines = {
    workspace: (key, boot) => Effect.sync(() => open(key, join(root, slug(key)), boot)),
    fresh: (key, boot) =>
      Effect.acquireRelease(
        Effect.sync(() => open(key, join(root, `fresh-${slug(key)}`), boot)),
        (session) => Effect.sync(() => rmSync(session.workdir, { recursive: true, force: true }))
      ),
    dispose: (remoteId) => Effect.sync(() => rmSync(remoteId, { recursive: true, force: true })),
    bases: {
      identity: "host directories",
      exists: (name) => Effect.sync(() => existsSync(join(bases, name))),
      capture: (remoteId, name, family, retain) =>
        Effect.sync(() => {
          if (options.loseWrites?.(name) === true) rmSync(join(remoteId, ".git", "smithers-prepared"))
          renameSync(remoteId, join(bases, name))
          captured.set(name, ++sequence)
          const members = readdirSync(bases)
            .filter((entry) => entry.startsWith(`${family}-`))
            .sort((left, right) => captured.get(right)! - captured.get(left)!)
          for (const stale of members.slice(2)) {
            if (!retain.includes(stale)) rmSync(join(bases, stale), { recursive: true, force: true })
          }
        }),
      remove: (name) => Effect.sync(() => rmSync(join(bases, name), { recursive: true, force: true }))
    }
  }
  return { root, bases, machines, opened, boots }
}
