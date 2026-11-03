#!/usr/bin/env node
// The lane helper: open or reuse an issue, link work to it, comment on it, and file it under a parent issue, on a
// public repository of smithers.sh (docs/features/work-links.md, docs/features/issues.md). No dependencies.
//
//   node ops/issues/track.mjs open    --repo <o/n> --title <t> --body-file <f> [--key <kind:id>] [--label <l>]...
//                                     [--parent <o/n>#<N>] [--dry-run]
//   node ops/issues/track.mjs link    --repo <o/n> --issue <N> --kind lane|session|queue|pr|merge|review|assignee
//                                     --ref <ref> [--state <s>] [--url https://...] [--text <label>] [--dry-run]
//   node ops/issues/track.mjs comment --repo <o/n> --issue <N> --body-file <f> [--dry-run]
//   node ops/issues/track.mjs parent  --repo <o/n> --issue <N> --parent <o/n>#<M> [--replace] [--dry-run]
//
// Filing a whole import plan, paced and resumable, is ops/issues/file.mjs, which uses these parts.
//
// Who: the identity file at --identity or $SMITHERS_ISSUE_IDENTITY, JSON:
//   { "login": "<GitHub login>", "personId": "...", "cookie": "<smithers.sh session cookie header>",
//     "runnerToken": "<runner token>", "githubToken": "<GitHub token with triage on the repository>" }
// Before any write it asks who each credential belongs to: smithers.sh's `GET /api/auth/session` for the cookie (its
// person and login) and GitHub's `GET /user` for the token (its login). It refuses when either differs from the file's
// login or person, or when any of them is a person's login (`PEOPLE`, Will's): the author is an agent identity.
// Secrets are read from the file only, never from argv, and never printed.
//
// Everything sent goes through the public-content scrub (scrub.mjs) first; a field that cannot be made clean stops
// the command with the field and rule named, exit 2. `--dry-run` prints every request it would make, with
// credentials shown as `[identity <field>]`, and sends nothing.
//
// `open` searches before it creates: an open issue whose body carries the `key: <kind:id>` marker line, or whose
// normalized title matches, is reused and its number printed. Then it applies the labels on GitHub, creating any the
// repository lacks when the token may, and says which it could not; the body's marker block keeps them too.
//
// Pacing: every mutation bound for GitHub (an issue or comment through smithers.sh, a label, a sub-issue) waits for
// the GitHub pacer, one every 7.5 s by default (480 an hour, 8 a minute), under GitHub's secondary limits of 500 content
// creations an hour and 80 a minute (docs.github.com, "Rate limits for the REST API", checked 2026-11-02). smithers.sh's
// own writes (work links) have their own pacer. A 429, a 503, or a 403 that says it is a rate limit waits for
// `retry-after`, else `x-ratelimit-reset`, else a minute doubling to 30, and tries again, at most 8 times.
//
// Sub-issues are GitHub's own (`POST /repos/{o}/{n}/issues/{parent}/sub_issues` with the child's issue id). GitHub's
// limits, checked 2026-11-02 (docs.github.com, "Adding sub-issues" and REST "Sub-issues"): 100 sub-issues per parent,
// eight levels of nesting, and the child must belong to the same repository owner as the parent (another repository
// of the same owner is fine). It looks first: a child already under that parent is a no-op, and a child under another
// parent is refused unless `--replace`.
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { parseArgs } from "node:util"
import { cleanRecord } from "./scrub.mjs"
import { refuseUncheckedTls } from "../tls.mjs"

/** People, never an author: Will's GitHub login. */
export const PEOPLE = ["roninjin10"]
export const MAX_SUB_ISSUES = 100
export const MAX_DEPTH = 8
/** One GitHub-bound mutation every 7.5 s: 480 an hour and 8 a minute, under 500 and 80. */
export const GITHUB_EVERY_MS = 7500
/** smithers.sh's own writes, which create nothing on GitHub. */
export const SMITHERS_EVERY_MS = 500
const GITHUB_API = "https://api.github.com"
const KINDS = ["assignee", "session", "queue", "pr", "merge", "review"]
const STATES = ["working", "queued", "open", "passed", "failed", "merged", "done", "closed"]

/** A refusal the CLI reports with its own exit code: 2 for the scrub, 3 for the identity, 4 for GitHub's limits. */
export class Refused extends Error {
  constructor(code, message, exit) {
    super(message)
    this.code = code
    this.exit = exit
  }
}

/** Title normalization for matching: case, punctuation, quotes and whitespace don't make two issues different. */
export const normalizeTitle = (title) =>
  String(title).toLowerCase().replace(/[`'"“”‘’]/g, "").replace(/[^a-z0-9#.:+-]+/g, " ").replace(/[.:]+(\s|$)/g, "$1").trim()

/** The marker block `open` appends: the stable key and the labels. */
export const markerOf = ({ key, labels = [] }) =>
  [key === undefined ? undefined : `key: ${key}`, labels.length === 0 ? undefined : `labels: ${labels.join(", ")}`].filter(Boolean).join("\n")

/** The body with the marker block, once. */
export const bodyWithMarker = (body, marker) => (marker === "" || body.includes(marker) ? body : `${body.replace(/\s+$/, "")}\n\n${marker}\n`)

/** The UUIDv5 write id of a key on a repository: the same record is always the same write (seed.mjs). */
export const writeIdOf = (name) => {
  const namespace = Buffer.from("6c1b4f1e9a3d4b7e8f2a5c6d7e8f9a0b", "hex")
  const hash = createHash("sha1").update(Buffer.concat([namespace, Buffer.from(name)])).digest()
  hash[6] = (hash[6] & 0x0f) | 0x50
  hash[8] = (hash[8] & 0x3f) | 0x80
  const hex = hash.subarray(0, 16).toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** `owner/name` checked, split. */
export const repoOf = (repo) => {
  if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Refused("invalid", "--repo <owner>/<name> is required", 1)
  const [owner, name] = repo.split("/")
  return { owner, name }
}

/** `<owner>/<name>#<number>`, split. */
export const parentRefOf = (text) => {
  const match = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(String(text ?? ""))
  if (match === null) throw new Refused("invalid", "--parent is <owner>/<name>#<number>", 1)
  return { owner: match[1], name: match[2], number: Number(match[3]) }
}

const isPerson = (login) => typeof login === "string" && PEOPLE.includes(login.trim().toLowerCase())

/**
 * The identity, read from its file, checked for writing. Returns the parsed identity, or throws `Refused` naming why
 * it may not write: no file, no login, or a person's login. Who the credentials belong to is `verifyIdentity`'s.
 */
export const identityOf = (path, read = (p) => readFileSync(p, "utf8"), exists = existsSync) => {
  if (path === undefined || path === "") throw new Refused("identity", "no identity: set --identity or SMITHERS_ISSUE_IDENTITY", 3)
  if (!exists(path)) throw new Refused("identity", "the identity file does not exist", 3)
  let identity
  try {
    identity = JSON.parse(read(path))
  } catch {
    throw new Refused("identity", "the identity file is not JSON", 3)
  }
  const login = typeof identity.login === "string" ? identity.login.trim() : ""
  if (login === "") throw new Refused("identity", "the identity names no login", 3)
  if (isPerson(login)) throw new Refused("identity", `the identity's login is a person's (${login}); issues are written by an agent identity`, 3)
  return { ...identity, login }
}

/**
 * Asks who each credential belongs to and refuses a mismatch: the cookie's session (`/api/auth/session`: signed in,
 * its person and login) and the GitHub token (`GET /user`: its login and id), each against the file's login and
 * person, and neither a person's. `needs` names the credentials the command will use. A dry run asks nothing.
 */
export const verifyIdentity = async (client, identity, needs = ["cookie", "githubToken"]) => {
  if (client.dryRun) return { verified: false }
  const out = { verified: true }
  if (needs.includes("cookie")) {
    const { status, answer } = await client.send({ url: "/api/auth/session" })
    if (status !== 200 || answer?.signedIn !== true) throw new Refused("identity", "the identity's session is not signed in on smithers.sh", 3)
    if (isPerson(answer.login)) throw new Refused("identity", `the session belongs to a person (${answer.login})`, 3)
    if (String(answer.login).toLowerCase() !== identity.login.toLowerCase()) {
      throw new Refused("identity", `the session belongs to ${answer.login}, not ${identity.login}`, 3)
    }
    if (identity.personId !== undefined && answer.personId !== identity.personId) throw new Refused("identity", "the session belongs to another person than the file's personId", 3)
    out.personId = answer.personId
  }
  if (needs.includes("githubToken")) {
    const { status, answer } = await client.send({ url: `${GITHUB_API}/user`, use: "github" })
    if (status !== 200 || typeof answer?.login !== "string") throw new Refused("identity", `GitHub does not accept the identity's token: HTTP ${status}`, 3)
    if (isPerson(answer.login)) throw new Refused("identity", `the GitHub token belongs to a person (${answer.login})`, 3)
    if (answer.login.toLowerCase() !== identity.login.toLowerCase()) throw new Refused("identity", `the GitHub token belongs to ${answer.login}, not ${identity.login}`, 3)
    out.githubId = answer.id
  }
  return out
}

/** Fails closed when any field of `record` can't be made clean; returns the cleaned record. */
export const scrubbed = (record, options) => {
  const result = cleanRecord(record, options)
  if (!result.ok) {
    throw new Refused("scrub", `not posted: ${result.problems.map((p) => `${p.field} (${p.rules.join(", ")})`).join("; ")}`, 2)
  }
  return result.record
}

/** A link from the CLI's flags. `lane` is a `session` link whose ref is `lane:<ref>`. */
export const linkOf = ({ kind, ref, state, url, text, at }) => {
  if (kind === undefined || ref === undefined) throw new Refused("invalid", "--kind and --ref are required", 1)
  const lane = kind === "lane"
  const link = { kind: lane ? "session" : kind, ref: lane && !ref.startsWith("lane:") ? `lane:${ref}` : ref }
  if (!KINDS.includes(link.kind)) throw new Refused("invalid", `--kind is one of lane, ${KINDS.join(", ")}`, 1)
  if (state !== undefined && !STATES.includes(state)) throw new Refused("invalid", `--state is one of ${STATES.join(", ")}`, 1)
  if (url !== undefined && !/^https:\/\//.test(url)) throw new Refused("invalid", "--url must be https", 1)
  const label = text ?? (lane ? `lane ${link.ref.slice(5)}` : undefined)
  if (label !== undefined) link.label = label
  if (state !== undefined) link.state = state
  if (url !== undefined) link.url = url
  link.at = at
  return link
}

/** The headers for a request as `identity`, and the same with each secret named instead of shown. */
const auth = (identity, use) => {
  if (use === "github") {
    return {
      headers: { authorization: `Bearer ${identity?.githubToken ?? ""}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      shown: { authorization: "Bearer [identity githubToken]", accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    }
  }
  if (use === "runner" && identity?.runnerToken !== undefined) {
    return { headers: { authorization: `Bearer ${identity.runnerToken}` }, shown: { authorization: "Bearer [identity runnerToken]" } }
  }
  return {
    headers: { cookie: identity?.cookie ?? "", "x-smithers-device-person": identity?.personId ?? "" },
    shown: { cookie: "[identity cookie]", "x-smithers-device-person": "[identity personId]" },
  }
}

/** Spaces calls at least `everyMs` apart, from the last call's start. */
export const pacerOf = ({ everyMs, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) => {
  let last = -Infinity
  return {
    wait: async () => {
      const wait = last + everyMs - now()
      if (wait > 0) await sleep(wait)
      last = now()
    },
  }
}

/** How long a refused answer asks to wait, or undefined when it is not a rate limit to wait out. */
export const retryWaitOf = (status, headers, backoff, now = Date.now()) => {
  const retryAfter = Number(headers.get("retry-after"))
  const reset = Number(headers.get("x-ratelimit-reset")) * 1000 - now
  const limited = status === 429 || status === 503 || (status === 403 && (headers.has("retry-after") || headers.get("x-ratelimit-remaining") === "0"))
  if (!limited) return undefined
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000
  if (Number.isFinite(reset) && reset > 0) return reset + 1000
  return backoff
}

/**
 * A client for one run: `send` makes a request, or in a dry run records it and answers `dryAnswer`. `requests` is
 * what a dry run prints, with secrets named. Every mutation waits for its destination's pacer, and a rate limit is
 * waited out (`retryWaitOf`).
 */
export const clientOf = ({
  origin,
  identity,
  dryRun,
  fetch = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  githubEveryMs = GITHUB_EVERY_MS,
  smithersEveryMs = SMITHERS_EVERY_MS,
}) => {
  const requests = []
  const pacers = { github: pacerOf({ everyMs: githubEveryMs, now, sleep }), smithers: pacerOf({ everyMs: smithersEveryMs, now, sleep }) }
  const send = async ({ method = "GET", url, use = "session", body, dryAnswer, pace }) => {
    const { headers, shown } = auth(identity, use)
    const full = url.startsWith("http") ? url : `${origin}${url}`
    if (dryRun) {
      requests.push({ method, url: full, headers: shown, ...(body === undefined ? {} : { body }) })
      return { status: 0, answer: dryAnswer, headers: new Headers() }
    }
    refuseUncheckedTls(process.env)
    const pacer = method === "GET" ? undefined : pacers[pace ?? (use === "github" ? "github" : "smithers")]
    let backoff = 60_000
    for (let attempt = 1; ; attempt++) {
      if (pacer !== undefined) await pacer.wait()
      const response = await fetch(full, {
        method,
        headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json", ...(use === "github" ? {} : { origin }) }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const answer = await response.json().catch(() => undefined)
      const wait = retryWaitOf(response.status, response.headers, backoff, now())
      if (wait === undefined || attempt >= 8) return { status: response.status, answer, headers: response.headers }
      await sleep(wait)
      backoff = Math.min(backoff * 2, 30 * 60_000)
    }
  }
  return { send, requests, dryRun }
}

/**
 * A repository's issues shape (Electric), read to its end once and then for changes only: `rows()` answers every
 * row as the shape sends it, fetching only what changed since the last call.
 */
export const shapeReaderOf = (client, { owner, name }) => {
  const rows = new Map()
  let offset = "-1"
  let handle
  return {
    rows: async () => {
      for (let page = 0; page < 500; page++) {
        const query = new URLSearchParams({ repo: `${owner}/${name}`, offset, ...(handle === undefined ? {} : { handle }) })
        const { status, answer, headers } = await client.send({ url: `/api/shapes/items?${query}`, dryAnswer: [{ headers: { control: "up-to-date" } }] })
        if (status === 409) {
          rows.clear()
          offset = "-1"
          handle = undefined
          continue
        }
        if (status !== 0 && status !== 200) throw new Refused("search", `the issue search failed: HTTP ${status}`, 1)
        let upToDate = false
        for (const message of Array.isArray(answer) ? answer : []) {
          if (message?.headers?.control === "up-to-date") upToDate = true
          const op = message?.headers?.operation
          if (op === "delete") rows.delete(message.key)
          else if (op !== undefined) rows.set(message.key, { ...(rows.get(message.key) ?? {}), ...message.value })
        }
        offset = headers.get("electric-offset") ?? offset
        handle = headers.get("electric-handle") ?? handle
        if (upToDate || status === 0) break
      }
      return [...rows.values()]
    },
  }
}

/** Every row of a repository's issues shape, read to its end. */
export const shapeRows = (client, repo) => shapeReaderOf(client, repo).rows()

/** The open issue `open` reuses: the same key marker or write id first, then the same normalized title. */
export const findMatch = (rows, { title, key, writeId }) => {
  const open = rows.filter((row) => row.kind !== "pull" && row.state === "open" && row.deleted_at == null)
  const marker = key === undefined ? undefined : new RegExp(`^key: ${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m")
  const byKey = open.find((row) => (marker !== undefined && marker.test(row.body ?? "")) || (writeId !== undefined && row.write_id === writeId))
  if (byKey !== undefined) return { number: Number(byKey.number), by: "key" }
  const wanted = normalizeTitle(title)
  const byTitle = open.find((row) => normalizeTitle(row.title ?? "") === wanted)
  return byTitle === undefined ? undefined : { number: Number(byTitle.number), by: "title" }
}

/** `{ owner, name, number }` of an issue GitHub answered, from its `url`. */
const refOfIssue = (answer) => {
  const match = /repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(answer?.url ?? "")
  return match === null ? undefined : { owner: match[1], name: match[2], number: Number(match[3]) }
}
const same = (a, b) => a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase() && a.number === b.number
const show = (ref) => `${ref.owner}/${ref.name}#${ref.number}`

/**
 * Files `child` under `parent` as a GitHub sub-issue. It looks first: the child's current parent is answered as is
 * when it is `parent` (`noop`), refused when it is another unless `replace`. Then GitHub's limits: the same owner,
 * 100 children, eight levels.
 */
export const attach = async (client, { child, parent, replace = false, cache }) => {
  if (child.owner.toLowerCase() !== parent.owner.toLowerCase()) {
    throw new Refused("cross_owner", `GitHub refuses a sub-issue from another owner: ${child.owner} under ${parent.owner}`, 4)
  }
  const current = await client.send({ url: `${GITHUB_API}/repos/${child.owner}/${child.name}/issues/${child.number}/parent`, use: "github", dryAnswer: undefined })
  const now = current.status === 200 ? refOfIssue(current.answer) : undefined
  if (now !== undefined && same(now, parent)) return { parent: show(parent), noop: true }
  if (now !== undefined && !replace) throw new Refused("has_parent", `${show(child)} is already under ${show(now)}; pass --replace to move it`, 4)
  const issue = await client.send({ url: `${GITHUB_API}/repos/${child.owner}/${child.name}/issues/${child.number}`, use: "github", dryAnswer: { id: "<id of the child>" } })
  if (issue.status !== 0 && issue.status !== 200) throw new Refused("github", `GitHub has no issue ${show(child)}: HTTP ${issue.status}`, 1)
  const summary = await client.send({ url: `${GITHUB_API}/repos/${parent.owner}/${parent.name}/issues/${parent.number}`, use: "github", dryAnswer: { sub_issues_summary: { total: 0 } } })
  if (summary.status !== 0 && summary.status !== 200) throw new Refused("github", `GitHub has no parent ${show(parent)}: HTTP ${summary.status}`, 1)
  const total = summary.answer?.sub_issues_summary?.total ?? 0
  if (total >= MAX_SUB_ISSUES) throw new Refused("children_limit", `the parent already has ${total} sub-issues, GitHub's limit is ${MAX_SUB_ISSUES}`, 4)
  // Depth: the parent's own ancestors, walked up (a cache of known parents saves the walk); the child goes one below.
  let depth = 1
  let at = parent
  const seen = new Set([show(child)])
  for (; depth <= MAX_DEPTH; depth++) {
    if (seen.has(show(at))) throw new Refused("cycle", `${show(child)} is an ancestor of ${show(parent)}`, 4)
    seen.add(show(at))
    const known = cache?.get(show(at))
    if (known === null) break
    const up = known !== undefined ? { status: 200, answer: { url: `x/repos/${known.owner}/${known.name}/issues/${known.number}` } }
      : await client.send({ url: `${GITHUB_API}/repos/${at.owner}/${at.name}/issues/${at.number}/parent`, use: "github", dryAnswer: undefined })
    const next = up.status === 200 ? refOfIssue(up.answer) : undefined
    cache?.set(show(at), next ?? null)
    if (next === undefined) break
    at = next
  }
  if (depth + 1 > MAX_DEPTH) throw new Refused("depth_limit", `the parent is at level ${depth}; GitHub nests at most ${MAX_DEPTH} levels`, 4)
  const posted = await client.send({
    method: "POST",
    url: `${GITHUB_API}/repos/${parent.owner}/${parent.name}/issues/${parent.number}/sub_issues`,
    use: "github",
    body: { sub_issue_id: issue.answer?.id, ...(now !== undefined ? { replace_parent: true } : {}) },
    dryAnswer: {},
  })
  if (posted.status === 0 || posted.status === 201) {
    cache?.set(show(child), { ...parent })
    return { parent: show(parent), depth: depth + 1, ...(now !== undefined ? { replaced: show(now) } : {}) }
  }
  throw new Refused("github", `GitHub refused the sub-issue: HTTP ${posted.status}${posted.status === 422 ? " (a limit or a cycle)" : ""}`, 1)
}

/**
 * Applies `labels` to issue `number` on GitHub: it lists the repository's labels (once per run with `cache`), creates
 * the missing ones, and adds every label it has. Returns `{ labelsApplied, missingLabels }`: the labels it could not
 * create, which the token's role may not allow.
 */
export const applyLabels = async (client, { owner, name, number, labels, cache }) => {
  if (labels.length === 0) return { labelsApplied: true, missingLabels: [] }
  const repo = `${owner}/${name}`.toLowerCase()
  let known = cache?.get(repo)
  if (known === undefined) {
    known = new Set()
    for (let page = 1; page <= 50; page++) {
      const { status, answer } = await client.send({ url: `${GITHUB_API}/repos/${owner}/${name}/labels?per_page=100&page=${page}`, use: "github", dryAnswer: [] })
      if (status !== 0 && status !== 200) throw new Refused("github", `GitHub did not list the labels: HTTP ${status}`, 1)
      for (const label of Array.isArray(answer) ? answer : []) known.add(String(label.name).toLowerCase())
      if (!Array.isArray(answer) || answer.length < 100) break
    }
    cache?.set(repo, known)
  }
  const missing = []
  for (const label of labels.filter((label) => !known.has(label.toLowerCase()))) {
    const { status } = await client.send({ method: "POST", url: `${GITHUB_API}/repos/${owner}/${name}/labels`, use: "github", body: { name: label, color: "ededed" }, dryAnswer: {} })
    if (status === 0 || status === 201 || status === 422) known.add(label.toLowerCase())
    else missing.push(label)
  }
  const apply = labels.filter((label) => !missing.includes(label))
  if (apply.length > 0) {
    const { status } = await client.send({ method: "POST", url: `${GITHUB_API}/repos/${owner}/${name}/issues/${number}/labels`, use: "github", body: { labels: apply }, dryAnswer: [] })
    if (status !== 0 && status !== 200) throw new Refused("github", `GitHub refused the labels: HTTP ${status}`, 1)
  }
  return { labelsApplied: missing.length === 0, missingLabels: missing }
}

/**
 * Finds or creates the issue and answers its number: `{ number, reused, by, writeId }`. `reader` is a shape reader
 * to reuse across calls. A created issue's number comes from the shape once GitHub numbered it.
 */
export const ensureIssue = async (client, { repo, title, body, key, reader, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) => {
  const { owner, name } = repoOf(repo)
  const shape = reader ?? shapeReaderOf(client, { owner, name })
  const writeId = writeIdOf(`${repo}:${key ?? normalizeTitle(title)}`)
  const match = findMatch(await shape.rows(), { title, key, writeId })
  if (match !== undefined) return { number: match.number, reused: true, by: match.by, writeId }
  const { status, answer } = await client.send({ method: "POST", url: `/api/repos/${owner}/${name}/writes`, body: { writeId, op: "issue/create", title, body }, dryAnswer: { writeId }, pace: "github" })
  if (status !== 0 && status !== 200 && status !== 202) throw new Refused(answer?.code ?? "refused", `the issue was not created: HTTP ${status} ${answer?.code ?? ""}`, 1)
  if (status === 0) return { number: null, reused: false, by: null, writeId }
  for (let tries = 0; tries < 60; tries++) {
    await sleep(2000)
    const found = findMatch(await shape.rows(), { title, key, writeId })
    if (found !== undefined) return { number: found.number, reused: false, by: null, writeId }
  }
  throw new Refused("pending", `created as write ${writeId}; GitHub has not numbered it yet, run again`, 1)
}

/** `open`: find, else create; then its labels on GitHub, then its parent, if asked. */
export const open = async (client, { repo, title, body, key, labels = [], parent, origin }, options = {}) => {
  const { owner, name } = repoOf(repo)
  const record = scrubbed({ title, body: bodyWithMarker(body, markerOf({ key, labels })), labels }, options)
  const found = await ensureIssue(client, { repo, title: record.title, body: record.body, key, sleep: options.sleep })
  const number = found.number ?? "<number>"
  const applied = await applyLabels(client, { owner, name, number, labels: record.labels })
  const placed = parent === undefined ? undefined : await attach(client, { child: { owner, name, number: found.number ?? 0 }, parent: parentRefOf(parent) })
  return { repo, number: found.number, reused: found.reused, by: found.by, writeId: found.writeId, labels: record.labels, ...applied, origin, parent: placed?.parent ?? null }
}

/** Posts links to an issue (1 to 50), as the runner when the identity has its token. */
export const postLinks = async (client, { repo, issue, links }, options = {}) => {
  const { owner, name } = repoOf(repo)
  const body = scrubbed({ links }, options)
  const { status, answer } = await client.send({ method: "POST", url: `/api/repos/${owner}/${name}/issues/${Number(issue)}/links`, use: "runner", body, dryAnswer: { links: links.length, changed: links.length }, pace: "smithers" })
  if (status !== 0 && status !== 200) throw new Refused(answer?.code ?? "refused", `the link was refused: HTTP ${status} ${answer?.code ?? ""}`, 1)
  return answer
}

export const link = (client, { repo, issue, ...flags }, options = {}) => postLinks(client, { repo, issue, links: [linkOf(flags)] }, options)

export const comment = async (client, { repo, issue, body }, options = {}) => {
  const { owner, name } = repoOf(repo)
  const record = scrubbed({ body }, options)
  if (record.body.trim() === "") throw new Refused("invalid", "the comment is empty", 1)
  const writeId = writeIdOf(`${repo}#${issue}:${createHash("sha256").update(record.body).digest("hex")}`)
  const { status, answer } = await client.send({ method: "POST", url: `/api/repos/${owner}/${name}/writes`, body: { writeId, op: "issue/comment", number: Number(issue), body: record.body }, dryAnswer: { writeId }, pace: "github" })
  if (status !== 0 && status !== 200 && status !== 202) throw new Refused(answer?.code ?? "refused", `the comment was refused: HTTP ${status} ${answer?.code ?? ""}`, 1)
  return { writeId }
}

/** Private repository names for the scrub, from a local file of one name per line (never committed). */
export const privateReposOf = (path) =>
  path !== undefined && existsSync(path) ? readFileSync(path, "utf8").split("\n").map((line) => line.trim()).filter(Boolean) : []

const main = async () => {
  refuseUncheckedTls(process.env)
  const [command, ...rest] = process.argv.slice(2)
  const { values } = parseArgs({
    args: rest,
    options: {
      origin: { type: "string", default: "https://smithers.sh" },
      identity: { type: "string" },
      "private-repos": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      repo: { type: "string" },
      issue: { type: "string" },
      title: { type: "string" },
      "body-file": { type: "string" },
      key: { type: "string" },
      label: { type: "string", multiple: true },
      parent: { type: "string" },
      replace: { type: "boolean", default: false },
      kind: { type: "string" },
      ref: { type: "string" },
      state: { type: "string" },
      url: { type: "string" },
      text: { type: "string" },
    },
  })
  const dryRun = values["dry-run"]
  // A dry run needs no identity, and shows whose it would be when one is there; a write needs a valid one.
  let identity
  try {
    identity = identityOf(values.identity ?? process.env.SMITHERS_ISSUE_IDENTITY)
  } catch (error) {
    if (!dryRun) throw error
  }
  const options = { privateRepos: privateReposOf(values["private-repos"] ?? process.env.SMITHERS_PRIVATE_REPOS_FILE) }
  const client = clientOf({ origin: values.origin, identity, dryRun })
  const readBody = () => {
    if (values["body-file"] === undefined) throw new Refused("invalid", "--body-file is required", 1)
    return readFileSync(values["body-file"], "utf8")
  }
  const needs = { open: ["cookie", "githubToken"], comment: ["cookie"], parent: ["githubToken"], link: identity?.runnerToken === undefined ? ["cookie"] : [] }[command]
  if (needs !== undefined) await verifyIdentity(client, identity, needs)
  let result
  if (command === "open") {
    if (values.title === undefined) throw new Refused("invalid", "--title is required", 1)
    result = await open(client, { repo: values.repo, title: values.title, body: readBody(), key: values.key, labels: values.label ?? [], parent: values.parent, origin: values.origin }, options)
  } else if (command === "link") {
    if (values.issue === undefined) throw new Refused("invalid", "--issue is required", 1)
    result = await link(client, { repo: values.repo, issue: values.issue, kind: values.kind, ref: values.ref, state: values.state, url: values.url, text: values.text, at: new Date().toISOString() }, options)
  } else if (command === "comment") {
    if (values.issue === undefined) throw new Refused("invalid", "--issue is required", 1)
    result = await comment(client, { repo: values.repo, issue: values.issue, body: readBody() }, options)
  } else if (command === "parent") {
    const { owner, name } = repoOf(values.repo)
    if (values.issue === undefined) throw new Refused("invalid", "--issue is required", 1)
    result = await attach(client, { child: { owner, name, number: Number(values.issue) }, parent: parentRefOf(values.parent), replace: values.replace })
  } else {
    throw new Refused("invalid", "usage: track.mjs open|link|comment|parent ... (see the header of ops/issues/track.mjs)", 1)
  }
  const out = dryRun ? { dryRun: true, author: identity?.login ?? null, requests: client.requests, result } : result
  process.stdout.write(`${JSON.stringify(out, null, dryRun ? 2 : 0)}\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = error instanceof Refused ? error.exit : 1
  })
}
