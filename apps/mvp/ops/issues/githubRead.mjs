// Direct GitHub GETs for operator scripts. No personal login, no token on argv or in a summary.
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs"
import { refuseUncheckedTls } from "../tls.mjs"

// The checkout's public SDK exports reach .vibe sources. Register their shipped Node loader before resolving them.
await import("vibelang/register")
const { GitHub } = await import("@smthrs/integrations")

const NAME = /^[A-Za-z0-9_-]+$/
const REPO = /^(?!\.{1,2}$)[A-Za-z0-9_.-]+$/

const readPrivate = (file) => {
  let fd
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error()
    return readFileSync(fd, "utf8")
  } catch {
    throw new Error("GitHub read token files must be readable private regular files")
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** Only installation access tokens; do not accidentally accept a personal credential. Also used by revoke. */
export const readPrivateToken = (file) => {
  const token = readPrivate(file).trim()
  // GitHub's installation tokens are no longer 40 characters: current ones run to hundreds, with dots and dashes.
  if (!/^ghs_[A-Za-z0-9_.-]+$/.test(token) || token.length > 2048) throw new Error("GitHub read token file is invalid")
  return token
}

/** A run-scoped client: `get(pathOrUrl)` returns Response; `summary()` contains counts and expiration only. */
export const githubRead = ({ env = process.env, fetch = globalThis.fetch } = {}) => {
  let credentials
  let tokenExpired = false
  let authenticated = 0
  let anonymous = 0
  const load = () => {
    if (credentials !== undefined) return credentials
    const file = env.SMITHERS_GITHUB_READ_TOKEN_FILE
    if (!file) return undefined
    let scope
    try { scope = JSON.parse(readPrivate(`${file}.json`)) } catch {
      throw new Error("GitHub read token scope receipt is missing, invalid or not private")
    }
    if (!scope || typeof scope.owner !== "string" || !NAME.test(scope.owner) ||
      !(scope.repos === null || (Array.isArray(scope.repos) && scope.repos.every(repo => typeof repo === "string" && REPO.test(repo)))) ||
      typeof scope.expires_at !== "string" || !Number.isFinite(Date.parse(scope.expires_at))) {
      throw new Error("GitHub read token scope receipt is invalid")
    }
    credentials = { token: readPrivateToken(file), owner: scope.owner.toLowerCase(), repos: scope.repos?.map(repo => repo.toLowerCase()) ?? null }
    tokenExpired = Date.parse(scope.expires_at) <= Date.now()
    return credentials
  }
  const target = (pathOrUrl) => {
    let url
    try { url = new URL(pathOrUrl, "https://api.github.com") } catch {
      // URL's TypeError retains the input in a property, including any userinfo. Discard it without a cause.
      throw new Error("GitHub reads require api.github.com HTTPS URLs")
    }
    if (url.origin !== "https://api.github.com" || url.username || url.password || url.hash) throw new Error("GitHub reads require api.github.com HTTPS URLs")
    const credential = load()
    const match = /^\/repos\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)(?:\/|$)/.exec(url.pathname)
    const covered = credential && match && match[1].toLowerCase() === credential.owner &&
      (credential.repos === null || credential.repos.includes(match[2].toLowerCase()))
    return { url, credential, covered }
  }
  /** Whether a read of `pathOrUrl` would send the token now: in scope and not yet found expired. */
  const covers = (pathOrUrl) => Boolean(target(pathOrUrl).covered && !tokenExpired)
  const get = async (pathOrUrl) => {
    refuseUncheckedTls(env)
    const { url, credential, covered } = target(pathOrUrl)
    const send = async (authorized) => {
      const headers = { "user-agent": GitHub.GitHubClient.USER_AGENT, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28",
        ...(authorized ? { authorization: `token ${credential.token}` } : {}) }
      if (authorized) authenticated++; else anonymous++
      try {
        return await fetch(url.href, { method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(20_000) })
      } catch {
        // Some transports quote their request headers in exceptions.
        throw new Error("GitHub read request failed")
      }
    }
    const authorized = Boolean(covered && !tokenExpired)
    const response = await send(authorized)
    if (!authorized || response.status !== 401) return response
    tokenExpired = true
    await response.body?.cancel().catch(() => {})
    return send(false)
  }
  return { get, covers, summary: () => ({ authenticated, anonymous, tokenExpired }) }
}
