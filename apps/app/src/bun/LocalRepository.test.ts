/*
 * E12.4 — the local repository picker's inspection, against real git in real
 * directories. This is the only path by which the desktop app learns what a
 * repository is, and the shipped alpha had no coverage of it at all.
 *
 * No mocks: every case builds a real working copy in a temp directory and
 * reads what `inspectLocalRepository` reports back. The result union is what
 * the connect surface renders, so each error code and message is asserted
 * verbatim — a renamed code renders as an unhandled state, and a reworded
 * message is a string the UI never shows.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import type { InspectLocalRepositoryResult } from "@smthrs/rpc/NativeRepository"
import { inspectLocalRepository } from "./LocalRepository"

const directories: Array<string> = []

/*
 * inspectLocalRepository spawns git with the ambient environment, so a
 * developer's own ~/.gitconfig reaches it. url.<base>.insteadOf rewriting in
 * particular turns an scp-style remote into an https one before
 * `git remote get-url` ever answers, which would make the remote assertions
 * report the machine rather than the product. Neutralise it for this file
 * only, and put it back afterwards.
 */
let previousGlobalConfig: string | undefined
let previousSystemConfig: string | undefined

beforeAll(() => {
  previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL
  previousSystemConfig = process.env.GIT_CONFIG_SYSTEM
  process.env.GIT_CONFIG_GLOBAL = "/dev/null"
  process.env.GIT_CONFIG_SYSTEM = "/dev/null"
})

/*
 * The identity is passed per command with -c: GIT_CONFIG_GLOBAL=/dev/null
 * isolates the test from the developer's own git config, which also removes
 * the user identity a commit needs.
 */
const git = async (cwd: string, args: ReadonlyArray<string>): Promise<void> => {
  const child = Bun.spawn(["git", "-C", cwd, ...args], {
    env: {
      ...(Bun.env as Record<string, string | undefined>),
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null"
    },
    stdout: "pipe",
    stderr: "pipe"
  })
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`)
}

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "smithers-repo-"))
  directories.push(directory)
  return directory
}

const repository = async (): Promise<string> => {
  const directory = await temporaryDirectory()
  await git(directory, ["init", "-b", "main"])
  await git(directory, [
    "-c",
    "user.email=e2e@smithers.test",
    "-c",
    "user.name=E2E",
    "commit",
    "--allow-empty",
    "-m",
    "root"
  ])
  return directory
}

const connected = (result: InspectLocalRepositoryResult) => {
  if (result.status !== "connected") throw new Error(`expected connected, got ${JSON.stringify(result)}`)
  return result.repository
}

afterAll(async () => {
  if (previousGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL
  else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig
  if (previousSystemConfig === undefined) delete process.env.GIT_CONFIG_SYSTEM
  else process.env.GIT_CONFIG_SYSTEM = previousSystemConfig
  for (const directory of directories) await rm(directory, { recursive: true, force: true })
})

describe("inspectLocalRepository", () => {
  /*
   * The connect card states branch, head and name. macOS resolves
   * /var/folders through a symlink, which is why the product realpaths and
   * why the expectation does too.
   */
  test("a git repository resolves its root, name, head and branch", async () => {
    const directory = await repository()
    const inspection = connected(await inspectLocalRepository(directory, "read"))
    const root = await realpath(directory)
    expect(inspection.root).toBe(root)
    expect(inspection.name).toBe(basename(root))
    expect(inspection.branch).toBe("main")
    expect(inspection.head).toMatch(/^[0-9a-f]{40}$/)
    expect(inspection.remoteUrl).toBeNull()
  })

  /*
   * A user picks the folder they are looking at, which is rarely the root.
   * Reporting the subdirectory would bind the worldview to half a repository.
   */
  test("a subdirectory inside a repository resolves to the repository root", async () => {
    const directory = await repository()
    const nested = join(directory, "packages", "app")
    await mkdir(nested, { recursive: true })
    const inspection = connected(await inspectLocalRepository(nested, "read-write"))
    expect(inspection.root).toBe(await realpath(directory))
  })

  test("a folder outside any repository answers not-a-repository", async () => {
    const directory = await temporaryDirectory()
    expect(await inspectLocalRepository(directory, "read")).toEqual({
      status: "error",
      code: "not-a-repository",
      message: "That folder is not inside a Git repository."
    })
  })

  test("a file is not a repository folder", async () => {
    const directory = await temporaryDirectory()
    const file = join(directory, "README.md")
    await Bun.write(file, "x")
    expect(await inspectLocalRepository(file, "read")).toEqual({
      status: "error",
      code: "not-a-directory",
      message: "Choose a repository folder, not a file."
    })
  })

  /*
   * The two permission messages differ because the remedy differs: read-write
   * has a fallback the user can choose, read-only does not.
   */
  test("a missing path reports the permission error for the requested access", async () => {
    const directory = await temporaryDirectory()
    const missing = join(directory, "nope")
    expect(await inspectLocalRepository(missing, "read")).toEqual({
      status: "error",
      code: "permission-denied",
      message: "Smithers cannot read this repository. Update its filesystem permissions and try again."
    })
    expect(await inspectLocalRepository(missing, "read-write")).toEqual({
      status: "error",
      code: "permission-denied",
      message:
        "Smithers cannot read and write this repository. Choose read-only access or update its filesystem permissions."
    })
  })

  /*
   * The remote URL is rendered in the connect card and rides into the
   * worldview. A token embedded in the remote must never survive that trip.
   */
  test("an https remote is reported without its credentials, query or fragment", async () => {
    const directory = await repository()
    await git(directory, [
      "remote",
      "add",
      "origin",
      "https://ghp_secrettoken@github.com/smithers/app.git?utm=1#frag"
    ])
    const inspection = connected(await inspectLocalRepository(directory, "read"))
    expect(inspection.remoteUrl).toBe("https://github.com/smithers/app.git")
    expect(inspection.remoteUrl).not.toContain("ghp_secrettoken")
  })

  test("an scp-style remote keeps its host and path but loses the user", async () => {
    const directory = await repository()
    await git(directory, ["remote", "add", "origin", "git@github.com:smithers/app.git"])
    const inspection = connected(await inspectLocalRepository(directory, "read"))
    expect(inspection.remoteUrl).toBe("github.com:smithers/app.git")
  })

  /*
   * `git branch --show-current` prints nothing when HEAD is detached. The
   * product reports null rather than "", so the card can state the absence
   * instead of rendering an empty branch name.
   */
  test("a detached head reports a null branch and a real head", async () => {
    const directory = await repository()
    await git(directory, ["checkout", "--detach", "HEAD"])
    const inspection = connected(await inspectLocalRepository(directory, "read"))
    expect(inspection.branch).toBeNull()
    expect(inspection.head).toMatch(/^[0-9a-f]{40}$/)
  })

  /*
   * A freshly initialised repository has no commit, so `rev-parse HEAD`
   * fails. That is a connectable repository with nothing in it, not an error.
   */
  test("a repository with no commits connects with a null head", async () => {
    const directory = await temporaryDirectory()
    await git(directory, ["init", "-b", "main"])
    const inspection = connected(await inspectLocalRepository(directory, "read"))
    expect(inspection.head).toBeNull()
    expect(inspection.branch).toBe("main")
  })
})
