#!/usr/bin/env node
// The lane helper: open or reuse an issue, link work to it, comment on it, and file it under a parent issue, on a
// repository of smithers.sh, with a machine token, so the App's bot is the author (docs/features/machine-tokens.md).
// No dependencies.
//
//   node ops/issues/track.mjs open    --repo <o/n> --title <t> --body-file <f> [--key <kind:id>] [--label <name[:color[:description]]>]...
//                                     (a suffix of six hex digits reads as a color: --label area:decade is "area" in #decade)
//                                     [--parent <o/n>#<N>] [--dry-run]
//   node ops/issues/track.mjs link    --repo <o/n> --issue <N> --kind lane|session|queue|pr|merge|review|assignee
//                                     --ref <ref> [--state <s>] [--url https://...] [--text <label>] [--dry-run]
//   node ops/issues/track.mjs comment --repo <o/n> --issue <N> --body-file <f> [--dry-run]
//   node ops/issues/track.mjs update  --repo <o/n> --issue <N> [--title <t>] [--body-file <f>] [--state open|closed] [--dry-run]
//   node ops/issues/track.mjs parent  --repo <o/n> --issue <N> --parent <o/n>#<M> [--dry-run]
//   node ops/issues/track.mjs retry   --repo <o/n> --write <id> [--dry-run]
//
// Filing a whole import plan, resumable, is the repository flow `issues/file-tree`.
//
// Who: the machine token for the repository, from the mode-600 file the mode-600 map $SMITHERS_ISSUE_TOKENS names, JSON
// `{ "<o/n>": { "file": "<token file>", "agent": "<agent>", "lane": "<lane>" } }`; ops/machine-token/issue.ts writes each
// token file and prints its agent and lane. A token is read from its file only, never from argv, and never printed.
// Write ids are scoped to the agent and lane, so a new token for the lane retries the same writes; the server decides
// what the token may do.
//
// Everything sent goes through the public-content scrub (scrub.mjs) first; a field that cannot be made clean stops the
// command with the field and rule named, exit 2. `--dry-run` prints every request it would make, with the token named,
// and sends nothing.
//
// `open` searches before it creates: an issue, open or closed, whose body carries the `key: <kind:id>` line is reused,
// and a same-title issue never is. Without a key, a lane opening an issue on purpose reuses an open issue of the same
// normalized title. The write id comes from the key, so a command run again is the same write. GitHub's pace, its
// limits and its answers are the server's: this command submits a write and watches it settle.
import { createHash, randomUUID } from "node:crypto"
import { closeSync, existsSync, fstatSync, openSync, readFileSync } from "node:fs"
import { parseArgs } from "node:util"
import { cleanRecord } from "./scrub.mjs"
import { refuseUncheckedTls } from "../tls.mjs"
import { contentProblem } from "../../src/features/issues/publicContent.mjs"

export const MAX_SUB_ISSUES = 100
export const MAX_DEPTH = 8
const KINDS = ["assignee", "session", "queue", "pr", "merge", "review"]
const STATES = ["working", "queued", "open", "passed", "failed", "merged", "done", "closed"]

/** A refusal the CLI reports with its own exit code: 2 for the scrub, 3 for the token. */
export class Refused extends Error {
  constructor(code, message, exit) {
    super(message)
    this.name = "Refused"
    this.code = code
    this.exit = exit
  }
}

/** Title normalization for matching: case, punctuation, quotes and whitespace don't make two issues different. */
export const normalizeTitle = (title) =>
  String(title).toLowerCase().replace(/[`'"“”‘’]/g, "").replace(/[^a-z0-9#.:+-]+/g, " ").replace(/[.:]+(\s|$)/g, "$1").trim()

/** Metadata starts at a six-digit hex color (or an empty color); other colons remain part of the name. */
export const labelOf = (value) => {
  const match = /^(.+?):([0-9a-fA-F]{6}|)(?::([\s\S]*))?$/.exec(value)
  return match === null ? value : {
    name: match[1],
    ...(match[2] === "" ? {} : { color: match[2] }),
    ...(match[3] === undefined ? {} : { description: match[3] }),
  }
}

/** The marker block `open` appends: the stable key and the labels. */
export const markerOf = ({ key, labels = [] }) =>
  [key === undefined ? undefined : `key: ${key}`, labels.length === 0 ? undefined : `labels: ${labels.map((label) => typeof label === "string" ? label : label.name).join(", ")}`].filter(Boolean).join("\n")

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
  // A name shaped like a credential is refused before anything quotes it: errors, requests and recorded runs name repos.
  if (contentProblem(repo) !== undefined) throw new Refused("invalid", "the repository is not a repository name", 1)
  const [owner, name] = repo.split("/")
  return { owner, name }
}

/** `<owner>/<name>#<number>`, split. */
export const parentRefOf = (text) => {
  const match = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(String(text ?? ""))
  if (match === null) throw new Refused("invalid", "--parent is <owner>/<name>#<number>", 1)
  return { owner: match[1], name: match[2], number: Number(match[3]) }
}

/** A machine token as `ops/machine-token/issue.ts` makes one: `smm_` and 32 random bytes, base64url. */
const TOKEN = /^smm_[A-Za-z0-9_-]{43}$/

/**
 * A file only its owner can read, as text. Anything else is refused with a fixed message: an error from the file
 * system names the path, and a token pasted where a path belongs would be that path.
 */
export const readPrivate = (path, what) => {
  let fd
  try {
    fd = openSync(path, "r")
  } catch {
    throw new Refused("token", `${what} can't be read`, 3)
  }
  try {
    if ((fstatSync(fd).mode & 0o077) !== 0) throw new Refused("token", `${what} is readable by others: chmod 600 it`, 3)
    return readFileSync(fd, "utf8")
  } catch (error) {
    if (error instanceof Refused) throw error
    throw new Refused("token", `${what} can't be read`, 3)
  } finally {
    closeSync(fd)
  }
}

const NAME = /^[\w.:-]{1,100}$/

/**
 * `repo`'s entry in the mode-600 map $SMITHERS_ISSUE_TOKENS: `{ "file", "agent", "lane" }`, the token's file and the
 * agent and lane it was issued to, as `ops/machine-token/issue.ts` prints them.
 */
export const entryFor = (repo, read = readPrivate, path = process.env.SMITHERS_ISSUE_TOKENS) => {
  if (path === undefined || path === "") throw new Refused("token", "no machine tokens: set SMITHERS_ISSUE_TOKENS", 3)
  let entries
  try {
    entries = JSON.parse(read(path, "the SMITHERS_ISSUE_TOKENS file"))
  } catch (error) {
    if (error instanceof Refused) throw error
    throw new Refused("token", "the SMITHERS_ISSUE_TOKENS file is not readable JSON", 3)
  }
  const entry = entries[repo]
  if (entry === undefined) throw new Refused("token", `no machine token for ${repo}`, 3)
  if (typeof entry !== "object" || entry === null || typeof entry.file !== "string") {
    throw new Refused("token", `the map's entry for ${repo} is not { "file", "agent", "lane" }`, 3)
  }
  if (entry.file.startsWith("smm_")) throw new Refused("token", `the map names a token, not a file, for ${repo}`, 3)
  if (typeof entry.agent !== "string" || typeof entry.lane !== "string" || !NAME.test(entry.agent) || !NAME.test(entry.lane)) throw new Refused("token", `the map's entry for ${repo} names no agent and lane`, 3)
  return { file: entry.file, agent: entry.agent, lane: entry.lane }
}

/** The agent and lane `repo`'s token was issued to: what a write id is scoped to, so it survives a new token. */
export const laneFor = (repo, read = readPrivate, path = process.env.SMITHERS_ISSUE_TOKENS) => {
  const { agent, lane } = entryFor(repo, read, path)
  return `${agent}/${lane}`
}

/** The machine token for `repo`, from the mode-600 file its entry names. */
export const tokenFor = (repo, read = readPrivate, path = process.env.SMITHERS_ISSUE_TOKENS) => {
  const { file } = entryFor(repo, read, path)
  const token = read(file, `the token file for ${repo}`).trim()
  // The whole token, or nothing: a token with a stray line in it would reach a header, whose error quotes it.
  if (!TOKEN.test(token)) throw new Refused("token", `the token file for ${repo} holds no machine token`, 3)
  return token
}

/**
 * The write id of `name` for `op` on `repo`, scoped to the agent and lane that send it: two lanes never send one id
 * (the server would refuse the second), a new token for the same lane sends the same one, and no op's name can read
 * as another's.
 */
export const scopedWriteId = (identity, op, repo, name) => writeIdOf(JSON.stringify([identity, op, repo, name]))

/** Who sends for `repo`: its agent and lane, or `dry-run`. */
export const identityOf = (dryRun, lane, repo) => (dryRun ? "dry-run" : lane(repo))

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

/**
 * A client for one run: `send` makes a request with the repository's machine token, or in a dry run records it and
 * answers `dryAnswer`. `requests` is what a dry run prints, with the token named.
 */
export const clientOf = ({ origin, dryRun, fetch = globalThis.fetch, token = tokenFor, lane = laneFor }) => {
  const requests = []
  const send = async ({ method = "GET", repo, path, body, dryAnswer, signedOut = false }) => {
    const { owner, name } = repoOf(repo)
    const url = path.startsWith("/api/") ? `${origin}${path}` : `${origin}/api/repos/${owner}/${name}${path}`
    if (dryRun) {
      requests.push({ method, url, headers: signedOut ? {} : { authorization: `Bearer [machine token for ${repo}]` }, ...(body === undefined ? {} : { body }) })
      return { status: 0, answer: dryAnswer, headers: new Headers() }
    }
    refuseUncheckedTls(process.env)
    const headers = { ...(signedOut ? {} : { authorization: `Bearer ${token(repo)}` }), ...(body === undefined ? {} : { "content-type": "application/json" }) }
    let response
    try {
      response = await fetch(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    } catch {
      // A fetch error can quote the request's headers, the token among them: a fixed message instead.
      throw new Refused("unavailable", `the request to ${origin} failed`, 4)
    }
    return { status: response.status, answer: await response.json().catch(() => undefined), headers: response.headers }
  }
  return { send, requests, dryRun, identity: (repo) => identityOf(dryRun, lane, repo) }
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
        const { status, answer, headers } = await client.send({ repo: `${owner}/${name}`, path: `/api/shapes/items?${query}`, signedOut: true, dryAnswer: [{ headers: { control: "up-to-date" } }] })
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

/**
 * The issue `open` reuses. With a `key` (or `writeId`), only exact identity counts: an issue, open or closed, whose
 * body carries the `key: <key>` line or whose write id is ours. A same-title issue is never a receipt. Without a key,
 * a lane opening an issue on purpose reuses an open issue of the same normalized title.
 */
export const findMatch = (rows, { title, key, writeId }) => {
  const issues = rows.filter((row) => row.kind !== "pull" && row.deleted_at == null)
  if (key !== undefined || writeId !== undefined) {
    const marker = key === undefined ? undefined : new RegExp(`^key: ${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m")
    // The server files a machine's body escaped (publicContent.mjs), so its marker reads `key\: …` until unescaped.
    // Its word joiners and the entities that keep a line's indentation go too.
    const unescaped = (body) => (body ?? "").replace(/\u2060/g, "").replace(/&#32;/g, " ").replace(/&#9;/g, "\t").replace(/\\([!-/:-@[-`{-~])/g, "$1")
    const byKey = issues.find((row) => (marker !== undefined && marker.test(unescaped(row.body))) || (writeId !== undefined && row.write_id === writeId))
    return byKey === undefined ? undefined : { number: Number(byKey.number), by: "key" }
  }
  const wanted = normalizeTitle(title)
  const byTitle = issues.find((row) => row.state === "open" && normalizeTitle(row.title ?? "") === wanted)
  return byTitle === undefined ? undefined : { number: Number(byTitle.number), by: "title" }
}

/** Submits a machine write and watches it settle: its number, or `Refused` with why. */
const write = async (client, repo, writeId, body, sleep) => {
  const { status, answer } = await client.send({ method: "POST", repo, path: "/writes", body: { writeId, ...body }, dryAnswer: { writeId } })
  if (status === 0) return { writeId, number: null, status: "dry-run" }
  if (status !== 200 && status !== 202) throw new Refused(answer?.code ?? "refused", `the write was refused: HTTP ${status} ${answer?.code ?? ""}`, status === 401 ? 3 : 1)
  return watch(client, repo, writeId, sleep)
}

/** Watches a write settle. The server holds each write to its sends, so a backlog is minutes; a command run again watches the same write. */
const watch = async (client, repo, writeId, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) => {
  for (let tries = 0; tries < 360; tries++) {
    const looked = await client.send({ repo, path: `/writes/${writeId}` })
    if (looked.status === 200 && looked.answer.status === "done") return { writeId, number: looked.answer.number, status: "done" }
    if (looked.status === 200 && looked.answer.status !== "pending") throw new Refused(looked.answer.failure ?? "refused", `the write ${looked.answer.status}: ${looked.answer.failure ?? "no reason given"}${looked.answer.status === "failed" ? `; track.mjs retry --write ${writeId} runs it again` : ""}`, 1)
    await sleep(5000)
  }
  throw new Refused("pending", `write ${writeId} is still pending; run the same command again to watch it`, 1)
}

/** `open`: find, else create; then its parent, if asked. */
export const open = async (client, { repo, title, body, key, labels = [], parent, sleep }, options = {}) => {
  const { owner, name } = repoOf(repo)
  const record = scrubbed({ title, body: bodyWithMarker(body, markerOf({ key, labels })), labels }, options)
  const shape = shapeReaderOf(client, { owner, name })
  const match = findMatch(await shape.rows(), key === undefined ? { title: record.title } : { title: record.title, key })
  const written = match !== undefined
    ? { number: match.number, writeId: null }
    : await write(client, repo, scopedWriteId(client.identity(repo), "issue/create", repo, key ?? normalizeTitle(title)), { op: "issue/create", title: record.title, body: record.body, ...(record.labels.length === 0 ? {} : { labels: record.labels }) }, sleep)
  const placed = parent === undefined || written.number === null ? null : await relate(client, { repo, issue: written.number, parent, sleep })
  return { repo, number: written.number, reused: match !== undefined, by: match?.by ?? null, writeId: written.writeId, labels: record.labels, parent: placed === null ? null : parent }
}

/** `parent`: files `issue` under `parent`. Another parent is refused by the server, never replaced. */
export const relate = async (client, { repo, issue, parent, sleep }) => {
  const target = parentRefOf(parent)
  const key = `${repo}#${issue}->${target.owner}/${target.name}#${target.number}`
  const body = { op: "issue/relate", number: Number(issue), parent: { repo: `${target.owner}/${target.name}`, number: target.number } }
  return write(client, repo, scopedWriteId(client.identity(repo), "issue/relate", repo, key), body, sleep)
}

/** Posts links to an issue (1 to 50). */
export const postLinks = async (client, { repo, issue, links }, options = {}) => {
  const body = scrubbed({ links }, options)
  const { status, answer } = await client.send({ method: "POST", repo, path: `/issues/${Number(issue)}/links`, body, dryAnswer: { links: links.length, changed: links.length } })
  if (status !== 0 && status !== 200) throw new Refused(answer?.code ?? "refused", `the link was refused: HTTP ${status} ${answer?.code ?? ""}`, status === 401 ? 3 : 1)
  return answer
}

export const link = (client, { repo, issue, ...flags }, options = {}) => postLinks(client, { repo, issue, links: [linkOf(flags)] }, options)

export const comment = async (client, { repo, issue, body, sleep }, options = {}) => {
  const record = scrubbed({ body }, options)
  if (record.body.trim() === "") throw new Refused("invalid", "the comment is empty", 1)
  const writeId = scopedWriteId(client.identity(repo), "issue/comment", repo, `${issue}:${createHash("sha256").update(record.body).digest("hex")}`)
  return write(client, repo, writeId, { op: "issue/comment", number: Number(issue), body: record.body }, sleep)
}

/** `update`: what the App filed, its title, body or state. The server refuses a person's issue. */
export const update = async (client, { repo, issue, title, body, state, sleep }, options = {}) => {
  if (title === undefined && body === undefined && state === undefined) throw new Refused("invalid", "--title, --body-file or --state is required", 1)
  if (state !== undefined && state !== "open" && state !== "closed") throw new Refused("invalid", "--state is open or closed", 1)
  const record = scrubbed({ ...(title === undefined ? {} : { title }), ...(body === undefined ? {} : { body }) }, options)
  const fields = { number: Number(issue), ...record, ...(state === undefined ? {} : { state }) }
  // Each update is its own act, so close, reopen, close closes it again. Run twice, it asks for the same end state.
  const writeId = randomUUID()
  return write(client, repo, writeId, { op: "issue/update", ...fields }, sleep)
}

/** `retry`: a write that settled `failed`, run again. Its marker keeps it one issue. */
export const retryWrite = async (client, { repo, writeId, sleep }) => {
  const { status, answer } = await client.send({ method: "POST", repo, path: `/writes/${writeId}/retry`, body: {}, dryAnswer: {} })
  if (status === 0) return { writeId, status: "dry-run" }
  if (status !== 202) throw new Refused(answer?.code ?? "refused", `the retry was refused: HTTP ${status} ${answer?.code ?? ""}`, status === 401 ? 3 : 1)
  return watch(client, repo, writeId, sleep)
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
      "private-repos": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      repo: { type: "string" },
      issue: { type: "string" },
      title: { type: "string" },
      "body-file": { type: "string" },
      key: { type: "string" },
      label: { type: "string", multiple: true },
      parent: { type: "string" },
      kind: { type: "string" },
      ref: { type: "string" },
      state: { type: "string" },
      url: { type: "string" },
      text: { type: "string" },
      write: { type: "string" },
    },
  })
  const dryRun = values["dry-run"]
  const options = { privateRepos: privateReposOf(values["private-repos"] ?? process.env.SMITHERS_PRIVATE_REPOS_FILE) }
  const client = clientOf({ origin: values.origin, dryRun })
  const readBody = () => {
    if (values["body-file"] === undefined) throw new Refused("invalid", "--body-file is required", 1)
    return readFileSync(values["body-file"], "utf8")
  }
  const needIssue = () => {
    if (values.issue === undefined) throw new Refused("invalid", "--issue is required", 1)
  }
  let result
  if (command === "open") {
    if (values.title === undefined) throw new Refused("invalid", "--title is required", 1)
    result = await open(client, { repo: values.repo, title: values.title, body: readBody(), key: values.key, labels: (values.label ?? []).map(labelOf), parent: values.parent }, options)
  } else if (command === "link") {
    needIssue()
    result = await link(client, { repo: values.repo, issue: values.issue, kind: values.kind, ref: values.ref, state: values.state, url: values.url, text: values.text, at: new Date().toISOString() }, options)
  } else if (command === "comment") {
    needIssue()
    result = await comment(client, { repo: values.repo, issue: values.issue, body: readBody() }, options)
  } else if (command === "update") {
    needIssue()
    result = await update(client, { repo: values.repo, issue: values.issue, title: values.title, body: values["body-file"] === undefined ? undefined : readBody(), state: values.state }, options)
  } else if (command === "retry") {
    if (values.write === undefined) throw new Refused("invalid", "--write is required", 1)
    result = await retryWrite(client, { repo: values.repo, writeId: values.write })
  } else if (command === "parent") {
    needIssue()
    result = await relate(client, { repo: values.repo, issue: values.issue, parent: values.parent })
  } else {
    throw new Refused("invalid", "usage: track.mjs open|link|comment|update|parent|retry ... (see the header of ops/issues/track.mjs)", 1)
  }
  const out = dryRun ? { dryRun: true, requests: client.requests, result } : result
  process.stdout.write(`${JSON.stringify(out, null, dryRun ? 2 : 0)}\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = error instanceof Refused ? error.exit : 1
  })
}
