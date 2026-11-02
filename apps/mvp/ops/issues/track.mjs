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
// Who: the identity file at --identity or $SMITHERS_ISSUE_IDENTITY, JSON:
//   { "login": "<GitHub login>", "personId": "...", "cookie": "<smithers.sh session cookie header>",
//     "runnerToken": "<runner token>", "githubToken": "<GitHub token, for sub-issues>" }
// It never writes unless that file exists and its login is set and is not a person's (`PEOPLE`, Will's login): the
// author is an agent identity. Secrets are read from the file only, never from argv, and never printed.
//
// Everything sent goes through the public-content scrub (scrub.mjs) first; a field that cannot be made clean stops
// the command with the field and rule named, exit 2. `--dry-run` prints every request it would make, with
// credentials shown as `[identity <field>]`, and sends nothing.
//
// `open` searches before it creates: an open issue whose normalized title matches, or whose body carries the
// `key: <kind:id>` marker line, is reused and its number printed. Labels go in the body's marker block, since the
// writes route takes no labels yet (docs/features/issues.md#routes).
//
// Sub-issues are GitHub's own (`POST /repos/{o}/{n}/issues/{parent}/sub_issues` with the child's issue id). GitHub's
// limits, checked 2026-11-02 (docs.github.com, "Adding sub-issues" and REST "Sub-issues"): 100 sub-issues per parent,
// eight levels of nesting, and the child must belong to the same repository owner as the parent (another repository
// of the same owner is fine). Each is checked before the write and refused with its name.
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { parseArgs } from "node:util"
import { cleanRecord } from "./scrub.mjs"

/** People, never an author: Will's GitHub login. */
export const PEOPLE = ["roninjin10"]
export const MAX_SUB_ISSUES = 100
export const MAX_DEPTH = 8
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

/**
 * The identity, read from its file, checked for writing. Returns the parsed identity, or throws `Refused` naming why
 * it may not write: no file, no login, or a person's login.
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
  if (PEOPLE.includes(login.toLowerCase())) throw new Refused("identity", `the identity's login is a person's (${login}); issues are written by an agent identity`, 3)
  return { ...identity, login }
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

/**
 * A client for one run: `send` makes a request, or in a dry run records it and answers `dryAnswer`. `requests` is
 * what a dry run prints, with secrets named.
 */
export const clientOf = ({ origin, identity, dryRun, fetch = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) => {
  const requests = []
  const send = async ({ method = "GET", url, use = "session", body, dryAnswer }) => {
    const { headers, shown } = auth(identity, use)
    const full = url.startsWith("http") ? url : `${origin}${url}`
    if (dryRun) {
      requests.push({ method, url: full, headers: shown, ...(body === undefined ? {} : { body }) })
      return { status: 0, answer: dryAnswer, headers: new Headers() }
    }
    let wait = 5000
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(full, {
        method,
        headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json", origin }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const answer = await response.json().catch(() => undefined)
      if ((response.status !== 429 && response.status !== 503) || attempt >= 5) return { status: response.status, answer, headers: response.headers }
      const retryAfter = Number(response.headers.get("retry-after"))
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : wait)
      wait *= 2
    }
  }
  return { send, requests }
}

/** Every row of a repository's issues shape (Electric), read to its end. Rows as the shape sends them. */
export const shapeRows = async (client, { owner, name }) => {
  const rows = new Map()
  let offset = "-1"
  let handle
  for (let page = 0; page < 200; page++) {
    const query = new URLSearchParams({ repo: `${owner}/${name}`, offset, ...(handle === undefined ? {} : { handle }) })
    const { status, answer, headers } = await client.send({ url: `/api/shapes/items?${query}`, dryAnswer: [{ headers: { control: "up-to-date" } }] })
    if (status !== 0 && status !== 200) throw new Refused("search", `the issue search failed: HTTP ${status}`, 1)
    let upToDate = false
    for (const message of Array.isArray(answer) ? answer : []) {
      if (message?.headers?.control === "up-to-date") upToDate = true
      const op = message?.headers?.operation
      if (op === "delete") rows.delete(message.key)
      else if (op !== undefined) rows.set(message.key, { ...(rows.get(message.key) ?? {}), ...message.value })
    }
    if (upToDate || status === 0) break
    offset = headers.get("electric-offset") ?? offset
    handle = headers.get("electric-handle") ?? handle
  }
  return [...rows.values()]
}

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

/** GitHub's issue (for its id), its parent chain's depth and the parent's sub-issue count; refuses past a limit. */
export const attach = async (client, { child, parent, replace = false }) => {
  const api = "https://api.github.com"
  if (child.owner.toLowerCase() !== parent.owner.toLowerCase()) {
    throw new Refused("cross_owner", `GitHub refuses a sub-issue from another owner: ${child.owner} under ${parent.owner}`, 4)
  }
  const issue = await client.send({ url: `${api}/repos/${child.owner}/${child.name}/issues/${child.number}`, use: "github", dryAnswer: { id: "<id of the child>" } })
  if (issue.status !== 0 && issue.status !== 200) throw new Refused("github", `GitHub has no issue ${child.owner}/${child.name}#${child.number}: HTTP ${issue.status}`, 1)
  const summary = await client.send({ url: `${api}/repos/${parent.owner}/${parent.name}/issues/${parent.number}`, use: "github", dryAnswer: { sub_issues_summary: { total: 0 } } })
  if (summary.status !== 0 && summary.status !== 200) throw new Refused("github", `GitHub has no parent ${parent.owner}/${parent.name}#${parent.number}: HTTP ${summary.status}`, 1)
  const total = summary.answer?.sub_issues_summary?.total ?? 0
  if (total >= MAX_SUB_ISSUES) throw new Refused("children_limit", `the parent already has ${total} sub-issues, GitHub's limit is ${MAX_SUB_ISSUES}`, 4)
  // Depth: the parent's own ancestors, walked up; the child goes one level below the parent.
  let depth = 1
  let at = parent
  for (; depth <= MAX_DEPTH; depth++) {
    const up = await client.send({ url: `${api}/repos/${at.owner}/${at.name}/issues/${at.number}/parent`, use: "github", dryAnswer: undefined })
    if (up.status !== 200 || up.answer?.number === undefined) break
    const repo = /repos\/([^/]+)\/([^/]+)\/issues/.exec(up.answer.url ?? "") ?? [undefined, at.owner, at.name]
    at = { owner: repo[1], name: repo[2], number: up.answer.number }
  }
  if (depth + 1 > MAX_DEPTH) throw new Refused("depth_limit", `the parent is at level ${depth}; GitHub nests at most ${MAX_DEPTH} levels`, 4)
  const posted = await client.send({
    method: "POST",
    url: `${api}/repos/${parent.owner}/${parent.name}/issues/${parent.number}/sub_issues`,
    use: "github",
    body: { sub_issue_id: issue.answer?.id, ...(replace ? { replace_parent: true } : {}) },
    dryAnswer: {},
  })
  if (posted.status === 0 || posted.status === 201) return { parent: `${parent.owner}/${parent.name}#${parent.number}`, depth: depth + 1 }
  throw new Refused("github", `GitHub refused the sub-issue: HTTP ${posted.status}${posted.status === 422 ? " (a limit, an existing parent without --replace, or a cycle)" : ""}`, 1)
}

/** `open`: find, else create and wait for its number; then the parent, if asked. */
export const open = async (client, { repo, title, body, key, labels = [], parent, origin }, options = {}) => {
  const { owner, name } = repoOf(repo)
  const marker = markerOf({ key, labels })
  const record = scrubbed({ title, body: bodyWithMarker(body, marker), labels }, options)
  const writeId = writeIdOf(`${repo}:${key ?? normalizeTitle(title)}`)
  const rows = await shapeRows(client, { owner, name })
  const match = findMatch(rows, { title: record.title, key, writeId })
  let number = match?.number
  let reused = match !== undefined
  if (number === undefined) {
    const { status, answer } = await client.send({
      method: "POST",
      url: `/api/repos/${owner}/${name}/writes`,
      body: { writeId, op: "issue/create", title: record.title, body: record.body },
      dryAnswer: { writeId },
    })
    if (status !== 0 && status !== 200 && status !== 202) throw new Refused(answer?.code ?? "refused", `the issue was not created: HTTP ${status} ${answer?.code ?? ""}`, 1)
    if (status !== 0) {
      for (let tries = 0; tries < 30 && number === undefined; tries++) {
        await (options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(2000)
        number = findMatch(await shapeRows(client, { owner, name }), { title: record.title, key, writeId })?.number
      }
      if (number === undefined) throw new Refused("pending", `created as write ${writeId}; GitHub has not numbered it yet, run open again`, 1)
    }
    reused = false
  }
  const placed = parent === undefined ? undefined : await attach(client, { child: { owner, name, number: number ?? 0 }, parent: parentRefOf(parent) })
  return { repo, number: number ?? null, reused, by: match?.by ?? null, writeId, labels: record.labels, labelsApplied: false, origin, parent: placed?.parent ?? null }
}

export const link = async (client, { repo, issue, ...flags }, options = {}) => {
  const { owner, name } = repoOf(repo)
  const body = scrubbed({ links: [linkOf(flags)] }, options)
  const { status, answer } = await client.send({ method: "POST", url: `/api/repos/${owner}/${name}/issues/${Number(issue)}/links`, use: "runner", body, dryAnswer: { links: 1, changed: 1 } })
  if (status !== 0 && status !== 200) throw new Refused(answer?.code ?? "refused", `the link was refused: HTTP ${status} ${answer?.code ?? ""}`, 1)
  return answer
}

export const comment = async (client, { repo, issue, body }, options = {}) => {
  const { owner, name } = repoOf(repo)
  const record = scrubbed({ body }, options)
  if (record.body.trim() === "") throw new Refused("invalid", "the comment is empty", 1)
  const writeId = writeIdOf(`${repo}#${issue}:${createHash("sha256").update(record.body).digest("hex")}`)
  const { status, answer } = await client.send({ method: "POST", url: `/api/repos/${owner}/${name}/writes`, body: { writeId, op: "issue/comment", number: Number(issue), body: record.body }, dryAnswer: { writeId } })
  if (status !== 0 && status !== 200 && status !== 202) throw new Refused(answer?.code ?? "refused", `the comment was refused: HTTP ${status} ${answer?.code ?? ""}`, 1)
  return { writeId }
}

/** Private repository names for the scrub, from a local file of one name per line (never committed). */
const privateReposOf = (path) =>
  path !== undefined && existsSync(path) ? readFileSync(path, "utf8").split("\n").map((line) => line.trim()).filter(Boolean) : []

const main = async () => {
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
  const identityPath = values.identity ?? process.env.SMITHERS_ISSUE_IDENTITY
  // A dry run needs no identity, and shows whose it would be when one is there; a write needs a valid one.
  let identity
  try {
    identity = identityOf(identityPath)
  } catch (error) {
    if (!dryRun) throw error
  }
  const options = { privateRepos: privateReposOf(values["private-repos"] ?? process.env.SMITHERS_PRIVATE_REPOS_FILE) }
  const client = clientOf({ origin: values.origin, identity, dryRun })
  const readBody = () => {
    if (values["body-file"] === undefined) throw new Refused("invalid", "--body-file is required", 1)
    return readFileSync(values["body-file"], "utf8")
  }
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
