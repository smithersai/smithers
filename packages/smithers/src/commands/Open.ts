/**
 * `smthrs open [dir]` and `smthrs .`: open a checkout's repository in the
 * Smithers app (#1964).
 *
 * The checkout's git remote names `owner/repo` (origin first; a jj checkout
 * without a git directory answers `jj git remote list`). The repository page
 * `/<owner>/<repo>` is that repository's workspace chat, whose first message
 * is the repository homepage. The first match wins:
 *
 * 1. macOS with Smithers.app installed: `smithers://open/<owner>/<repo>`
 *    through LaunchServices.
 * 2. Otherwise the web page, `https://smithers.sh/<owner>/<repo>`, printed.
 *
 * `open` never runs a checkout's own scripts.
 *
 * @since 1.0.0
 */

import { spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import * as CliError from "../CliError.vibe"

/**
 * The Smithers Cloud web origin.
 *
 * @category constants
 * @since 1.0.0
 */
export const webOrigin = "https://smithers.sh"

const SEGMENT = /^[\w.-]+$/

const segmentOk = (segment: string): boolean => SEGMENT.test(segment) && segment !== "." && segment !== ".."

/**
 * The `owner/repo` a git remote URL names, or null. Accepts scp-like
 * (`git@host:owner/repo.git`), `ssh://`, `git://` and `http(s)://` spellings
 * with exactly two path segments; the host is not interpreted, since
 * a GitHub remote and its Smithers Cloud mirror share the name.
 *
 * @category parsing
 * @since 1.0.0
 */
export const repoFromRemote = (remote: string, allowedHosts?: ReadonlySet<string>): string | null => {
  const trimmed = remote.trim()
  let path: string
  const scp = /^[\w.-]+@[\w.-]+:(?!\/)(.+)$/.exec(trimmed)
  if (scp !== null) {
    if (
      allowedHosts && !allowedHosts.has(trimmed.slice(trimmed.indexOf("@") + 1, trimmed.indexOf(":")).toLowerCase())
    ) return null
    path = scp[1]!
  } else {
    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      return null
    }
    if (!["https:", "http:", "ssh:", "git:", "git+ssh:"].includes(parsed.protocol)) return null
    if (allowedHosts && !allowedHosts.has(parsed.hostname.toLowerCase())) return null
    if (parsed.search !== "" || parsed.hash !== "") return null
    path = parsed.pathname
  }
  const segments = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "").split("/")
  if (segments.length !== 2) return null
  const [owner, repo] = segments as [string, string]
  return segmentOk(owner) && segmentOk(repo) ? `${owner}/${repo}` : null
}

/**
 * The deep link the installed app answers for a repository.
 *
 * @category constructors
 * @since 1.0.0
 */
export const deepLink = (repo: string): string => `smithers://open/${repo}`

/**
 * The repository's page on smithers.sh.
 *
 * @category constructors
 * @since 1.0.0
 */
export const webUrl = (repo: string): string => `${webOrigin}/${repo}`

/**
 * What `open` did.
 *
 * @category models
 * @since 1.0.0
 */
export interface Opened {
  readonly repo: string
  readonly opened: "app" | "web"
  readonly url: string
}

/**
 * The host doors `open` uses, injectable so tests never launch anything.
 *
 * @category models
 * @since 1.0.0
 */
export interface Host {
  readonly platform: NodeJS.Platform
  readonly home: string
  readonly exists: (path: string) => boolean
  /** Runs a command to completion and answers its stdout, or null when it failed. */
  readonly read: (command: string, args: ReadonlyArray<string>, cwd: string) => string | null
  /** Runs a command with the terminal inherited and answers its exit status. */
  readonly launch: (
    command: string,
    args: ReadonlyArray<string>,
    options: { readonly cwd: string; readonly env?: Readonly<Record<string, string>> }
  ) => Promise<number>
}

/**
 * The process host.
 *
 * @category constructors
 * @since 1.0.0
 */
export const processHost = (environment: Readonly<Record<string, string | undefined>>): Host => ({
  platform: process.platform,
  home: homedir(),
  exists: existsSync,
  read: (command, args, cwd) => {
    const result = spawnSync(command, [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    return result.status === 0 ? result.stdout : null
  },
  launch: (command, args, options) =>
    new Promise((resolvePromise, reject) => {
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        env: { ...environment, ...options.env },
        stdio: "inherit"
      })
      child.once("error", reject)
      child.once("exit", (code) => resolvePromise(code ?? 1))
    })
})

const firstRemote = (host: Host, directory: string): string | null => {
  const origin = host.read("git", ["remote", "get-url", "origin"], directory)?.trim()
  if (origin) return origin
  const listed = host.read("git", ["remote", "-v"], directory) || host.read("jj", ["git", "remote", "list"], directory)
  for (const line of (listed ?? "").split("\n")) {
    const [name, url] = line.trim().split(/\s+/)
    if (name === "origin" && url !== undefined) return url
  }
  const first = (listed ?? "").split("\n").map((line) => line.trim().split(/\s+/)[1]).find((url) => url !== undefined)
  return first ?? null
}

/**
 * The repository a checkout's remote names. `remoteName` limits discovery to
 * that remote; `allowedHosts` independently limits accepted hosts. Origin wins
 * when no remote is requested.
 *
 * @category constructors
 * @since 1.0.0
 */
export const resolveRepo = (
  host: Host,
  directory: string,
  allowedHosts?: ReadonlySet<string>,
  remoteName?: string
): string => {
  if (allowedHosts !== undefined || remoteName !== undefined) {
    const remotes = [
      host.read("jj", ["git", "remote", "list"], directory),
      host.read("git", ["remote", "-v"], directory)
    ]
      .flatMap((output) => (output ?? "").split("\n").map((line) => line.trim().split(/\s+/)))
      .filter(([name]) => remoteName === undefined || name === remoteName)
      .sort(([a], [b]) => Number(b === "origin") - Number(a === "origin"))
    for (const [, remote] of remotes) {
      const repo = remote && repoFromRemote(remote, allowedHosts)
      if (repo) return repo
    }
    throw new CliError.UsageError({ message: "Could not determine repository. Use --repo OWNER/REPO." })
  }
  const remote = firstRemote(host, directory)
  if (remote === null) {
    throw new CliError.UsageError({ message: `${directory} has no git remote naming owner/repo.` })
  }
  const repo = repoFromRemote(remote)
  if (repo === null) throw new CliError.UsageError({ message: "The remote does not name owner/repo." })
  return repo
}

/** The installed bundle, by path: a dev build registered under the same identifier must not answer. */
const installedApp = (host: Host): string | undefined =>
  host.platform === "darwin"
    ? [join("/Applications", "Smithers.app"), join(host.home, "Applications", "Smithers.app")].find(host.exists)
    : undefined

/**
 * Opens the checkout's repository in the installed app, or prints the web page.
 *
 * @category constructors
 * @since 1.0.0
 */
export const open = async (host: Host, directory: string | undefined): Promise<Opened> => {
  const cwd = resolve(directory ?? ".")
  if (!host.exists(cwd)) throw new CliError.UsageError({ message: `${cwd} does not exist.` })
  const repo = resolveRepo(host, cwd)
  const link = deepLink(repo)
  const app = installedApp(host)
  if (app !== undefined) {
    const status = await host.launch("open", ["-a", app, link], { cwd })
    if (status === 0) return { repo, opened: "app", url: link }
  }
  return { repo, opened: "web", url: webUrl(repo) }
}
