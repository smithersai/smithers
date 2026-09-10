/*
 * The repo files seam: GET /api/repos/{owner}/{repo}/contents[/path] lists a
 * directory ("file-list" card) or reads a file ("file" card, capped). A
 * repository open in the LOCAL app is read through its own route instead
 * (localTarget, POST /api/repo/files) and renders the same two cards. The
 * agent shares these commands, so reads must stay bounded. Reference: multi
 * src/files/filesClient.ts — buildContentsPath (:61, per-segment encoding via
 * encodeRepoPath :53), the directory answer is a JSON array of {name, path,
 * type: "file"|"dir"} entries (fetchDir :202, parseEntry :84), and the file
 * answer is one {path, content, encoding, size} record whose content is
 * base64 when encoding === "base64" (fetchFile :215, parseFile :122,
 * decodeContent :117). Parsing is defensive: unknown JSON in, typed card
 * payload out, malformed rows drop; failures are honest strings, never throws.
 */
import { REPO_FILES_PATH, RepoFilesResponseSchema } from "@smthrs/rpc/LocalApp"
import type { Repo, RepoFilesResponse } from "@smthrs/rpc/LocalApp"
import type { Card } from "../AppState"
import { repoIdFromRemote, repoKeyOf } from "../AppState"
import type { AppStore } from "../AppStore"
import { resolveOpenRepo, resolveTargetRepo } from "../RepoContext"
import { readErrorMessage } from "./SeamContext"
import type { SeamContext } from "./SeamContext"

/*
 * Both commands answer a `value` beside the card: the card is what the human
 * sees, the value is what the MODEL reads. 2026-09-01: asked "what does the
 * README say?", the model called files.read, got back only "executed
 * /files.read", and wrote a README that does not exist — the card it had
 * just rendered never reaches its context. A read the model cannot read is
 * a confabulation waiting to happen.
 */
export interface FilesSeam {
  readonly listFiles: (path: string, repo?: string) => Promise<string | void | { readonly value: string }>
  readonly readFile: (path: string, repo?: string, anchor?: FileAnchor) => Promise<string | void | { readonly value: string }>
}

/**
 * The line anchor `files.read <path>:<line>[:<col>]` carries (docs/code-intel/
 * PLAN.md §1), 1-based. It is recorded on the card, which scrolls to and marks
 * the line; the read itself is the same read, so the card keeps its id.
 */
export interface FileAnchor {
  readonly line: number
  readonly column?: number
}

/** The payload fields an anchor writes; nothing when there is none, so an unanchored re-read clears a stale line. */
const anchored = (anchor: FileAnchor | undefined): { readonly line?: number; readonly column?: number } =>
  anchor === undefined ? {} : { line: anchor.line, ...(anchor.column === undefined ? {} : { column: anchor.column }) }

/** The model's copy of a listing stops here (a node_modules has thousands of entries); the card keeps them all. */
export const LISTING_VALUE_CAP = 400

/** The model's copy of a directory listing: one entry per line, directories marked, bounded. */
export const listingValue = (repo: string, path: string, entries: ReadonlyArray<{ name: string; kind: "file" | "dir" }>): string => {
  if (entries.length === 0) return `${path || "/"} in ${repo} is empty.`
  const shown = entries.slice(0, LISTING_VALUE_CAP).map((entry) => (entry.kind === "dir" ? `${entry.name}/` : entry.name))
  const rest = entries.length - shown.length
  return `${path || "/"} in ${repo}:\n${shown.join("\n")}${rest > 0 ? `\n… and ${rest} more (the card lists them all)` : ""}`
}

/** The model's copy of a file: the same bounded text the card shows, with truncation and binary stated. */
export const fileValue = (
  repo: string,
  path: string,
  payload: { readonly content: string; readonly truncated: boolean; readonly binary?: boolean }
): string =>
  payload.binary === true
    ? `${path} in ${repo} is a binary file; its bytes are not shown.`
    : `${path} in ${repo}${payload.truncated ? " (truncated at the card cap; the rest stays in the repository)" : ""}:\n${payload.content}`

type FileListPayload = Extract<Card, { kind: "file-list" }>["payload"]
type FileListEntry = FileListPayload["entries"][number]

/** The card cap (characters): a transcript card states a file, it is not an editor. */
export const CARD_CONTENT_CAP = 16 * 1024

export const localFileCardId = (repoId: string, path: string): string => `file-${repoId}-${path}`

/**
 * The content fields of a local file card from the route's answer: the card
 * cap applied, binary stated, the digest of the bytes kept so a later answer
 * about the file (the code-intel seam's) can tell whether it is about this
 * text. The code-intel seam re-reads a card through this, in place.
 */
export const localFileFields = (
  body: Extract<RepoFilesResponse, { kind: "file" }>
): { readonly content: string; readonly truncated: boolean; readonly binary?: true; readonly digest?: string } => {
  const { content, binary } = body
  const truncated = !binary && (body.truncated || content.length > CARD_CONTENT_CAP)
  return {
    content: binary ? "" : content.slice(0, CARD_CONTENT_CAP),
    truncated,
    ...(binary ? { binary: true as const } : {}),
    ...(body.digest === undefined ? {} : { digest: body.digest })
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/** "" and "/" (and any slash dressing) normalize to the root: the empty path. */
const normalizePath = (path: string): string => path.trim().replace(/^\/+/, "").replace(/\/+$/, "")

/*
 * The global address space (lane piper step 6, ADR 0001): every file has a
 * global path `/org/repo/path`. A command's first token in that shape names
 * the repo AND the path in one — but only when the two-segment prefix is a
 * repository this app knows (the inventory, a working copy, or an open local
 * repo), so a local root-relative absolute path (`/src/lib`) keeps its old
 * meaning instead of becoming a cloud read of a repo that is not one.
 */
const GLOBAL_PATH = /^\/([\w.-]+\/[\w.-]+)(?:\/(.*))?$/

const knownRepo = (store: AppStore, id: string): boolean =>
  store.collections.repositories.get(id) !== undefined ||
  [...store.collections.workingCopies.values()].some((copy) => copy.repoId === id) ||
  [...store.collections.repos.values()].some((repo) => repo.name === id)

const splitGlobalPath = (
  store: AppStore,
  path: string,
  explicitRepo: string | undefined
): { readonly repo: string; readonly path: string } | null => {
  if (explicitRepo !== undefined && explicitRepo !== "") return null
  const match = GLOBAL_PATH.exec(path.trim())
  if (match === null) return null
  const repo = match[1] ?? ""
  return knownRepo(store, repo) ? { repo, path: match[2] ?? "" } : null
}

/** The card addressing (lane piper step 5): the global path, and the position a cloud read was taken at. */
const cloudAddressing = (
  store: AppStore,
  repo: string,
  normalized: string
): { readonly address: string; readonly readAt?: { readonly changeId: string | null; readonly commitId: string | null; readonly source: "head" } } => {
  const head = store.collections.repositories.get(repo)?.head ?? null
  return {
    address: `/${repo}/${normalized}`,
    ...(head === null ? {} : { readAt: { changeId: head.changeId, commitId: head.commitId, source: "head" as const } })
  }
}

/** A local read's addressing: the global path when the checkout maps to a repo, read at the jj probe's position. */
const localAddressing = (
  store: AppStore,
  repo: Repo,
  normalized: string
): { readonly address?: string; readonly readAt?: { readonly changeId: string | null; readonly commitId: string | null; readonly source: "working-copy" } } => {
  const repoId = store.collections.workingCopies.get(repoKeyOf(repo.path))?.repoId ?? repoIdFromRemote(repo.git?.remote)
  return {
    ...(repoId !== null && repoId.includes("/") ? { address: `/${repoId}/${normalized}` } : {}),
    ...(repo.jj === undefined ? {} : { readAt: { changeId: repo.jj.changeId, commitId: repo.jj.commitId, source: "working-copy" as const } })
  }
}

/**
 * A path that leaves the repository's namespace, in the one place that
 * decides it. `encodeRepoPath` does not escape a dot, and a URL parser
 * collapses `..` before the request leaves the page, so
 * `/api/repos/{o}/{r}/contents/../../../../user/secrets` resolves to
 * `/api/user/secrets` and is sent same-origin with the visitor's cookies.
 * Every route that spends a caller's path on a URL asks this first: the
 * files flows here, and the sidebar's tree seam (RepoTreeSeam.loadDirectory).
 */
export const unsafePath = (path: string): boolean => {
  const slashNormalized = path.replace(/\\/g, "/")
  return slashNormalized.split("/").some((segment) => {
    let decoded = segment
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return true
    }
    return decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")
  })
}

/** Per-segment encoding, mirroring multi filesClient.ts encodeRepoPath (:53). */
export const encodeRepoPath = (path: string): string => path.split("/").filter(Boolean).map(encodeURIComponent).join("/")

/** The last path segment, for wire entries that answer a path but no name. */
const fileName = (path: string): string => {
  const parts = path.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** One directory row off the wire {name?, path?, type} shape; malformed rows drop. */
export const parseEntry = (value: unknown): FileListEntry | null => {
  if (!isRecord(value)) return null
  if (value.type !== "file" && value.type !== "dir") return null
  const name = typeof value.name === "string" && value.name !== ""
    ? value.name
    : typeof value.path === "string" && value.path !== ""
    ? fileName(value.path)
    : null
  if (name === null) return null
  return { name, kind: value.type }
}

/*
 * Directories first, then names in locale order — the multi sort
 * (filesClient.ts :94). The one order every listing of a directory reads in,
 * card and sidebar alike (RepoTreeSeam.ts sorts its rows with it): the routes
 * do not agree on one. The local route pages by name, and the public mirror
 * answers a git tree's byte order, where `CHANGELOG.md` precedes
 * `Cargo.lock`.
 */
export const sortEntries = (entries: ReadonlyArray<FileListEntry>): FileListEntry[] =>
  [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1
    return a.name.localeCompare(b.name)
  })

/**
 * Base64 → UTF-8, honest about binary: NUL bytes or an undecodable byte
 * sequence answer `binary` instead of mojibake (multi decodeBase64 :101, made
 * strict — the card refuses binary rather than rendering replacement chars).
 */
const decodeBase64 = (value: string): { readonly text: string; readonly binary: boolean } => {
  try {
    const raw = atob(value.replace(/\s+/g, ""))
    const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0))
    if (bytes.includes(0)) return { text: "", binary: true }
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), binary: false }
  } catch {
    return { text: "", binary: true }
  }
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * The open LOCAL repository a files command means, if any (LOCAL-APP.md): an
 * explicit token that matches an open repository's name (`owner/repo` off its
 * remote, or its folder name), its folder name, or its path; with no token,
 * the repository a bare command means (resolveOpenRepo: the active one, as
 * the chrome shows it). A token that matches nothing open, or a bare call
 * with nothing open, is undefined: the Cloud rule applies, so a Cloud read
 * is still one name away.
 */
const localTarget = (
  store: AppStore,
  explicit: string | undefined
): { readonly repo: Repo } | { readonly error: string } | undefined => {
  const repos = [...store.collections.repos.values()]
  if (explicit !== undefined && explicit !== "") {
    const exact = repos.find((repo) => repo.id === explicit || repo.path === explicit || repoKeyOf(repo.path) === explicit)
    if (exact !== undefined) return { repo: exact }
    const named = repos.filter((repo) => repo.name === explicit || repo.path.split("/").pop() === explicit)
    if (named.length > 1) return { error: `${explicit} has several open working copies — name a repository id or path: ${named.map((repo) => `${repo.id} (${repo.path})`).join(", ")}.` }
    return named[0] === undefined ? undefined : { repo: named[0] }
  }
  if (repos.length === 0) return undefined
  const open = resolveOpenRepo(store)
  return "repo" in open ? { repo: open.repo } : { error: open.error }
}

/**
 * Where a file command's path resolves, by the rules the files flows apply:
 * a global `/org/repo/path` first token names both, an unsafe path is
 * refused, an open LOCAL repository wins over a Cloud read, and the Cloud
 * target follows the one repo-resolution rule. Shared with the code-intel
 * seam (CodeIntelSeam.ts), whose acts address the same files.
 */
export type FileTarget =
  | { readonly kind: "local"; readonly repo: Repo; readonly path: string }
  | { readonly kind: "cloud"; readonly repo: string; readonly path: string }
  | { readonly error: string }

export const resolveFileTarget = (store: AppStore, pathArg: string, explicitRepoArg: string | undefined): FileTarget => {
  const global = splitGlobalPath(store, pathArg, explicitRepoArg)
  const path = global?.path ?? pathArg
  const explicitRepo = global?.repo ?? explicitRepoArg
  if (unsafePath(path)) return { error: "File paths must stay inside the repository." }
  const local = localTarget(store, explicitRepo)
  if (local !== undefined) return "error" in local ? local : { kind: "local", repo: local.repo, path: normalizePath(path) }
  const target = resolveTargetRepo(store, explicitRepo)
  return "error" in target ? target : { kind: "cloud", repo: target.repo, path: normalizePath(path) }
}

/*
 * The local route (`POST /api/repo/files`, LOCAL-APP.md): one request
 * answers a directory or a file, already bounded and already honest about
 * binary, so a caller only renders. Failures are the same honest strings
 * the Cloud path answers. Shared with the sidebar's tree seam
 * (RepoTreeSeam.ts), which lists directories through the same request.
 */
export const requestLocalFiles = async (
  ctx: Pick<SeamContext, "http" | "baseUrl">,
  repo: Repo,
  path: string,
  label: string,
  verb: "list" | "read"
): Promise<{ readonly body: RepoFilesResponse } | { readonly error: string }> => {
  let response: Response
  try {
    response = await ctx.http(`${ctx.baseUrl}${REPO_FILES_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: repo.id, path })
    })
  } catch (error) {
    return { error: `Could not reach the local app to ${verb} ${label} in ${repo.name}: ${errorText(error)}` }
  }
  if (response.status === 404) return { error: await readErrorMessage(response, `Path not found: ${label} in ${repo.name}`) }
  if (!response.ok) {
    return {
      error: await readErrorMessage(response, `${verb === "list" ? "Listing" : "Reading"} ${label} in ${repo.name} failed (${response.status})`)
    }
  }
  const parsed = RepoFilesResponseSchema.safeParse(await response.json().catch(() => null))
  if (!parsed.success) return { error: `The local app answered ${label} in ${repo.name} with an unreadable payload` }
  return { body: parsed.data }
}

export const createFilesSeam = (ctx: SeamContext): FilesSeam => {
  const contentsUrl = (repo: string, path: string): string => {
    const [owner = "", name = ""] = repo.split("/")
    const base = `${ctx.baseUrl}/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents`
    return path === "" ? base : `${base}/${encodeRepoPath(path)}`
  }

  const upsert = (card: Card): void => {
    ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card })
  }

  /*
   * The 404 split: the platform answers a missing PATH inside an imported
   * repo with "Path not found: {path}" (multi filesClient.test.ts :93); a
   * repository the platform has never imported 404s the whole namespace
   * (code "not_found", "repository not found" — or no useful body at all).
   * A 404 whose message names the path is the honest path answer; any other
   * 404 means the repo itself is unknown, and the fix is the import.
   */
  const explain404 = async (response: Response, repo: string, fallback: string): Promise<string> => {
    /*
     * A checkout the sidebar still pins but this launch has not opened is
     * the common way a bare files command lands here: the local route was
     * never tried, the Cloud one 404s. Say that, with the act — never
     * "Path not found" for a path that exists on disk.
     */
    const pinned = [...ctx.store.collections.pinnedRepos.values()].find((pin) => pin.name === repo)
    if (pinned !== undefined) return `${repo} is pinned but not open on this machine — open it with /repo.open, then retry.`
    const message = await readErrorMessage(response, fallback)
    if (/path not found/i.test(message)) return message
    return `${repo} isn't imported yet — run /repos.import ${repo} first`
  }

  const localRequest = (repo: Repo, path: string, label: string, verb: "list" | "read") =>
    requestLocalFiles(ctx, repo, path, label, verb)

  const listLocal = async (repo: Repo, path: string): Promise<string | { readonly value: string }> => {
    const normalized = normalizePath(path)
    const label = normalized === "" ? "/" : normalized
    const answer = await localRequest(repo, normalized, label, "list")
    if ("error" in answer) return answer.error
    if (answer.body.kind === "file") return `${normalized} in ${repo.name} is a file — run /files.read ${normalized} instead`
    const entries = sortEntries(answer.body.entries)
    upsert({
      id: `files-${repo.id}-${label}`,
      kind: "file-list",
      title: `Files · ${repo.name} · ${label}`,
      status: "active",
      createdAt: Date.now(),
      ordinal: ctx.nextOrdinal(),
      payload: {
        repo: repo.name,
        localRepoId: repo.id,
        path: normalized,
        entries,
        ...(answer.body.truncated === true ? { truncated: true } : {}),
        ...localAddressing(ctx.store, repo, normalized)
      }
    })
    return {
      value: listingValue(repo.name, normalized, entries) +
        (answer.body.truncated === true ? "\n(the directory holds more entries than the listing cap; this is the first page by name)" : "")
    }
  }

  const readLocal = async (repo: Repo, path: string, anchor: FileAnchor | undefined): Promise<string | { readonly value: string }> => {
    const normalized = normalizePath(path)
    if (normalized === "") return "files.read needs a file path"
    const answer = await localRequest(repo, normalized, normalized, "read")
    if ("error" in answer) return answer.error
    if (answer.body.kind === "dir") return `${normalized} in ${repo.name} is a directory — run /files.list ${normalized} instead`
    const payload = {
      repo: repo.name,
      localRepoId: repo.id,
      path: normalized,
      ...localFileFields(answer.body),
      ...localAddressing(ctx.store, repo, normalized),
      ...anchored(anchor)
    }
    upsert({
      id: localFileCardId(repo.id, normalized),
      kind: "file",
      title: `File · ${repo.name} · ${normalized}`,
      status: "active",
      createdAt: Date.now(),
      ordinal: ctx.nextOrdinal(),
      payload
    })
    return { value: fileValue(repo.name, normalized, payload) }
  }

  return {
    listFiles: async (pathArg, explicitRepoArg) => {
      const target = resolveFileTarget(ctx.store, pathArg, explicitRepoArg)
      if ("error" in target) return target.error
      if (target.kind === "local") return listLocal(target.repo, target.path)
      const { repo, path: normalized } = target
      const label = normalized === "" ? "/" : normalized

      let response: Response
      try {
        response = await ctx.http(contentsUrl(repo, normalized))
      } catch (error) {
        return `Could not reach the backend to list ${label} in ${repo}: ${errorText(error)}`
      }
      if (response.status === 404) {
        return explain404(response, repo, `Path not found: ${label} in ${repo}`)
      }
      if (!response.ok) {
        return readErrorMessage(response, `Listing ${label} in ${repo} failed (${response.status})`)
      }

      const body: unknown = await response.json().catch(() => null)
      if (!Array.isArray(body)) {
        // The contents route answers a record (content/encoding) for a file path.
        if (isRecord(body) && ("content" in body || "encoding" in body)) {
          return `${normalized} in ${repo} is a file — run /files.read ${normalized} instead`
        }
        return `The backend answered ${label} in ${repo} with an unreadable payload`
      }
      const entries = sortEntries(
        body.flatMap((entry) => {
          const parsed = parseEntry(entry)
          return parsed === null ? [] : [parsed]
        })
      )
      upsert({
        id: `files-${repo}-${normalized === "" ? "/" : normalized}`,
        kind: "file-list",
        title: `Files · ${repo} · ${label}`,
        status: "active",
        createdAt: Date.now(),
        ordinal: ctx.nextOrdinal(),
        payload: { repo, path: normalized, entries, ...cloudAddressing(ctx.store, repo, normalized) }
      })
      return { value: listingValue(repo, normalized, entries) }
    },

    readFile: async (pathArg, explicitRepoArg, anchor) => {
      const target = resolveFileTarget(ctx.store, pathArg, explicitRepoArg)
      if ("error" in target) return target.error
      if (target.kind === "local") return readLocal(target.repo, target.path, anchor)
      const { repo, path: normalized } = target
      if (normalized === "") return "files.read needs a file path"

      let response: Response
      try {
        response = await ctx.http(contentsUrl(repo, normalized))
      } catch (error) {
        return `Could not reach the backend to read ${normalized} in ${repo}: ${errorText(error)}`
      }
      if (response.status === 404) {
        return explain404(response, repo, `Path not found: ${normalized} in ${repo}`)
      }
      if (!response.ok) {
        return readErrorMessage(
          response,
          `Reading ${normalized} in ${repo} failed (${response.status})`
        )
      }

      const body: unknown = await response.json().catch(() => null)
      if (Array.isArray(body)) {
        return `${normalized} in ${repo} is a directory — run /files.list ${normalized} instead`
      }
      if (!isRecord(body)) {
        return `The backend answered ${normalized} in ${repo} with an unreadable payload`
      }
      const rawContent = typeof body.content === "string" ? body.content : ""
      /*
       * §8.27: a binary file is STATED, not printed. The card says so rather
       * than laying out 42 000 pixels of base64 the reader can neither use
       * nor reach — and it is a card, because the read succeeded and the
       * answer is about the file.
       *
       * The declared encoding is not trusted on its own: the platform
       * answers `encoding: "utf-8"` for a file whose content is plainly
       * base64-encoded bytes. Only check for mislabelled binary when the
       * stripped body's length matches base64's expansion of the byte size.
       * Plain UTF-8 text (including word and hash lists) cannot have more
       * characters than bytes, so it keeps its declared encoding.
       */
      const binaryCard = (): { readonly value: string } => {
        upsert({
          id: `file-${repo}-${normalized}`,
          kind: "file",
          title: `File · ${repo} · ${normalized}`,
          status: "active",
          createdAt: Date.now(),
          ordinal: ctx.nextOrdinal(),
          payload: { repo, path: normalized, content: "", truncated: false, binary: true, ...cloudAddressing(ctx.store, repo, normalized) }
        })
        return { value: fileValue(repo, normalized, { content: "", truncated: false, binary: true }) }
      }
      let content: string
      if (body.encoding === "base64") {
        const decoded = decodeBase64(rawContent)
        if (decoded.binary) return binaryCard()
        content = decoded.text
      } else {
        if (rawContent.includes("\u0000")) return binaryCard()
        const size = body.size
        const hasBase64Length = typeof size === "number" && Number.isSafeInteger(size) && size > 0 &&
          rawContent.replace(/\s+/g, "").length === 4 * Math.ceil(size / 3)
        if (hasBase64Length && decodeBase64(rawContent).binary) return binaryCard()
        content = rawContent
      }
      const truncated = content.length > CARD_CONTENT_CAP
      const payload = {
        repo,
        path: normalized,
        content: truncated ? content.slice(0, CARD_CONTENT_CAP) : content,
        truncated,
        ...cloudAddressing(ctx.store, repo, normalized),
        ...anchored(anchor)
      }
      upsert({
        id: `file-${repo}-${normalized}`,
        kind: "file",
        title: `File · ${repo} · ${normalized}`,
        status: "active",
        createdAt: Date.now(),
        ordinal: ctx.nextOrdinal(),
        payload
      })
      return { value: fileValue(repo, normalized, payload) }
    }
  }
}
