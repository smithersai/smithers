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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
 * survive their scope, fresh machines are removed when theirs closes. A
 * workspace boundary for tests only, never an isolation boundary.
 */
export const hostMachines = (root: string = tempDir()) => {
  const opened: Array<string> = []
  const machines: Workspace.Machines = {
    workspace: (key) =>
      Effect.sync(() => {
        const workdir = join(root, slug(key))
        mkdirSync(workdir, { recursive: true })
        opened.push(key)
        return hostSession(key, workdir)
      }),
    fresh: (key) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const workdir = join(root, `fresh-${slug(key)}`)
          mkdirSync(workdir, { recursive: true })
          opened.push(key)
          return hostSession(key, workdir)
        }),
        (session) => Effect.sync(() => rmSync(session.workdir, { recursive: true, force: true }))
      ),
    dispose: (remoteId) => Effect.sync(() => rmSync(remoteId, { recursive: true, force: true }))
  }
  return { root, machines, opened }
}
