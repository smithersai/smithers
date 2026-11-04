// Visibility checks for the standalone import planner: anonymous GitHub reads, or the App's read token
// (githubRead.mjs) for the owner its scope receipt covers. No personal login, subprocess, or retry.
import { constants, closeSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import { normalizeRepository, repositoryCandidates, repositoryReferences, validRepository } from "./scrub.mjs"

export const publicCacheFile = () => join(homedir(), ".cache", "smithers", "public-repos.json")
const ttl = 24 * 60 * 60 * 1000
const safeName = (name) => typeof name === "string" && validRepository(name) && repositoryReferences({ repo: name }).includes(normalizeRepository(name))

/** Authority files are regular, owned by the caller, mode 600, and never opened through a symlink. */
const readAuthority = (path) => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || (stat.mode & 0o7777) !== 0o600 || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error("repository authority file must be owned by the caller and mode 600")
    }
    return readFileSync(fd, "utf8")
  } finally { closeSync(fd) }
}

/** One exact owner/name per line. No owner-only, basename, URL or wildcard grants. */
export const publicReposOf = (path) => {
  if (path === undefined) return []
  const names = readAuthority(path).split("\n").map((line) => line.trim()).filter(Boolean)
  if (names.some((name) => !safeName(name))) throw new Error("public repository allowlist requires exact owner/name entries")
  return names.map(normalizeRepository)
}
const readCache = (path, now) => {
  if (path === null) return {}
  let text
  try { text = readAuthority(path) } catch (error) {
    if (error.code === "ENOENT") return {}
    throw error
  }
  let data
  try { data = JSON.parse(text) } catch { return {} }
  if (!data || typeof data !== "object" || Array.isArray(data)) return {}
  return Object.fromEntries(Object.entries(data).filter(([name, entry]) => safeName(name) && normalizeRepository(name) === name &&
    entry?.private === false && Number.isFinite(entry.checkedAt) && entry.checkedAt <= now && now - entry.checkedAt < ttl))
}
const saveCache = (path, cache) => {
  if (path === null) return
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(cache, null, 2) + "\n", { mode: 0o600, flag: "wx" })
    renameSync(temporary, path)
  } finally {
    try { unlinkSync(temporary) } catch (error) { if (error.code !== "ENOENT") throw error }
  }
}

/** The anonymous request budget: GitHub allows 60 unauthenticated reads an hour per address. */
export const ANONYMOUS_BUDGET = 60
/** Reads with the App's token: its installation allows 5,000 an hour; one run takes a tenth at most. */
export const AUTHENTICATED_BUDGET = 500

/** The request function: plain anonymous fetch, or githubRead when `SMITHERS_GITHUB_READ_TOKEN_FILE` is set. */
const reader = async (env, request) => {
  if (!env.SMITHERS_GITHUB_READ_TOKEN_FILE) {
    return {
      covers: () => false,
      get: (url, timeoutMs) => request(url, {
        method: "GET",
        headers: { "User-Agent": "Smithers-issue-import", Accept: "application/vnd.github+json" },
        credentials: "omit", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
      }),
    }
  }
  const { githubRead } = await import("./githubRead.mjs")
  const client = githubRead({ env, fetch: request })
  return { covers: (url) => client.covers(url), get: (url) => client.get(url) }
}

/**
 * Targets first, then primary references in order, then nested ones (a name inside another repository's path or
 * query), each asked only once a repository around it is public: otherwise the scrub redacts it with its parent.
 * Only private:false responses are persisted.
 */
export const confirmRepositories = async (rows, {
  privateRepos = [], publicRepos = [], targets = [], cacheFile = null, timeoutMs = 10_000,
  fetch: request = globalThis.fetch, env = {}, watchedOwners = [],
} = {}) => {
  const forced = new Set(privateRepos.map(normalizeRepository))
  const allowed = new Set(publicRepos.filter(safeName).map(normalizeRepository))
  const cache = readCache(cacheFile, Date.now())
  for (const repo of Object.keys(cache)) {
    if (forced.has(repo) || forced.has(repo.split("/")[1])) delete cache[repo]
  }
  const client = await reader(env, request)
  const verdicts = new Map()
  const stopped = { anonymous: undefined, authenticated: undefined }
  const sent = { anonymous: 0, authenticated: 0 }
  const budget = { anonymous: ANONYMOUS_BUDGET, authenticated: AUTHENTICATED_BUDGET }
  const targetNames = targets.filter(safeName).map(normalizeRepository)
  const candidates = [
    ...targetNames.map((name) => ({ name, tier: "target", parents: [] })),
  ]
  const discovered = repositoryCandidates(rows, { owners: [...targetNames.map((name) => name.split("/")[0]), ...watchedOwners], privateRepos })
  candidates.push(...discovered.candidates)
  for (const { name: repo, tier, parents } of candidates) {
    if (verdicts.has(repo)) continue
    const put = (verdict, reason) => verdicts.set(repo, { repo, verdict, reason })
    if (forced.has(repo) || forced.has(repo.split("/")[1])) {
      delete cache[repo]
      put("private", "explicit private list")
      continue
    }
    if (allowed.has(repo)) { put("public", "explicit public list"); continue }
    if (cache[repo]?.private === false) { put("public", "cached private:false (24h)"); continue }
    if (tier === "nested" && !parents.some((parent) => verdicts.get(parent)?.verdict === "public")) {
      put("unconfirmed", "not requested: no repository around it is public")
      continue
    }
    const url = `https://api.github.com/repos/${repo}`
    const mode = client.covers(url) ? "authenticated" : "anonymous"
    if (stopped[mode] !== undefined) { put("unconfirmed", `not requested after HTTP ${stopped[mode]}`); continue }
    if (sent[mode] >= budget[mode]) { put("unconfirmed", `not requested after ${budget[mode]}-request${mode === "authenticated" ? " App token" : ""} budget`); continue }
    let response
    try {
      sent[mode]++
      response = await client.get(url, timeoutMs)
    } catch { put("unconfirmed", "network error"); continue }
    const how = mode === "authenticated" ? " with the App token" : ""
    if (response.status === 403 || response.status === 429) {
      stopped[mode] = response.status
      put("unconfirmed", `HTTP ${response.status}; rate limit`)
    } else if (response.status === 404) put("private", `HTTP 404${how}`)
    else if (response.status !== 200) put("unconfirmed", `HTTP ${response.status}`)
    else {
      try {
        const body = await response.json()
        if (body?.private === false) {
          put("public", `HTTP 200 private:false${how}`)
          cache[repo] = { private: false, checkedAt: Date.now() }
        } else if (body?.private === true) put("private", "HTTP 200 private:true")
        else put("unconfirmed", "HTTP 200 without private:false")
      } catch { put("unconfirmed", "invalid response") }
    }
    if (response.status !== 200) await response.body?.cancel().catch(() => {})
  }
  saveCache(cacheFile, cache)
  return {
    byRepository: verdicts,
    targets: targetNames,
    watched: discovered.watched,
    requests: sent.anonymous + sent.authenticated,
    anonymousRequests: sent.anonymous,
    authenticatedRequests: sent.authenticated,
  }
}
