import { renderPlanLimit } from "./BillingSeam"
import { Effect, Exit, Fiber, FiberMap, Layer, ManagedRuntime, Schedule, Scope } from "effect"
import { preparedView, type ViewAction } from "../PreparedView"
import { refuseCloudSignIn, SIGN_OUT_REFUSAL } from "./CloudSignIn"
import { actorSharedState } from "../ActorBindings"
/*
 * The workspaces seam (lane citc, ADR 0002): the persistent cloud computers
 * behind the `/api/cloud/*` proxy.
 *
 *   GET    /api/user/workspaces                          — the per-user list
 *   GET    /api/repos/{o}/{r}/workspaces                 — one repository's list
 *   POST   /api/repos/{o}/{r}/workspaces                 — create-or-reuse { name?, snapshot_id?, source_bookmark? }
 *   GET    /api/repos/{o}/{r}/workspaces/{id}
 *   POST   /api/repos/{o}/{r}/workspaces/{id}/suspend|resume
 *   POST   /api/repos/{o}/{r}/workspaces/{id}/fork       { name }
 *   DELETE /api/repos/{o}/{r}/workspaces/{id}
 *   POST   /api/repos/{o}/{r}/workspaces/{id}/snapshot   { name }
 *   GET    /api/repos/{o}/{r}/workspace-snapshots
 *   GET    /api/repos/{o}/{r}/workspace-snapshots/{id}
 *   DELETE /api/repos/{o}/{r}/workspace-snapshots/{id}
 *   POST   /api/repos/{o}/{r}/workspace-snapshots        { workspace_id, name } — a template
 *   GET    /api/repos/{o}/{r}/workspace/sessions         { workspace_id }
 *   POST   /api/repos/{o}/{r}/workspace/sessions         { workspace_id, cols, rows } — a terminal;
 *                                                         { workspace_id, kind: "lsp", language } is CloudLspClient's (lane L6)
 *   GET    /api/repos/{o}/{r}/workspace/sessions/{id}
 *   POST   /api/repos/{o}/{r}/workspace/sessions/{id}/destroy
 *   GET    /api/repos/{o}/{r}/workspaces/{id}/files?path=            — the Files facet
 *   GET    /api/repos/{o}/{r}/workspaces/{id}/files/content?path=    — one file
 *   GET    /api/repos/{o}/{r}/workspaces/{id}/services               — the Services facet
 *   GET    /api/repos/{o}/{r}/workspaces/{id}/egress?limit=&cursor=  — the Egress facet
 *
 * Lane L3: plue#446 and plue#449 landed, so the DTO's kind, environment,
 * head, ahead/behind, persistence, ssh host and started_at are parsed and the
 * Files, Services and Egress facets read their own routes. Lane L6: plue#505
 * landed, so the DTO's `lsp.languages` and a session's `kind` and `language`
 * are parsed too. Every one of those
 * fields is absent-tolerant: a field the wire omits is null on the row and
 * renders NOTHING — no default, no guess. `bookmarkHead` stays the TARGET
 * BOOKMARK's head from the bookmarks call, labeled as such and separate from
 * the workspace's own `head`.
 *
 * Every act refuses a degraded sign-in with the enable wording, and a bare act
 * resolves its workspace from the active working copy (kind "workspace"), else
 * the single loaded one — never a guess. A workspace still settling (pending,
 * starting) is polled until it settles or is gone; a 404 mid-watch refreshes
 * the repository's list.
 */
import {
  parseRepoSelection,
  WORKSPACE_STATUSES
} from "../AppState"
import type {
  Card,
  CloudWorkspaceInput,
  CloudWorkspaceRow,
  EnvironmentImageRow,
  SandboxEgressRow,
  WorkspaceDesktop,
  WorkspaceEnvironment,
  WorkspaceFileEntry,
  WorkspaceHead,
  WorkspaceService
} from "../AppState"
import { CARD_CONTENT_CAP, fileValue, listingValue } from "./FilesSeam"
import { resolveTargetRepo } from "../RepoContext"
import { dropDesktopStream, holdDesktopStream } from "./DesktopStream"
import type { DesktopStream } from "./DesktopStream"
import { loadEgressPage, workspaceEgressPath } from "./EgressSeam"
import { workspaceCardFacts } from "../WorkspaceViews"
import { cloudFailure as failed, cloudUnreachable, createCloudClient } from "./CloudClient"
import { mayAutoRetry, statedRetryDelayMs, storedRefusal } from "@smthrs/rpc/Refusal"
import type { Refusal, StoredRefusal } from "@smthrs/rpc/Refusal"
import { refusalSentence } from "@smthrs/rpc/RefusalCopy"
import type { SeamContext } from "./SeamContext"

export const DEGRADED_WORKSPACE_REFUSAL =
  "This Smithers Cloud sign-in can't use workspaces — sign in again to enable them."


/*
 * plue's contract code for a worker that could not start the per-sandbox
 * egress proxy and refused to boot the computer without its credential
 * boundary (internal/microsandbox/worker/server.go). The card says the code
 * itself: a paraphrase would hide which boundary failed.
 */
export const EGRESS_PROXY_UNAVAILABLE = "egress_proxy_unavailable"

/**
 * plue#496: the desktop session POST answers `503 { code:
 * "desktop_not_ready" }` with a `Retry-After` header while the guest's NixOS
 * activation finishes (about 30 s after the VM reports `running`). The
 * server ASKED to be retried, so the seam retries — bounded, and only on
 * that code.
 */
export const DESKTOP_NOT_READY = "desktop_not_ready"

/**
 * The bounded retry the `desktop_not_ready` 503 buys: at plue's own
 * `Retry-After: 2` that is a minute of waiting, which is the activation
 * window. Module-level so tests shorten the wait rather than sleeping.
 */
/**
 * The one-command open (`/desktop`): how long the app waits for plue to bring
 * a desktop box up before it stops and says so. plue took ~21 s on prod on
 * 2026-09-13 (create 202 `starting` → `running` with `desktop.ready`), so the
 * bound is generous rather than tight — but it IS a bound: a wait that never
 * ends is a hang, and the card's Stop is the human's way out before it.
 */
export const desktopBoxWait = {
  /** 60 × 2 s = ~120 s. Tests inject `desktopWaitMs: 0` and keep the attempt bound. */
  maxAttempts: 60,
  pollMs: 2_000
} as const

/** How far the one-command open has got; the card names it while nothing streams yet. */
export type DesktopStage = "creating" | "resuming" | "starting" | "activating" | "streaming"

export const desktopSessionRetry = {
  maxAttempts: 30,
  /** Used only when the refusal carried no `Retry-After` this app could read. */
  defaultDelayMs: 2_000
}

/**
 * plue#504: the terminal session POST answers `503 { code: "guest_not_ready" }`
 * with a `Retry-After` header while a vm or desktop guest finishes its NixOS
 * activation — the same shape, and the same instruction, as the desktop's
 * `desktop_not_ready`. plue sets `RetryAfter: 3` on it.
 */
export const GUEST_NOT_READY = "guest_not_ready"

/**
 * The bounded retry the `guest_not_ready` 503 buys: 30 attempts, which at
 * plue's own `Retry-After: 3` is 90 s — its activation window. Module-level so
 * tests shorten the wait rather than sleeping.
 */
export const terminalSessionRetry = {
  maxAttempts: 30,
  /** Used only when the refusal carried no `Retry-After` this app could read. */
  defaultDelayMs: 3_000
}

export type WorkspaceFacet = "terminal" | "files" | "services" | "snapshots" | "egress" | "desktop"

export interface WorkspaceSeam {
  /** `workspace.list [owner/repo]`: refresh the collection and the tree; a bare call lists the per-user inventory. */
  readonly listWorkspaces: (repo?: string) => Promise<string | void | { readonly value: string }>
  /** The silent refresh (sign-in, boot): the collection and tree, no transcript line. */
  readonly refreshWorkspaces: (repo?: string) => Promise<string | void>
  /**
   * `workspace.open [bookmark] [owner/repo] [--kind container|vm|desktop]`:
   * create-or-reuse, render the card, watch until it settles. ADR 0002 — the
   * kind IS the choice; a call that names none leaves plue's own default
   * (`container`) to stand rather than asserting one.
   */
  readonly openWorkspace: (
    bookmark?: string,
    repo?: string,
    kind?: WorkspaceKind
  ) => Promise<string | void | { readonly value: string }>
  /** `workspace.view <id>`: re-read one workspace and render its card. */
  readonly viewWorkspace: (workspaceId: string) => Promise<string | void | { readonly value: string }>
  /** `workspace.terminal [workspaceId]`: open (or re-attach) the workspace's terminal tab. */
  readonly openTerminal: (workspaceId?: string) => Promise<string | void | { readonly value: string }>
  readonly suspendWorkspace: (workspaceId?: string) => Promise<string | void | { readonly value: string }>
  readonly resumeWorkspace: (workspaceId?: string) => Promise<string | void | { readonly value: string }>
  readonly forkWorkspace: (workspaceId?: string, name?: string) => Promise<string | void | { readonly value: string }>
  readonly snapshotWorkspace: (workspaceId?: string, name?: string) => Promise<string | void | { readonly value: string }>
  readonly deleteSnapshot: (snapshotId: string, workspaceId?: string) => Promise<string | void | { readonly value: string }>
  /** A workspace created FROM a snapshot (the snapshot row's "Fork from"): POST /workspaces { snapshot_id }. */
  readonly forkFromSnapshot: (snapshotId: string, workspaceId?: string) => Promise<string | void | { readonly value: string }>
  readonly templateSnapshot: (snapshotId: string, name: string, workspaceId?: string) => Promise<string | void | { readonly value: string }>
  readonly listSessions: (workspaceId?: string) => Promise<string | void | { readonly value: string }>
  readonly destroySession: (sessionId: string, workspaceId?: string) => Promise<string | void | { readonly value: string }>
  /** `workspace.delete <id> <name>`: the workspace's name typed back is the gate — a mismatch refuses, whoever invoked. */
  readonly deleteWorkspace: (workspaceId: string, confirmName: string) => Promise<string | void | { readonly value: string }>
  /** The card's body tab; hidden, card-button scoped. */
  readonly setFacet: ViewAction<[workspaceId: string, facet: WorkspaceFacet]>
  /** `workspace.files [path] [workspaceId]`: the Files facet at one directory (`""` is the root). */
  readonly listFiles: (path?: string, workspaceId?: string) => Promise<string | void | { readonly value: string }>
  /** `workspace.file <path> [workspaceId]`: read one file out of the workspace and render the file card. */
  readonly readFile: (path: string, workspaceId?: string) => Promise<string | void | { readonly value: string }>
  /** `workspace.services [workspaceId]`: the Services facet's rows. */
  readonly listServices: (workspaceId?: string) => Promise<string | void | { readonly value: string }>
  /**
   * `workspace.egress [workspaceId] [cursor]`: one page of the egress audit.
   * Without a cursor it replaces the facet's rows; with one it appends the
   * older page the card's "Load older" asked for.
   */
  readonly listEgress: (workspaceId?: string, cursor?: string) => Promise<string | void | { readonly value: string }>
  /**
   * `workspace.desktop <workspaceId>`: mint a desktop session and open the
   * facet. The answer is a credential, so it goes to the ephemeral holder in
   * DesktopStream.ts and NEVER to a collection, a transcript row, or a card.
   */
  readonly openDesktop: (workspaceId?: string) => Promise<string | void | { readonly value: string }>
  /** `workspace.desktop.rotate <workspaceId>`: mint again (the guest's VNC password changes; the old iframe drops). */
  readonly rotateDesktop: (workspaceId?: string) => Promise<string | void | { readonly value: string }>
  /**
   * `/desktop [bookmark] [owner/repo]`: create-or-reuse the desktop box on a
   * bookmark, wait for plue to report it ready, and mint its stream — the
   * whole thing under the one confirmation the flow asked for.
   */
  readonly openDesktopBox: (bookmark?: string, repo?: string) => Promise<string | void | { readonly value: string }>
  /** `workspace.desktop.stop <workspaceId>`: stop waiting for the box, without touching the box. */
  readonly stopDesktopWait: (workspaceId: string) => Promise<string | void>
  /** `workspace.images [owner/repo]`: the environment images a repository has built. */
  readonly listEnvironmentImages: (repo?: string) => Promise<string | void | { readonly value: string }>
  /**
   * One event off `GET …/workspaces/{id}/stream` (RFD-004). The stream now
   * carries `{ status, head, ahead, behind }` when the guest reports a new
   * head, and `{ status }` alone otherwise: a status-only event must leave the
   * head exactly as it was rather than blanking it.
   */
  readonly applyStatusEvent: (workspaceId: string, event: unknown) => void
  /** Stop owned reads, polls and waits, and drop any minted desktop credential. */
  readonly dispose: () => void
}

/** The three sandbox kinds ADR 0002 names; the option surface offers exactly these. */
export const WORKSPACE_KINDS = ["container", "vm", "desktop"] as const
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number]

export interface WorkspaceSeamDeps {
  /** The watch and session-settle poll interval; tests inject ~0. */
  readonly pollMs?: number
  /** The one-command open's readiness poll interval; tests inject 0. */
  readonly desktopWaitMs?: number
}

interface SnapshotRow {
  readonly id: string
  readonly name: string
  readonly createdAt: string | null
}

interface SessionRow {
  readonly id: string
  readonly status: string
  readonly createdAt: string | null
  /** plue #505: `terminal` or `lsp`; null on a row that predates the field. */
  readonly kind: string | null
  /** The lsp session's language; null on a terminal. */
  readonly language: string | null
}

/** The auxiliaries a workspace card renders beside the DTO row. */
interface CardAux {
  readonly bookmarkHead: { readonly changeId: string | null; readonly commitId: string | null } | null
  readonly snapshots: ReadonlyArray<SnapshotRow>
  readonly sessions: ReadonlyArray<SessionRow>
  readonly files: ReadonlyArray<WorkspaceFileEntry>
  readonly filesPath: string
  readonly services: ReadonlyArray<WorkspaceService>
  readonly egress: ReadonlyArray<SandboxEgressRow>
  /** plue's next keyset position; an explicit null says the audit is exhausted. */
  readonly egressCursor: string | null
  readonly facet?: WorkspaceFacet | undefined
  /** The attached session; an explicit null override detaches. */
  readonly terminalSessionId?: string | null | undefined
  readonly error?: string | undefined
  /** plue refused an act with `egress_proxy_unavailable`; the card names the code. */
  readonly egressProxyUnavailable?: boolean | undefined
  /**
   * How the desktop session POST refused, as the one `Refusal` shape the app
   * renders: plue's status beside its own words, its machine-readable `code`
   * (which survives the 5xx message sanitizer), the `Retry-After` seconds it
   * asked for (lane L3b; plue#496), and — since the failure registry landed —
   * whose FAULT it was and which party said so.
   */
  readonly desktopRefusal?: StoredRefusal | undefined
  /**
   * How far `/desktop` has got. An explicit null clears the line — the wait
   * ended, whether it streamed, failed, or the human stopped it.
   */
  readonly desktopStage?: DesktopStage | null | undefined
  /**
   * How the terminal session POST refused: the same shape, on the terminal
   * facet (plue#504). A `wait` fault — `guest_not_ready` is one — is the only
   * kind the seam retries on its own, because the server asked it to.
   */
  readonly terminalRefusal?: StoredRefusal | undefined
}

const UNSETTLED: ReadonlySet<string> = new Set(["pending", "starting"])

/** The statuses plue's workspace sessions move through. */
const SESSION_LIVE = "running"

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

/** How long a new terminal session may take to reach running before the honest refusal. */
const SESSION_SETTLE_ATTEMPTS = 30

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/** The list a route answers: plue's bare array, its `{ items, next_cursor }` cursor envelope, or one under a named key. */
const arrayOf = (body: unknown, key: string): ReadonlyArray<unknown> => {
  if (Array.isArray(body)) return body
  if (isRecord(body) && Array.isArray(body[key])) return body[key]
  if (isRecord(body) && Array.isArray(body.items)) return body.items
  return []
}

/** Both list routes page at 30 by default and cap at 100 (plue routes/pagination.go, routes/workspace.go). */
const LIST_PAGE_LIMIT = 100
/** 100 rows × 50 pages is far past plue's per-user active-workspace cap; the loop never runs unbounded. */
const MAX_LIST_PAGES = 50

/**
 * The `rel="next"` target of a Link header, or null on the last page. plue
 * writes its list links in the legacy `page`/`per_page` form
 * (setLegacyPaginationHeaders); the per-user route's own parser reads only
 * `cursor`/`limit`, so a next link is re-issued in cursor form — the offset
 * `(page - 1) × per_page` — which both list routes accept.
 */
const nextPageOf = (link: string | null, path: string): string | null => {
  if (link === null) return null
  // The seam's paths omit the `/api` the proxy adds; plue's links carry it.
  const upstreamPath = `/api${path}`
  for (const part of link.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part.trim())
    if (match === null || match[1] === undefined) continue
    let next: URL
    try {
      next = new URL(match[1], "https://cloud.invalid")
    } catch {
      return null
    }
    // A link that leaves the route it paginates is not followed.
    if (next.pathname !== upstreamPath) return null
    const cursor = next.searchParams.get("cursor")
    if (cursor !== null && cursor !== "") return `${path}?limit=${LIST_PAGE_LIMIT}&cursor=${encodeURIComponent(cursor)}`
    const page = Number(next.searchParams.get("page"))
    const perPage = Number(next.searchParams.get("per_page") ?? next.searchParams.get("limit"))
    if (!Number.isInteger(page) || page < 2 || !Number.isInteger(perPage) || perPage <= 0) return null
    return `${path}?limit=${LIST_PAGE_LIMIT}&cursor=${(page - 1) * perPage}`
  }
  return null
}

const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null)

const textOrNull = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null)

const isWorkspaceStatus = (value: unknown): value is CloudWorkspaceInput["status"] =>
  typeof value === "string" && (WORKSPACE_STATUSES as ReadonlyArray<string>).includes(value)

/**
 * The DTO's `head` (plue#446): the workspace's OWN head as the guest last
 * reported it. plue writes empty strings when it has reported none, and an
 * empty head is absent, not a head of "".
 */
const parseHead = (value: unknown): WorkspaceHead | null => {
  if (!isRecord(value)) return null
  const changeId = textOrNull(value.change_id)
  const commitId = textOrNull(value.commit_id)
  return changeId === null && commitId === null ? null : { changeId, commitId }
}

/**
 * The DTO's `environment`: the Nix expression the computer was built from and
 * — lane L3b — the registry `image` a vm or desktop workspace actually booted.
 * `image` is empty for a container, and an empty string is absence.
 */
const parseEnvironment = (value: unknown): WorkspaceEnvironment | null => {
  if (!isRecord(value)) return null
  const source = textOrNull(value.source)
  if (source === null) return null
  return {
    source,
    revision: textOrNull(value.revision),
    closureHash: textOrNull(value.closure_hash),
    image: textOrNull(value.image)
  }
}

/*
 * The DTO's `desktop` object (lane L3b), present only when `kind` is
 * `desktop`. `stream_url` here is plue's RELATIVE path — never credentialed —
 * `session` is the last mint's id and expiry, or null before the first one,
 * and — plue#496 — `ready` is true only once the guest verified noVNC. A
 * desktop object that says none of the three is absence, not an empty desktop.
 */
const parseDesktop = (value: unknown): WorkspaceDesktop | null => {
  if (!isRecord(value)) return null
  const streamUrl = textOrNull(value.stream_url)
  const raw = value.session
  const sessionId = isRecord(raw) ? textOrNull(raw.id) : null
  const session = sessionId === null || !isRecord(raw)
    ? null
    : { id: sessionId, expiresAt: textOrNull(raw.expires_at) }
  /* plue#496 `ready`: the guest verified noVNC. A DTO that omits it says nothing about readiness. */
  const ready = typeof value.ready === "boolean" ? value.ready : null
  if (streamUrl === null && session === null && ready === null) return null
  return { ready, streamUrl, session }
}

/*
 * The 201 of POST …/workspaces/{id}/desktop/session. Only the absolute
 * `stream_url` and the session's id and expiry are read; `token` and
 * `vnc_password` are deliberately NOT read out of the body, because the URL
 * already carries them and a second copy is a second place to leak from.
 */
const parseDesktopMint = (value: unknown, workspaceId: string): DesktopStream | null => {
  if (!isRecord(value)) return null
  const url = textOrNull(value.stream_url)
  const raw = value.session
  const sessionId = isRecord(raw) ? textOrNull(raw.id) : null
  if (url === null || sessionId === null || !isRecord(raw)) return null
  /*
   * The URL becomes the facet iframe's `src` verbatim, and that frame's
   * sandbox carries allow-scripts + allow-same-origin: a `javascript:` URL
   * inherits THIS origin and runs with the app's credentials, and a relative
   * or schemeless one resolves against this origin. Only an absolute
   * http(s) URL is a stream (http: covers a loopback plue in dev); anything
   * else is malformed, never a stream.
   */
  try {
    const protocol = new URL(url).protocol
    if (protocol !== "https:" && protocol !== "http:") return null
  } catch {
    return null
  }
  return { workspaceId, url, sessionId, expiresAt: textOrNull(raw.expires_at) }
}

/**
 * One row of `GET /api/repos/{o}/{r}/environment-images` (lane L3b). plue's
 * `repository_id 0` is the platform base image; an empty `golden_snapshot_id`
 * means the first boot of that closure is a cold registry pull.
 */
const parseEnvironmentImage = (value: unknown): EnvironmentImageRow | null => {
  if (!isRecord(value)) return null
  const rawId = value.id
  const id = typeof rawId === "number" && Number.isInteger(rawId) ? String(rawId) : str(rawId)
  const kind = str(value.kind)
  const source = str(value.source)
  const status = str(value.status)
  if (id === null || kind === null || source === null || status === null) return null
  return {
    id,
    kind,
    source,
    sourceRevision: textOrNull(value.source_revision),
    closureHash: textOrNull(value.closure_hash),
    image: textOrNull(value.image),
    status,
    platformBase: value.repository_id === 0,
    coldPull: textOrNull(value.golden_snapshot_id) === null
  }
}

/** A wire count that must be a whole number to be stated at all. */
const countOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : null

/**
 * The DTO's `lsp.languages` (plue #505): the languages the workspace relays a
 * language server for. A DTO with no `lsp` object is null — unknown, never
 * an empty list; an `lsp` object with no readable languages is `[]`.
 */
const parseLspLanguages = (value: unknown): Array<string> | null => {
  if (!isRecord(value)) return null
  const languages = value.languages
  if (!Array.isArray(languages)) return []
  return languages.flatMap((entry) => (typeof entry === "string" && entry !== "" ? [entry] : []))
}

/** One workspace row off the wire; malformed rows drop. */
const parseWorkspaceWire = (value: unknown, fallbackRepo?: string): CloudWorkspaceInput | null => {
  if (!isRecord(value)) return null
  const id = str(value.id)
  const repoId = str(value.repo_full_name) ?? fallbackRepo ?? null
  const name = str(value.name) ?? str(value.slug)
  if (id === null || repoId === null || name === null || !isWorkspaceStatus(value.status)) return null
  return {
    id,
    repoId,
    name,
    targetBookmark: textOrNull(value.target_bookmark),
    status: value.status,
    /* plue#482: why a failed workspace failed, in the provider's own words. */
    failureCode: textOrNull(value.failure_code),
    failureMessage: textOrNull(value.failure_message),
    provisioningStage: textOrNull(value.provisioning_stage),
    suspendedAt: textOrNull(value.suspended_at),
    createdAt: textOrNull(value.created_at),
    kind: textOrNull(value.kind),
    /* RFD-004: the agent session that drove this computer, on a `kind: "agent"` workspace. */
    agentSessionId: textOrNull(value.agent_session_id),
    head: parseHead(value.head),
    ahead: countOrNull(value.ahead),
    behind: countOrNull(value.behind),
    startedAt: textOrNull(value.started_at),
    environment: parseEnvironment(value.environment),
    persistence: textOrNull(value.persistence),
    sshHost: textOrNull(value.ssh_host),
    desktop: parseDesktop(value.desktop),
    lspLanguages: parseLspLanguages(value.lsp)
  }
}

/** One row of the workspace file listing (plue#449); a row missing a name drops. */
const parseFileEntry = (value: unknown): WorkspaceFileEntry | null => {
  if (!isRecord(value)) return null
  const name = str(value.name)
  const type = str(value.type)
  if (name === null || type === null) return null
  const size = value.size
  return {
    name,
    // plue always writes `path`; a row without one is still nameable under the directory the facet asked for.
    path: str(value.path) ?? name,
    type,
    size: typeof size === "number" && Number.isInteger(size) && size >= 0 ? size : null
  }
}

/**
 * One managed-service row (plue#449, and #483's `port` / `url`). Both are
 * `omitempty` on the wire, so a service that publishes neither carries
 * neither and the row states a name and a state alone — an absent port is
 * absence, never a zero.
 */
const parseService = (value: unknown): WorkspaceService | null => {
  if (!isRecord(value)) return null
  const name = str(value.name)
  const state = str(value.state)
  if (name === null || state === null) return null
  const port = value.port
  return {
    name,
    state,
    port: typeof port === "number" && Number.isInteger(port) && port > 0 ? port : null,
    url: str(value.url)
  }
}

/*
 * One row of GET /api/user/workspaces: plue's UserWorkspaceRow
 * (internal/services/workspace.go — workspace_id, repository_owner,
 * repository_name, workspace_title, state), a switcher row that carries no
 * bookmark, stage, or suspension time. Those stay whatever the collection
 * already knows (the caller merges); they are never invented here.
 */
const parseUserWorkspaceWire = (value: unknown): CloudWorkspaceInput | null => {
  if (!isRecord(value)) return null
  const id = str(value.workspace_id)
  const owner = str(value.repository_owner)
  const repoName = str(value.repository_name)
  const name = str(value.workspace_title)
  if (id === null || owner === null || repoName === null || name === null || !isWorkspaceStatus(value.state)) return null
  return {
    id,
    repoId: `${owner}/${repoName}`,
    name,
    targetBookmark: null,
    status: value.state,
    /* plue#482: the switcher row states the failure too, so a failed row explains itself in the list. */
    failureCode: textOrNull(value.failure_code),
    failureMessage: textOrNull(value.failure_message),
    provisioningStage: null,
    suspendedAt: null,
    createdAt: textOrNull(value.created_at),
    /*
     * The switcher row carries none of plue#446's header facts — no kind, no
     * head, no ahead/behind, no environment, no persistence, no ssh host, no
     * start time. They are null HERE and the caller restores whatever the
     * collection already knows; nothing is read out of the per-repo DTO's
     * shape, because this route does not answer that shape.
     */
    kind: null,
    agentSessionId: null,
    head: null,
    ahead: null,
    behind: null,
    startedAt: null,
    environment: null,
    persistence: null,
    sshHost: null,
    desktop: null,
    lspLanguages: null
  }
}

/** One bookmark row off the wire; malformed rows drop. */
const parseBookmark = (value: unknown): { readonly name: string; readonly changeId: string | null; readonly commitId: string | null } | null => {
  if (!isRecord(value) || typeof value.name !== "string" || value.name === "") return null
  return {
    name: value.name,
    changeId: typeof value.target_change_id === "string" ? value.target_change_id : null,
    commitId: typeof value.target_commit_id === "string" ? value.target_commit_id : null
  }
}

/** One snapshot row off the wire; malformed rows drop. */
const parseSnapshot = (value: unknown): SnapshotRow | null => {
  if (!isRecord(value)) return null
  const id = str(value.id)
  const name = str(value.name)
  if (id === null || name === null) return null
  return { id, name, createdAt: textOrNull(value.created_at) }
}

/** One session row off the wire; malformed rows drop. */
const parseSession = (value: unknown): (SessionRow & { readonly workspaceId: string | null }) | null => {
  if (!isRecord(value)) return null
  const id = str(value.id)
  const status = str(value.status)
  if (id === null || status === null) return null
  return {
    id,
    status,
    createdAt: textOrNull(value.created_at),
    workspaceId: textOrNull(value.workspace_id),
    kind: textOrNull(value.kind),
    language: textOrNull(value.language)
  }
}

/** A session row as the repository-wide list carries it: it still names its workspace. */
type RepoSessionRow = SessionRow & { readonly workspaceId: string | null }

/*
 * One workspace's rows out of the repository's list. A row that names no
 * workspace belongs to every card — the list route answers for the whole
 * repository and the wire may omit `workspace_id`.
 */
const sessionsOf = (rows: ReadonlyArray<RepoSessionRow>, workspaceId: string): ReadonlyArray<SessionRow> =>
  rows.filter((row) => row.workspaceId === null || row.workspaceId === workspaceId)

const cardIdOf = (workspaceId: string): string => `workspace-${workspaceId}`

const splitRepo = (repoId: string): { readonly owner: string; readonly name: string } => {
  const [owner = "", name = ""] = repoId.split("/")
  return { owner, name }
}

export const createWorkspaceSeam = (ctx: SeamContext, deps: WorkspaceSeamDeps = {}): WorkspaceSeam => {
  const pollMs = deps.pollMs ?? 5_000
  const desktopWaitMs = deps.desktopWaitMs ?? desktopBoxWait.pollMs
  const repoPath = (repoId: string, rest: string): string => {
    const { owner, name } = splitRepo(repoId)
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${rest}`
  }

  const { runtime, watching, sleepers, desktopMintEpochs, terminalOpenEpochs, lifecycle, workspaceEpochs } = actorSharedState(ctx, "workspace", () => {
    const runtime = ManagedRuntime.make(Layer.empty)
    const [watching, sleepers] = Effect.runSync(Effect.all([
      FiberMap.make<string, void>(),
      FiberMap.make<{ readonly workspaceId: string }, void>()
    ]).pipe(Scope.provide(runtime.scope)))
    return {
      runtime, watching, sleepers,
      desktopMintEpochs: new Map<string, number>(),
      terminalOpenEpochs: new Map<string, number>(),
      lifecycle: { disposed: false },
      workspaceEpochs: new Map<string, number>()
    }
  })
  const { url: cloud, get, send: sendJson } = createCloudClient(ctx)
  const read = (path: string, label?: string) => Effect.tryPromise({
    try: (signal) => get(path, label, signal), catch: cloudUnreachable
  }).pipe(Effect.catch((failure) => Effect.succeed(failure)))
  const getJson = (path: string, label?: string) => runtime.runPromise(read(path, label)).catch(cloudUnreachable)

  /** The lifetime and authorization captured before an await must still own its answer. */
  const currentOperation = (workspaceId?: string): (() => boolean) => {
    const session = ctx.store.collections.cloudSessions.get("cloud")
    const epoch = workspaceId === undefined ? undefined : workspaceEpochs.get(workspaceId)
    return () => !lifecycle.disposed
      && session?.state === "signed-in"
      && ctx.store.collections.cloudSessions.get("cloud")?.revision === session.revision
      && (workspaceId === undefined || (
        ctx.store.collections.cloudWorkspaces.has(workspaceId)
        && workspaceEpochs.get(workspaceId) === epoch
      ))
  }

  /** 5s cadence × 120 = ten minutes, the provisioning ceiling the workspaces spec names. */
  const MAX_WATCH_POLLS = 120

  const sleep = (ms: number, workspaceId: string): Promise<boolean> => {
    if (lifecycle.disposed) return Promise.resolve(false)
    return runtime.runPromiseExit(Effect.flatMap(
      FiberMap.run(sleepers, { workspaceId }, Effect.sleep(ms)), Fiber.join
    )).then(Exit.isSuccess)
  }

  const cancelSleeps = (workspaceId?: string): void => {
    for (const [key] of sleepers) {
      if (workspaceId === undefined || key.workspaceId === workspaceId) runtime.runFork(FiberMap.remove(sleepers, key))
    }
  }

  const dispose = (): void => {
    if (lifecycle.disposed) return
    lifecycle.disposed = true
    void runtime.dispose()
    /* The controller is going away, so no facet can be mounted: the credential goes with it. */
    dropDesktopStream()
    desktopMintEpochs.clear()
    terminalOpenEpochs.clear()
  }

  /*
   * The two gates every workspace act passes: a definitive signed-in answer,
   * and the scope set — the legacy (degraded) token reads but never acts.
   */
  const gate = (): string | void => {
    if (lifecycle.disposed) return "The workspace controller is disposed."
    const session = ctx.store.collections.cloudSessions.get("cloud")
    if (session?.state !== "signed-in") return refuseCloudSignIn(ctx)
    if (session.scopes === "degraded") return refuseCloudSignIn(ctx, DEGRADED_WORKSPACE_REFUSAL)
  }

  /*
   * The workspace a bare act means: an explicit id (looked up locally — the
   * id alone cannot route without its repository), else the active working
   * copy when it is a workspace, else the single loaded workspace. Never a
   * guess.
   */
  const resolveWorkspace = (
    workspaceId?: string
  ): { readonly workspace: CloudWorkspaceRow } | { readonly error: string } => {
    const { cloudWorkspaces, workingCopies } = ctx.store.collections
    if (workspaceId !== undefined && workspaceId !== "") {
      const row = cloudWorkspaces.get(workspaceId)
      return row === undefined
        ? { error: `Workspace ${workspaceId} is not loaded — /workspace.list refreshes the inventory` }
        : { workspace: row }
    }
    const key = ctx.store.session().activeRepoKey ?? null
    const selection = key === null ? null : parseRepoSelection(key)
    if (selection !== null && "repoId" in selection && selection.copyId !== undefined) {
      const copy = workingCopies.get(selection.copyId)
      if (copy?.kind === "workspace" && copy.workspaceId !== undefined) {
        const row = cloudWorkspaces.get(copy.workspaceId)
        if (row !== undefined) return { workspace: row }
      }
    }
    const all = [...cloudWorkspaces.values()]
    if (all.length === 1) return { workspace: all[0]! }
    if (all.length === 0) {
      return { error: "No cloud workspace is loaded — /workspace.open creates one, /workspace.list refreshes" }
    }
    return { error: `Several workspaces are loaded (${all.map((row) => row.id).join(", ")}) — name a workspace id` }
  }

  /* The repository a snapshot or session act routes through. */
  const resolveRepo = (
    workspaceId?: string
  ): { readonly repo: string; readonly workspaceId?: string } | { readonly error: string } => {
    const resolved = resolveWorkspace(workspaceId)
    if ("error" in resolved) return resolved
    return { repo: resolved.workspace.repoId, workspaceId: resolved.workspace.id }
  }

  /* ---- the auxiliaries: absent answers, never inventions ---- */

  const loadBookmarkHead = async (
    repoId: string,
    bookmark: string | null
  ): Promise<{ readonly changeId: string | null; readonly commitId: string | null } | null> => {
    if (bookmark === null) return null
    const answer = await getJson(repoPath(repoId, "/bookmarks"))
    if ("error" in answer) return null
    const found = arrayOf(answer.body, "bookmarks")
      .flatMap((entry) => {
        const parsed = parseBookmark(entry)
        return parsed === null ? [] : [parsed]
      })
      .find((entry) => entry.name === bookmark)
    return found === undefined ? null : { changeId: found.changeId, commitId: found.commitId }
  }

  /** The repository's snapshot/template list; null = unread (an absent answer, not a fact). */
  const loadSnapshots = async (repoId: string): Promise<ReadonlyArray<SnapshotRow> | null> => {
    const answer = await getJson(repoPath(repoId, "/workspace-snapshots"))
    if ("error" in answer) return null
    return arrayOf(answer.body, "snapshots").flatMap((entry) => {
      const parsed = parseSnapshot(entry)
      return parsed === null ? [] : [parsed]
    })
  }

  const workspacePath = (repoId: string, workspaceId: string, rest: string): string =>
    repoPath(repoId, `/workspaces/${encodeURIComponent(workspaceId)}${rest}`)

  /** One directory inside the working copy (plue#449); the server's own error when it refuses. */
  const loadFiles = async (
    repoId: string,
    workspaceId: string,
    path: string
  ): Promise<ReadonlyArray<WorkspaceFileEntry> | { readonly error: string }> => {
    const answer = await getJson(`${workspacePath(repoId, workspaceId, "/files")}?path=${encodeURIComponent(path)}`)
    if ("error" in answer) return { error: answer.error }
    return arrayOf(answer.body, "entries").flatMap((entry) => {
      const parsed = parseFileEntry(entry)
      return parsed === null ? [] : [parsed]
    })
  }

  /** The workspace's managed services (plue#449). */
  const loadServices = async (
    repoId: string,
    workspaceId: string
  ): Promise<ReadonlyArray<WorkspaceService> | { readonly error: string }> => {
    const answer = await getJson(workspacePath(repoId, workspaceId, "/services"))
    if ("error" in answer) return { error: answer.error }
    return arrayOf(answer.body, "services").flatMap((entry) => {
      const parsed = parseService(entry)
      return parsed === null ? [] : [parsed]
    })
  }

  /*
   * The repository's whole session list; null = unread. The route is
   * repository-wide, so a refresh that touches several cards reads it ONCE
   * and selects each card's rows out of the one snapshot.
   */
  const loadRepoSessions = async (repoId: string): Promise<ReadonlyArray<RepoSessionRow> | null> => {
    const answer = await getJson(repoPath(repoId, "/workspace/sessions"))
    if ("error" in answer) return null
    return arrayOf(answer.body, "sessions").flatMap((entry) => {
      const parsed = parseSession(entry)
      return parsed === null ? [] : [parsed]
    })
  }

  /** One workspace's sessions; null = unread. */
  const loadSessions = async (repoId: string, workspaceId: string): Promise<ReadonlyArray<SessionRow> | null> => {
    const rows = await loadRepoSessions(repoId)
    return rows === null ? null : sessionsOf(rows, workspaceId)
  }

  /* ---- the card ---- */

  /*
   * Render one workspace's card: the DTO row plus the auxiliaries. An
   * override wins; otherwise the existing card's value stands, so a status
   * poll never blanks the snapshots the open loaded.
   */
  const workspaceCard = (workspace: CloudWorkspaceInput, overrides: Partial<CardAux> = {}): Card => {
    const id = cardIdOf(workspace.id)
    const existing = ctx.store.collections.cards.get(id)
    const prior = existing?.kind === "workspace" ? existing.payload : undefined
    /*
     * The collection is the authority: every act dispatches its DTO before
     * it renders, and a settle poll that landed while an act's auxiliaries
     * were loading has already advanced the row — the card renders THAT,
     * never the act's older answer, so the card and the tree agree.
     */
    const current = ctx.store.collections.cloudWorkspaces.get(workspace.id) ?? workspace
    const payload = {
      ...workspaceCardFacts(current),
      bookmarkHead: overrides.bookmarkHead !== undefined ? overrides.bookmarkHead : prior?.bookmarkHead ?? null,
      snapshots: overrides.snapshots !== undefined ? [...overrides.snapshots] : prior?.snapshots ?? [],
      sessions: overrides.sessions !== undefined ? [...overrides.sessions] : prior?.sessions ?? [],
      ...(overrides.files !== undefined
        ? { files: [...overrides.files], filesPath: overrides.filesPath ?? "" }
        : prior?.files !== undefined ? { files: prior.files, filesPath: prior.filesPath ?? "" } : {}),
      ...(overrides.services !== undefined
        ? { services: [...overrides.services] }
        : prior?.services !== undefined ? { services: prior.services } : {}),
      ...(overrides.egress !== undefined
        ? { egress: [...overrides.egress], egressCursor: overrides.egressCursor ?? null }
        : prior?.egress !== undefined ? { egress: prior.egress, egressCursor: prior.egressCursor ?? null } : {}),
      ...(overrides.facet !== undefined
        ? { facet: overrides.facet }
        : prior?.facet !== undefined ? { facet: prior.facet } : {}),
      ...(overrides.terminalSessionId !== undefined
        ? overrides.terminalSessionId === null ? {} : { terminalSessionId: overrides.terminalSessionId }
        : prior?.terminalSessionId !== undefined ? { terminalSessionId: prior.terminalSessionId } : {}),
      ...(overrides.error !== undefined ? { error: overrides.error } : {}),
      ...(overrides.egressProxyUnavailable === true ? { egressProxyUnavailable: true } : {}),
      /*
       * Like `error`, a desktop refusal belongs to the act that just ran: it
       * is never carried forward, so a successful mint clears the one before
       * it without anyone having to remember to.
       */
      ...(overrides.desktopRefusal === undefined ? {} : { desktopRefusal: overrides.desktopRefusal }),
      /*
       * The wait's stage is the act's too, but it must SURVIVE the status
       * polls that land mid-wait — so unlike a refusal it carries forward,
       * and only an explicit null (the wait ended) clears it.
       */
      ...(overrides.desktopStage === undefined
        ? prior?.desktopStage == null ? {} : { desktopStage: prior.desktopStage }
        : overrides.desktopStage === null ? {} : { desktopStage: overrides.desktopStage }),
      ...(overrides.terminalRefusal === undefined ? {} : { terminalRefusal: overrides.terminalRefusal })
    }
    const card: Card = {
      id,
      kind: "workspace",
      title: `${current.name} · ${current.repoId}`,
      status: "active",
      createdAt: existing?.createdAt ?? Date.now(),
      ordinal: existing?.ordinal ?? ctx.nextOrdinal(),
      payload
    }
    return card
  }
  const renderWorkspace = (workspace: CloudWorkspaceInput, overrides: Partial<CardAux> = {}): void => {
    ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card: workspaceCard(workspace, overrides) })
  }

  /*
   * The failure side of an act: the refusal rides the card too, so it stays
   * visible. A refusal plue coded `egress_proxy_unavailable` names that code
   * as well as the message — the worker refused to boot the computer without
   * its credential boundary, and "service unavailable" alone would hide which
   * boundary failed.
   */
  const failOnCard = (
    workspace: CloudWorkspaceInput,
    refusal: string | { readonly error: string; readonly code: string | null; readonly refusal?: Refusal }
  ): string | Promise<string> => {
    if (typeof refusal !== "string" && refusal.refusal?.rawCode === "plan_limit_exceeded") {
      return renderPlanLimit(ctx.store, refusal.refusal, ctx.checkout ?? true, ctx.actor())
    }
    const error = typeof refusal === "string" ? refusal : refusal.error
    const proxyGone = typeof refusal !== "string" && refusal.code === EGRESS_PROXY_UNAVAILABLE
    renderWorkspace(workspace, { error, ...(proxyGone ? { egressProxyUnavailable: true } : {}) })
    /*
     * The line that goes back to the transcript, the toast and the model: the
     * code first (the anchor the agent boundary reads), then plue's own words,
     * then the one sentence saying whose fault it was. A bare string caller
     * has no refusal to classify and keeps its sentence unchanged.
     */
    const classified = typeof refusal === "string" ? undefined : refusal.refusal
    return classified === undefined ? error : refusalSentence(classified)
  }

  /* ---- the list load (listWorkspaces, delete's aftermath, a 404 mid-watch) ---- */

  /** One page of a list route: its body and the next page's seam path (cursor form), or the honest error. */
  const getListPage = (
    pagePath: string,
    routePath: string
  ): Effect.Effect<{ readonly body: unknown; readonly next: string | null; readonly total: number | null } | { readonly error: string }> => Effect.gen(function*() {
    const answer = yield* read(pagePath, routePath)
    if ("error" in answer) return answer
    const { response } = answer
    const totalHeader = response.headers.get("x-total-count")
    const total = Number(totalHeader)
    return {
      body: answer.body,
      next: nextPageOf(response.headers.get("link"), routePath),
      total: totalHeader !== null && Number.isInteger(total) && total >= 0 ? total : null
    }
  })

  /*
   * The whole list, every page: `?limit=100` and the Link header's next page
   * until it is exhausted. A body that answered rows Smithers could not read
   * is an error, never an empty scope replace that would drop every loaded
   * workspace and its tree row.
   */
  const loadListEffect = (
    repo?: string,
    current = currentOperation()
  ): Effect.Effect<ReadonlyArray<CloudWorkspaceInput> | string> => Effect.gen(function*() {
    const path = repo === undefined ? "/user/workspaces" : repoPath(repo, "/workspaces")
    const raw: Array<unknown> = []
    let next: string | null = `${path}?limit=${LIST_PAGE_LIMIT}`
    const seen = new Set<string>()
    for (let page = 0; next !== null && page < MAX_LIST_PAGES; page += 1) {
      if (seen.has(next)) break
      seen.add(next)
      if (!current()) return SIGN_OUT_REFUSAL
      const answer: Effect.Success<ReturnType<typeof getListPage>> = yield* getListPage(next, path)
      if (!current()) return SIGN_OUT_REFUSAL
      if ("error" in answer) return answer.error
      const rows = arrayOf(answer.body, "workspaces")
      raw.push(...rows)
      if (rows.length === 0 || (answer.total !== null && raw.length >= answer.total)) break
      next = answer.next
    }
    const parsed = raw.flatMap((entry) => {
      const row = repo === undefined
        ? parseUserWorkspaceWire(entry) ?? parseWorkspaceWire(entry)
        : parseWorkspaceWire(entry, repo)
      return row === null ? [] : [row]
    })
    if (raw.length > 0 && parsed.length === 0) {
      return `Smithers Cloud answered ${raw.length} workspace row${raw.length === 1 ? "" : "s"} in a shape Smithers can't read — the loaded workspaces were kept.`
    }
    /*
     * The per-user row is a switcher row: no bookmark, no stage, no
     * suspension time. What the collection already holds for a workspace
     * stands where the row is silent; a status that moved on drops the
     * fields that only made sense in the old one.
     */
    const workspaces = repo === undefined
      ? parsed.map((row) => {
        const known = ctx.store.collections.cloudWorkspaces.get(row.id)
        if (known === undefined) return row
        return {
          ...row,
          targetBookmark: known.targetBookmark,
          provisioningStage: UNSETTLED.has(row.status) ? known.provisioningStage : null,
          suspendedAt: row.status === "suspended" ? known.suspendedAt : null,
          createdAt: row.createdAt ?? known.createdAt,
          /*
           * plue#446's header facts are not in the switcher row. What the
           * per-repo DTO already taught the collection stands — except
           * `startedAt`, which only describes a running VM: a status that
           * left "running" drops it rather than reporting an uptime for a
           * computer that is no longer up.
           */
          kind: known.kind ?? null,
          agentSessionId: known.agentSessionId ?? null,
          head: known.head ?? null,
          ahead: known.ahead ?? null,
          behind: known.behind ?? null,
          startedAt: row.status === "running" ? known.startedAt ?? null : null,
          environment: known.environment ?? null,
          persistence: known.persistence ?? null,
          sshHost: known.sshHost ?? null,
          desktop: known.desktop ?? null,
          lspLanguages: known.lspLanguages ?? null
        }
      })
      : parsed
    ctx.dispatch({
      type: "workspaces.loaded",
      actor: "system",
      workspaces,
      ...(repo === undefined ? {} : { repoId: repo })
    })
    return workspaces
  })
  const loadList = (...args: Parameters<typeof loadListEffect>) => runtime.runPromise(loadListEffect(...args)).catch((cause) => {
    if (lifecycle.disposed) return SIGN_OUT_REFUSAL
    throw cause
  })

  /* ---- the settle watch ---- */

  /*
   * Poll one settling workspace until it leaves pending/starting (or is
   * gone). A failed poll is not a fact — the watch simply tries again; a 404
   * IS a fact, and the honest answer is to re-read the repository's list.
   */
  const poll = (workspaceId: string, current: () => boolean) => Effect.gen(function*() {
    const row = ctx.store.collections.cloudWorkspaces.get(workspaceId)
    if (row === undefined || !current()) return false
    const answer = yield* read(repoPath(row.repoId, `/workspaces/${encodeURIComponent(workspaceId)}`))
    if (!current()) return false
    if (answer.status === 404) {
      yield* loadListEffect(row.repoId, current)
      return false
    }
    if (!("error" in answer)) {
      const parsed = parseWorkspaceWire(answer.body, row.repoId)
      if (parsed !== null) {
        ctx.dispatch({ type: "workspace.updated", actor: "system", workspace: parsed })
        if (!UNSETTLED.has(parsed.status)) return false
      }
    }
    return true
  }).pipe(
    Effect.repeat({ times: MAX_WATCH_POLLS - 1, while: (pending) => pending, schedule: Schedule.spaced(pollMs) }),
    Effect.asVoid
  )

  const watch = (workspaceId: string): void => {
    if (lifecycle.disposed) return
    runtime.runFork(FiberMap.run(watching, workspaceId, poll(workspaceId, currentOperation(workspaceId)), { onlyIfMissing: true }))
  }

  /* ---- the acts ---- */

  const refreshWorkspaces: WorkspaceSeam["refreshWorkspaces"] = async (repo) => {
    const session = ctx.store.collections.cloudSessions.get("cloud")
    if (session?.state !== "signed-in") return
    const loaded = await loadList(repo === undefined || repo === "" ? undefined : repo)
    return typeof loaded === "string" ? loaded : undefined
  }

  const listWorkspaces: WorkspaceSeam["listWorkspaces"] = async (repo) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const target = repo === undefined || repo === "" ? undefined : resolveTargetRepo(ctx.store, repo)
    if (target !== undefined && "error" in target) return target.error
    const scope = target !== undefined && "repo" in target ? target.repo : undefined
    const loaded = await loadList(scope)
    if (typeof loaded === "string") return loaded
    const listing = loaded.length === 0
      ? scope === undefined
        ? "No cloud workspaces."
        : `No cloud workspaces on ${scope}.`
      : loaded
        .map((workspace) =>
          `${workspace.name} (${workspace.id}) · ${workspace.status} · ${workspace.repoId}${
            workspace.targetBookmark === null ? "" : `@${workspace.targetBookmark}`
          }`)
        .join("\n")
    ctx.dispatch({ type: "message.appended", actor: "system", text: listing })
    return { value: listing }
  }

  const openWorkspace: WorkspaceSeam["openWorkspace"] = async (bookmark, repo, kind) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const accountCurrent = currentOperation()
    const target = resolveTargetRepo(ctx.store, repo)
    if ("error" in target) return target.error
    /*
     * The source bookmark: the explicit one, else the repository's head
     * bookmark (the same default the create route applies). An unnamed
     * source is omitted, never invented.
     */
    const repoRow = ctx.store.collections.repositories.get(target.repo)
    const source = bookmark === undefined || bookmark === "" ? repoRow?.head?.bookmark ?? undefined : bookmark
    /*
     * ADR 0002: three sandbox kinds share one option surface and the kind IS
     * the choice. A call that named one sends it; a call that named none
     * sends none, so plue's own default (`container`) applies rather than the
     * app asserting a kind the human never picked. There is no environment or
     * image field — that default stands.
     */
    const created = await sendJson("POST", repoPath(target.repo, "/workspaces"), {
      ...(source === undefined ? {} : { source_bookmark: source }),
      ...(kind === undefined ? {} : { kind })
    })
    /*
     * The code travels in the answer itself: a creation refused for the
     * missing egress proxy names `egress_proxy_unavailable`, exactly, beside
     * the server's own message.
     *
     * The refusal ALSO lands, verbatim, on the card whose create affordance
     * was pressed. That affordance only exists on a FAILED workspace's card
     * (the three-kind row), so the refusal goes to exactly those cards on this
     * repository and nowhere else — a running workspace's card said nothing
     * about this create and must not start now. plue's 409 for a kind whose
     * base image is still registering ("no NixOS environment image is
     * registered for kind desktop") is the honest state of the system, so it
     * reads as plue wrote it.
     */
    if (!accountCurrent()) return SIGN_OUT_REFUSAL
    if ("error" in created) {
      if (created.refusal.rawCode === "plan_limit_exceeded") return renderPlanLimit(ctx.store, created.refusal, ctx.checkout ?? true, ctx.actor())
      for (const row of ctx.store.collections.cloudWorkspaces.values()) {
        if (row.repoId !== target.repo || row.status !== "failed") continue
        if (ctx.store.collections.cards.get(cardIdOf(row.id)) === undefined) continue
        renderWorkspace(row, { error: created.error })
      }
      /* One sentence for every refusal: the code, plue's own words, then whose fault it was. */
      return refusalSentence(created.refusal)
    }
    const workspace = parseWorkspaceWire(created.body, target.repo)
    if (workspace === null) return `Smithers Cloud's answer for the new workspace on ${target.repo} was malformed.`
    ctx.dispatch({ type: "workspace.updated", actor: "system", workspace })
    if (UNSETTLED.has(workspace.status)) watch(workspace.id)
    const [bookmarkHead, snapshots, sessions] = await Promise.all([
      loadBookmarkHead(workspace.repoId, workspace.targetBookmark),
      loadSnapshots(workspace.repoId),
      loadSessions(workspace.repoId, workspace.id)
    ])
    renderWorkspace(workspace, {
      bookmarkHead,
      ...(snapshots === null ? {} : { snapshots }),
      ...(sessions === null ? {} : { sessions })
    })
    return {
      value: `Workspace "${workspace.name}" (${workspace.id}) is ${workspace.status} on ${workspace.repoId}${
        workspace.targetBookmark === null ? "" : `@${workspace.targetBookmark}`
      } — the card tracks it.`
    }
  }

  const viewWorkspace: WorkspaceSeam["viewWorkspace"] = async (workspaceId) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = resolveWorkspace(workspaceId)
    if ("error" in resolved) return resolved.error
    const { workspace } = resolved
    const answer = await getJson(repoPath(workspace.repoId, `/workspaces/${encodeURIComponent(workspace.id)}`))
    if ("error" in answer) return failOnCard(workspace, answer)
    const fresh = parseWorkspaceWire(answer.body, workspace.repoId)
    if (fresh === null) return `Smithers Cloud's answer for workspace ${workspace.id} was malformed.`
    ctx.dispatch({ type: "workspace.updated", actor: "system", workspace: fresh })
    if (UNSETTLED.has(fresh.status)) watch(fresh.id)
    const [bookmarkHead, snapshots, sessions] = await Promise.all([
      loadBookmarkHead(fresh.repoId, fresh.targetBookmark),
      loadSnapshots(fresh.repoId),
      loadSessions(fresh.repoId, fresh.id)
    ])
    renderWorkspace(fresh, {
      bookmarkHead,
      ...(snapshots === null ? {} : { snapshots }),
      ...(sessions === null ? {} : { sessions })
    })
    return { value: `Workspace "${fresh.name}" (${fresh.id}) is ${fresh.status} — the card is current.` }
  }

  /* Suspend and resume share everything but the verb. */
  const transitionWorkspace = async (
    verb: "suspend" | "resume",
    workspaceId?: string
  ): Promise<string | void | { readonly value: string }> => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const accountCurrent = currentOperation()
    const resolved = resolveWorkspace(workspaceId)
    if ("error" in resolved) return resolved.error
    const { workspace } = resolved
    const answer = await sendJson("POST", repoPath(workspace.repoId, `/workspaces/${encodeURIComponent(workspace.id)}/${verb}`))
    if (!accountCurrent()) return SIGN_OUT_REFUSAL
    if ("error" in answer) return failOnCard(workspace, answer)
    /*
     * The act's body is the updated workspace when plue writes one; when it
     * does not, the truth is a re-read, never an assumed status.
     */
    let fresh = parseWorkspaceWire(answer.body, workspace.repoId)
    if (fresh === null) {
      const reread = await getJson(repoPath(workspace.repoId, `/workspaces/${encodeURIComponent(workspace.id)}`))
      if ("error" in reread) {
        await loadList(workspace.repoId)
        return `Workspace "${workspace.name}" (${workspace.id}) ${verb}ed, but its new state could not be read — the list was refreshed.`
      }
      fresh = parseWorkspaceWire(reread.body, workspace.repoId)
      if (fresh === null) {
        await loadList(workspace.repoId)
        return `Workspace "${workspace.name}" (${workspace.id}) ${verb}ed, but its answer was malformed — the list was refreshed.`
      }
    }
    ctx.dispatch({ type: "workspace.updated", actor: "system", workspace: fresh })
    if (UNSETTLED.has(fresh.status)) watch(fresh.id)
    renderWorkspace(fresh)
    return { value: `Workspace "${fresh.name}" (${fresh.id}) is ${fresh.status}.` }
  }

  const forkWorkspace: WorkspaceSeam["forkWorkspace"] = async (workspaceId, name) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const accountCurrent = currentOperation()
    const resolved = resolveWorkspace(workspaceId)
    if ("error" in resolved) return resolved.error
    const { workspace } = resolved
    const forked = await sendJson("POST", repoPath(workspace.repoId, `/workspaces/${encodeURIComponent(workspace.id)}/fork`), {
      name: name ?? ""
    })
    if (!accountCurrent()) return SIGN_OUT_REFUSAL
    if ("error" in forked) return failOnCard(workspace, forked)
    const fork = parseWorkspaceWire(forked.body, workspace.repoId)
    if (fork === null) return `Smithers Cloud's answer for the fork of ${workspace.id} was malformed.`
    ctx.dispatch({ type: "workspace.updated", actor: "system", workspace: fork })
    if (UNSETTLED.has(fork.status)) watch(fork.id)
    renderWorkspace(fork)
    return { value: `Forked "${workspace.name}" into "${fork.name}" (${fork.id}), ${fork.status} — the new card tracks it.` }
  }

  const snapshotWorkspace: WorkspaceSeam["snapshotWorkspace"] = async (workspaceId, name) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = resolveWorkspace(workspaceId)
    if ("error" in resolved) return resolved.error
    const { workspace } = resolved
    const taken = await sendJson("POST", repoPath(workspace.repoId, `/workspaces/${encodeURIComponent(workspace.id)}/snapshot`), {
      name: name ?? ""
    })
    if ("error" in taken) return failOnCard(workspace, taken)
    const snapshot = parseSnapshot(taken.body)
    const snapshots = await loadSnapshots(workspace.repoId)
    renderWorkspace(workspace, snapshots === null
      ? snapshot === null ? {} : { snapshots: [snapshot] }
      : { snapshots })
    return {
      value: snapshot === null
        ? `Snapshot of "${workspace.name}" (${workspace.id}) taken.`
        : `Snapshot "${snapshot.name}" (${snapshot.id}) taken of "${workspace.name}" (${workspace.id}).`
    }
  }

  const deleteSnapshot: WorkspaceSeam["deleteSnapshot"] = async (snapshotId, workspaceId) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = resolveRepo(workspaceId)
    if ("error" in resolved) return resolved.error
    const deleted = await sendJson(
      "DELETE",
      repoPath(resolved.repo, `/workspace-snapshots/${encodeURIComponent(snapshotId)}`)
    )
    if ("error" in deleted) return deleted.error
    const snapshots = await loadSnapshots(resolved.repo)
    for (const row of ctx.store.collections.cloudWorkspaces.values()) {
      if (row.repoId !== resolved.repo) continue
      /*
       * The workspace the act resolved renders (creating its card — the
       * user just acted on it); the others only refresh a card already in
       * the transcript.
       */
      if (row.id !== resolved.workspaceId && ctx.store.collections.cards.get(cardIdOf(row.id)) === undefined) continue
      renderWorkspace(row, snapshots === null ? {} : { snapshots })
    }
    return { value: `Snapshot ${snapshotId} is deleted.` }
  }

  const forkFromSnapshot: WorkspaceSeam["forkFromSnapshot"] = async (snapshotId, workspaceId) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const accountCurrent = currentOperation()
    const resolved = resolveRepo(workspaceId)
    if ("error" in resolved) return resolved.error
    const created = await sendJson("POST", repoPath(resolved.repo, "/workspaces"), { snapshot_id: snapshotId })
    if (!accountCurrent()) return SIGN_OUT_REFUSAL
    if ("error" in created) {
      if (created.refusal.rawCode === "plan_limit_exceeded") return renderPlanLimit(ctx.store, created.refusal, ctx.checkout ?? true, ctx.actor())
      /* One sentence for every refusal: the code, plue's own words, then whose fault it was. */
      return refusalSentence(created.refusal)
    }
    const workspace = parseWorkspaceWire(created.body, resolved.repo)
    if (workspace === null) return `Smithers Cloud's answer for the workspace from snapshot ${snapshotId} was malformed.`
    ctx.dispatch({ type: "workspace.updated", actor: "system", workspace })
    if (UNSETTLED.has(workspace.status)) watch(workspace.id)
    renderWorkspace(workspace)
    return {
      value: `Workspace "${workspace.name}" (${workspace.id}) is ${workspace.status} from snapshot ${snapshotId} — the card tracks it.`
    }
  }

  const templateSnapshot: WorkspaceSeam["templateSnapshot"] = async (snapshotId, name, workspaceId) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = resolveRepo(workspaceId)
    if ("error" in resolved) return resolved.error
    const source = await getJson(repoPath(resolved.repo, `/workspace-snapshots/${encodeURIComponent(snapshotId)}`))
    if ("error" in source) return source.error
    const sourceWorkspaceId = isRecord(source.body) ? textOrNull(source.body.workspace_id) : null
    if (sourceWorkspaceId === null) return `Smithers Cloud's answer for snapshot ${snapshotId} named no workspace.`
    const created = await sendJson("POST", repoPath(resolved.repo, "/workspace-snapshots"), {
      workspace_id: sourceWorkspaceId,
      name
    })
    if ("error" in created) return created.error
    const template = parseSnapshot(created.body)
    const snapshots = await loadSnapshots(resolved.repo)
    for (const row of ctx.store.collections.cloudWorkspaces.values()) {
      if (row.repoId !== resolved.repo) continue
      if (row.id !== resolved.workspaceId && ctx.store.collections.cards.get(cardIdOf(row.id)) === undefined) continue
      renderWorkspace(row, snapshots === null ? {} : { snapshots })
    }
    return {
      value: template === null
        ? `Template "${name}" created from snapshot ${snapshotId}.`
        : `Template "${template.name}" (${template.id}) created from snapshot ${snapshotId}.`
    }
  }

  const listSessions: WorkspaceSeam["listSessions"] = async (workspaceId) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = resolveWorkspace(workspaceId)
    if ("error" in resolved) return resolved.error
    const { workspace } = resolved
    const sessions = await loadSessions(workspace.repoId, workspace.id)
    if (sessions === null) return `The sessions of workspace ${workspace.id} couldn't be read right now.`
    renderWorkspace(workspace, { sessions })
    return {
      value: sessions.length === 0
        ? `Workspace "${workspace.name}" (${workspace.id}) has no sessions.`
        : `Workspace "${workspace.name}" (${workspace.id}) sessions: ${
          sessions.map((session) => `${session.id} (${session.status})`).join(", ")
        }.`
    }
  }

  const destroySession: WorkspaceSeam["destroySession"] = async (sessionId, workspaceId) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = resolveRepo(workspaceId)
    if ("error" in resolved) return resolved.error
    const destroyed = await sendJson(
      "POST",
      repoPath(resolved.repo, `/workspace/sessions/${encodeURIComponent(sessionId)}/destroy`)
    )
    if ("error" in destroyed) return destroyed.error
    /*
     * Destroyed is a fact the tab and the card learn together: the terminal
     * tab attached to the session closes and the card stops pointing at it
     * in one transaction (the facet re-offers to open one rather than claim
     * a dead attachment); the session lists refresh after.
     */
    ctx.dispatch({ type: "workspace.session.destroyed", actor: ctx.actor(), sessionId })
    /* One repository-wide read is the refresh for every card in it. */
    const rows = await loadRepoSessions(resolved.repo)
    for (const card of ctx.store.collections.cards.values()) {
      if (card.kind !== "workspace" || card.payload.repo !== resolved.repo) continue
      const row = ctx.store.collections.cloudWorkspaces.get(card.payload.workspaceId)
      if (row === undefined) continue
      renderWorkspace(row, rows === null ? {} : { sessions: sessionsOf(rows, row.id) })
    }
    return { value: `Session ${sessionId} is destroyed.` }
  }

  const deleteWorkspace: WorkspaceSeam["deleteWorkspace"] = async (workspaceId, confirmName) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = resolveWorkspace(workspaceId)
    if ("error" in resolved) return resolved.error
    const { workspace } = resolved
    /*
     * The typed-name gate lives HERE, not only in the card's chrome: a slash,
     * an agent's confirmed invocation, and the card's button all arrive with
     * the name the invoker typed, and only the workspace's own name deletes.
     */
    if (confirmName.trim() !== workspace.name) {
      return `Deleting "${workspace.name}" (${workspace.id}) needs its name typed back exactly — /workspace.delete ${workspace.id} ${workspace.name}.`
    }
    const deleted = await sendJson("DELETE", repoPath(workspace.repoId, `/workspaces/${encodeURIComponent(workspace.id)}`))
    if ("error" in deleted) return failOnCard(workspace, deleted)
    /*
     * Gone is a fact: the card, the collection row, its tree copy, and its
     * terminal tabs leave in one transaction; the list refresh after it
     * re-reads the repository's truth.
     */
    dropDesktopStream(workspace.id)
    /* Invalidate reads and both session phases before removing the workspace. */
    workspaceEpochs.set(workspace.id, (workspaceEpochs.get(workspace.id) ?? 0) + 1)
    terminalOpenEpochs.set(workspace.id, (terminalOpenEpochs.get(workspace.id) ?? 0) + 1)
    runtime.runFork(FiberMap.remove(watching, workspace.id))
    cancelSleeps(workspace.id)
    /* A retry loop for a computer that no longer exists has nothing to mint. */
    desktopMintEpochs.set(workspace.id, (desktopMintEpochs.get(workspace.id) ?? 0) + 1)
    ctx.dispatch({ type: "workspace.deleted", actor: ctx.actor(), workspaceId: workspace.id })
    const loaded = await loadList(workspace.repoId)
    if (typeof loaded === "string") return loaded
    return { value: `Workspace "${workspace.name}" (${workspace.id}) is deleted.` }
  }

  /*
   * The Files facet at one directory (plue#449). The listing REPLACES what
   * the card held for the old path — a stale listing under a new path would
   * describe a directory that was never read.
   */
  const renderFiles = async (
    workspace: CloudWorkspaceRow,
    path: string,
    facet?: WorkspaceFacet
  ): Promise<string | void> => {
    const files = await loadFiles(workspace.repoId, workspace.id, path)
    if ("error" in files) {
      renderWorkspace(workspace, { ...(facet === undefined ? {} : { facet }), error: files.error })
      return files.error
    }
    renderWorkspace(workspace, { ...(facet === undefined ? {} : { facet }), files, filesPath: path })
  }

  const renderServices = async (workspace: CloudWorkspaceRow, facet?: WorkspaceFacet): Promise<string | void> => {
    const services = await loadServices(workspace.repoId, workspace.id)
    if ("error" in services) {
      renderWorkspace(workspace, { ...(facet === undefined ? {} : { facet }), error: services.error })
      return services.error
    }
    renderWorkspace(workspace, { ...(facet === undefined ? {} : { facet }), services })
  }

  /*
   * One page of the egress audit. A cursor APPENDS (the card's "Load older"
   * walks backwards through plue's keyset); no cursor replaces, so re-opening
   * the facet re-reads the newest page instead of stacking duplicates.
   */
  const renderEgress = async (
    workspace: CloudWorkspaceRow,
    cursor?: string,
    facet?: WorkspaceFacet
  ): Promise<string | void> => {
    const page = await loadEgressPage(ctx, workspaceEgressPath(workspace.repoId, workspace.id), cursor)
    if ("error" in page) {
      renderWorkspace(workspace, { ...(facet === undefined ? {} : { facet }), error: page.error })
      return page.error
    }
    const card = ctx.store.collections.cards.get(cardIdOf(workspace.id))
    const held = card?.kind === "workspace" ? card.payload.egress ?? [] : []
    renderWorkspace(workspace, {
      ...(facet === undefined ? {} : { facet }),
      egress: cursor === undefined || cursor === "" ? page.rows : [...held, ...page.rows],
      egressCursor: page.nextCursor
    })
  }

  const setFacet = preparedView(ctx, (workspaceId: string, facet: WorkspaceFacet) => {
    const row = ctx.store.collections.cloudWorkspaces.get(workspaceId)
    if (row === undefined) return `Workspace ${workspaceId} is not loaded — /workspace.list refreshes the inventory`
    const existing = ctx.store.collections.cards.get(cardIdOf(row.id))
    const path = existing?.kind === "workspace" ? existing.payload.filesPath ?? "" : ""
    const placeholder = workspaceCard(row, { facet })
    return { id: placeholder.id, title: placeholder.title, pane: workspaceId, placeholder,
      key: JSON.stringify([placeholder.id, facet, facet === "files" ? path : undefined]),
      project: card => {
        if (card.kind !== "workspace") return card
        const p = card.payload
        // Preserve current lifecycle and desktop credentials; only the requested facet was prefetched.
        return workspaceCard(row, { facet, ...(facet === "files" ? { files: p.files, filesPath: p.filesPath }
          : facet === "services" ? { services: p.services } : facet === "egress" ? { egress: p.egress, egressCursor: p.egressCursor }
          : facet === "snapshots" ? { snapshots: p.snapshots } : facet === "terminal" ? { sessions: p.sessions.map(session => ({ ...session, kind: session.kind ?? null, language: session.language ?? null })) } : {}) })
      },
      before: async () => {
        if (facet !== "desktop") {
          dropDesktopStream(workspaceId)
          desktopMintEpochs.set(workspaceId, (desktopMintEpochs.get(workspaceId) ?? 0) + 1)
        }
      },
      read: async () => {
        let extra: Partial<CardAux> = { facet }
        if (facet === "snapshots") {
          const snapshots = await loadSnapshots(row.repoId)
          if (snapshots === null) return "Workspace snapshots couldn't be loaded. Try again."
          extra = { facet, snapshots }
        } else if (facet === "terminal") {
          const sessions = await loadSessions(row.repoId, row.id)
          if (sessions === null) return "Workspace sessions couldn't be loaded. Try again."
          extra = { facet, sessions }
        } else if (facet === "files") {
          const files = await loadFiles(row.repoId, row.id, path)
          if ("error" in files) return files.error
          extra = { facet, files, filesPath: path }
        } else if (facet === "services") {
          const services = await loadServices(row.repoId, row.id)
          if ("error" in services) return services.error
          extra = { facet, services }
        } else if (facet === "egress") {
          const page = await loadEgressPage(ctx, workspaceEgressPath(row.repoId, row.id))
          if ("error" in page) return page.error
          extra = { facet, egress: page.rows, egressCursor: page.nextCursor }
        }
        return { card: workspaceCard(row, extra) }
      },
    }
  })

  const listFiles: WorkspaceSeam["listFiles"] = async (path, workspaceId) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = resolveWorkspace(workspaceId)
    if ("error" in resolved) return resolved.error
    const { workspace } = resolved
    // `/` is how a human spells the working copy's root; plue's own spelling is the empty path.
    const at = path === undefined || path === "/" ? "" : path
    const failure = await renderFiles(workspace, at, "files")
    if (typeof failure === "string") return failure
    const card = ctx.store.collections.cards.get(cardIdOf(workspace.id))
    const files = card?.kind === "workspace" ? card.payload.files ?? [] : []
    return {
      value: listingValue(`"${workspace.name}" (${workspace.id})`, at, files.map((file) => ({
        name: file.name,
        kind: file.type === "dir" ? "dir" : "file"
      })))
    }
  }

  const readFile: WorkspaceSeam["readFile"] = async (path, workspaceId) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = resolveWorkspace(workspaceId)
    if ("error" in resolved) return resolved.error
    const { workspace } = resolved
    const answer = await getJson(
      `${workspacePath(workspace.repoId, workspace.id, "/files/content")}?path=${encodeURIComponent(path)}`
    )
    if ("error" in answer) return failOnCard(workspace, answer)
    const body = isRecord(answer.body) ? answer.body : null
    const content = body === null || typeof body.content !== "string" ? null : body.content
    if (content === null) return `Smithers Cloud's answer for ${path} in ${workspace.id} was malformed.`
    /*
     * plue answers `encoding: "base64"` when the bytes are not UTF-8. The
     * file card states that instead of printing them — the same contract the
     * repository file card follows.
     */
    const binary = body?.encoding === "base64"
    const text = binary ? "" : content.slice(0, CARD_CONTENT_CAP)
    const truncated = !binary && (body?.truncated === true || content.length > CARD_CONTENT_CAP)
    const id = `workspace-file-${workspace.id}-${path}`
    const existing = ctx.store.collections.cards.get(id)
    ctx.dispatch({
      type: "card.upsert",
      actor: ctx.actor(),
      card: {
        id,
        kind: "file",
        title: `${path} · ${workspace.name}`,
        status: "active",
        createdAt: existing?.createdAt ?? Date.now(),
        ordinal: existing?.ordinal ?? ctx.nextOrdinal(),
        payload: {
          repo: workspace.repoId,
          path,
          content: text,
          truncated,
          binary,
          /* The address names the computer the bytes came from: this is not the repository's copy. */
          address: `${workspace.repoId} · ${workspace.name} · ${path}`
        }
      }
    })
    return { value: fileValue(`"${workspace.name}" (${workspace.id})`, path, { content: text, truncated, binary }) }
  }

  const listServices: WorkspaceSeam["listServices"] = async (workspaceId) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = resolveWorkspace(workspaceId)
    if ("error" in resolved) return resolved.error
    const { workspace } = resolved
    const failure = await renderServices(workspace, "services")
    if (typeof failure === "string") return failure
    const card = ctx.store.collections.cards.get(cardIdOf(workspace.id))
    const services = card?.kind === "workspace" ? card.payload.services ?? [] : []
    return {
      value: services.length === 0
        ? `"${workspace.name}" (${workspace.id}) declares no services.`
        : `"${workspace.name}" (${workspace.id}) services: ${
          services.map((service) => `${service.name} (${service.state})`).join(", ")
        }.`
    }
  }

  const listEgress: WorkspaceSeam["listEgress"] = async (workspaceId, cursor) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = resolveWorkspace(workspaceId)
    if ("error" in resolved) return resolved.error
    const { workspace } = resolved
    const failure = await renderEgress(workspace, cursor, "egress")
    if (typeof failure === "string") return failure
    const card = ctx.store.collections.cards.get(cardIdOf(workspace.id))
    const rows = card?.kind === "workspace" ? card.payload.egress ?? [] : []
    return {
      value: rows.length === 0
        ? `"${workspace.name}" (${workspace.id}) made no recorded calls.`
        : `${rows.length} recorded call${rows.length === 1 ? "" : "s"} from "${workspace.name}" (${workspace.id}) — the card lists them.`
    }
  }

  /*
   * ---- the desktop (lane L3b) ----
   *
   * POST …/workspaces/{id}/desktop/session answers, once, a token, a VNC
   * password, and an absolute `stream_url` that already carries both. That
   * answer is a live machine's credential: it is handed to
   * `holdDesktopStream` — module memory the facet reads through
   * `useSyncExternalStore` — and NOTHING from it is dispatched. Not the URL,
   * not the token, not the password, not even the session id: everything a
   * card payload holds is written to disk by the persistence backend.
   *
   * plue refuses with 409 when the workspace is not running, 400 when the
   * kind has no desktop, and — plue#496 — 503 `desktop_not_ready` with a
   * `Retry-After` while the guest's NixOS activation finishes. All three read
   * on the facet in the server's own words; the status and the code ride
   * beside them so the 409 — and only the 409 — offers a Resume, and only
   * the 503 the server asked to be retried is retried on its own.
   *
   * The auto-retry is the server's instruction, not this app's optimism: it
   * runs ONLY for `desktop_not_ready`, waits exactly the `Retry-After` the
   * refusal named, gives up after `desktopSessionRetry.maxAttempts`, and
   * leaves plue's own words on the card the whole time. It is superseded by
   * any later mint on the same workspace, and by leaving the facet.
   */
  const mintDesktopSession = async (
    workspaceId: string | undefined,
    verb: "open" | "rotate"
  ): Promise<string | void | { readonly value: string }> => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = resolveWorkspace(workspaceId)
    if ("error" in resolved) return resolved.error
    const { workspace } = resolved
    const epoch = (desktopMintEpochs.get(workspace.id) ?? 0) + 1
    desktopMintEpochs.set(workspace.id, epoch)
    const authorized = currentOperation(workspace.id)
    const current = (): boolean => authorized() && gate() === undefined && desktopMintEpochs.get(workspace.id) === epoch
    let attempt = 0
    for (;;) {
      let response: Response
      try {
        response = await ctx.http(cloud(workspacePath(workspace.repoId, workspace.id, "/desktop/session")), {
          method: "POST"
        })
      } catch (error) {
        if (!current()) return
        /* Nothing answered, so nothing judged the request: infra, and the card says so rather than a bare sentence. */
        const unreachable = cloudUnreachable(error)
        dropDesktopStream(workspace.id)
        renderWorkspace(workspace, {
          facet: "desktop",
          desktopStage: null,
          desktopRefusal: storedRefusal(unreachable.refusal)
        })
        return unreachable.error
      }
      if (!current()) return
      if (!response.ok) {
        const { refusal: sessionRefusal } = await failed(
          response,
          `The desktop session on ${workspace.id} was refused (${response.status}).`
        )
        if (!current()) return
        dropDesktopStream(workspace.id)
        if (sessionRefusal.rawCode === "plan_limit_exceeded") return renderPlanLimit(ctx.store, sessionRefusal, ctx.checkout ?? true, ctx.actor())
        renderWorkspace(workspace, {
          facet: "desktop",
          /* The mint owns the card from here: the one-command open's stage line has done its work. */
          desktopStage: null,
          desktopRefusal: storedRefusal(sessionRefusal)
        })
        attempt += 1
        /*
         * The auto-retry is the SERVER'S instruction and nothing else: only a
         * `wait` fault, only on a pacing it stated (its header, its body, or
         * the registry row for its code). It used to key off the single code
         * `desktop_not_ready`, which meant every other 503 that plue could
         * have asked us to wait on was given up on, and — worse — any code
         * later spelled that way would have been retried without anyone
         * checking whose fault it was. An infra 503 is never retried here: a
         * full fleet does not empty because a client asked thirty more times.
         */
        if (!mayAutoRetry(sessionRefusal) || attempt >= desktopSessionRetry.maxAttempts) {
          return refusalSentence(sessionRefusal)
        }
        if (!await sleep(statedRetryDelayMs(sessionRefusal) ?? desktopSessionRetry.defaultDelayMs, workspace.id)) return
        if (!current()) return
        continue
      }
      const minted = parseDesktopMint(await response.json().catch(() => null), workspace.id)
      if (!current()) return
      if (minted === null) {
        dropDesktopStream(workspace.id)
        return `Smithers Cloud's answer for the desktop session on ${workspace.id} was malformed.`
      }
      holdDesktopStream(minted)
      /* The frame is the streaming state; a stage line beside it would outlive what it described. */
      renderWorkspace(workspace, { facet: "desktop", desktopStage: null })
      /* The line names the workspace and when the session lapses — never the URL that carries the password. */
      return {
        value: `The desktop of "${workspace.name}" (${workspace.id}) is ${
          verb === "rotate" ? "on a new session" : "streaming on the card"
        }${minted.expiresAt === null ? "" : ` until ${minted.expiresAt}`}.`
      }
    }
  }

  /*
   * One workspace status-stream event (RFD-004). Only what the event NAMES is
   * applied: a status-only event moves the status and leaves the head,
   * ahead and behind exactly as the collection knows them, because a stream
   * that stayed quiet about the head has said nothing about it. An event for
   * a workspace nobody loaded, or one naming a status Smithers does not know,
   * changes nothing at all.
   */
  const applyStatusEvent: WorkspaceSeam["applyStatusEvent"] = (workspaceId, event) => {
    const known = ctx.store.collections.cloudWorkspaces.get(workspaceId)
    if (known === undefined || !isRecord(event)) return
    const status = isWorkspaceStatus(event.status) ? event.status : null
    const head = parseHead(event.head)
    const ahead = countOrNull(event.ahead)
    const behind = countOrNull(event.behind)
    /* plue#482: a `failed` event carries the reason; only a failed one does, and only then is it applied. */
    const failureCode = textOrNull(event.failure_code)
    const failureMessage = textOrNull(event.failure_message)
    if (status === null && head === null && ahead === null && behind === null) return
    const workspace: CloudWorkspaceInput = {
      id: known.id,
      repoId: known.repoId,
      name: known.name,
      targetBookmark: known.targetBookmark,
      status: status ?? known.status,
      failureCode: failureCode ?? known.failureCode ?? null,
      failureMessage: failureMessage ?? known.failureMessage ?? null,
      provisioningStage: known.provisioningStage,
      suspendedAt: known.suspendedAt,
      createdAt: known.createdAt,
      kind: known.kind ?? null,
      agentSessionId: known.agentSessionId ?? null,
      head: head ?? known.head ?? null,
      ahead: ahead ?? known.ahead ?? null,
      behind: behind ?? known.behind ?? null,
      startedAt: known.startedAt ?? null,
      environment: known.environment ?? null,
      persistence: known.persistence ?? null,
      sshHost: known.sshHost ?? null,
      desktop: known.desktop ?? null
    }
    ctx.dispatch({ type: "workspace.updated", actor: "system", workspace })
  }

  const openDesktop: WorkspaceSeam["openDesktop"] = (workspaceId) => mintDesktopSession(workspaceId, "open")
  const rotateDesktop: WorkspaceSeam["rotateDesktop"] = (workspaceId) => mintDesktopSession(workspaceId, "rotate")

  /* plue's own words for a box that failed, its code beside them when it recorded one. */
  const boxFailure = (box: CloudWorkspaceInput): string => {
    const message = box.failureMessage ?? `The desktop box ${box.id} failed.`
    return box.failureCode == null ? message : `${box.failureCode} — ${message}`
  }

  /*
   * ---- `/desktop`: the one-command open ----
   *
   * Create-or-reuse, wait, mint — under the ONE confirmation the flow asked
   * for. The three steps are plue's, not this app's invention:
   *
   *  - REUSE is plue's. `POST …/workspaces` is find-or-create per
   *    (repository, user, kind) — the same uniqueness `uq_workspaces_active`
   *    enforces (plue db/migrations/20260902549500). A RUNNING or STARTING
   *    desktop box comes back as it stands; a SUSPENDED one comes back
   *    suspended, so the resume below is the app's part; a FAILED one is not
   *    active, so plue builds a replacement and the app just waits for it.
   *    The app does not scan its own collection for a box to reuse: a stale
   *    row would fight the index rather than agree with it.
   *  - READINESS is plue's: `running` is not enough, the guest's NixOS
   *    activation has to finish, which the DTO says as `desktop.ready`.
   *  - The MINT is `mintDesktopSession`, unchanged: the credential goes to
   *    module memory and never to the card.
   *
   * The wait is BOUNDED (`desktopBoxWait`, ~120 s) and stoppable
   * (`stopDesktopWait`, the card's button). Every refusal reads in plue's own
   * words — a `failed` box says its `failure_message`, the 503 the mint
   * retries says its code and its `Retry-After`.
   */
  const openDesktopBox: WorkspaceSeam["openDesktopBox"] = async (bookmark, repo) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const accountCurrent = currentOperation()
    const target = resolveTargetRepo(ctx.store, repo)
    if ("error" in target) return target.error
    /* The same default `workspace.open` applies: the repository's head bookmark, never an invented one. */
    const repoRow = ctx.store.collections.repositories.get(target.repo)
    const source = bookmark === undefined || bookmark === "" ? repoRow?.head?.bookmark ?? undefined : bookmark
    const created = await sendJson("POST", repoPath(target.repo, "/workspaces"), {
      ...(source === undefined ? {} : { source_bookmark: source }),
      kind: "desktop"
    })
    if (!accountCurrent()) return SIGN_OUT_REFUSAL
    if ("error" in created) {
      if (created.refusal.rawCode === "plan_limit_exceeded") return renderPlanLimit(ctx.store, created.refusal, ctx.checkout ?? true, ctx.actor())
      /* One sentence for every refusal: the code, plue's own words, then whose fault it was. */
      return refusalSentence(created.refusal)
    }
    const opened = parseWorkspaceWire(created.body, target.repo)
    if (opened === null) return `Smithers Cloud's answer for the desktop box on ${target.repo} was malformed.`
    let box: CloudWorkspaceInput = opened
    ctx.dispatch({ type: "workspace.updated", actor: "system", workspace: box })
    /*
     * One wait at a time per box, on the same epoch the mint uses: the card's
     * Stop, a later mint, and leaving the facet all supersede this wait
     * because all three bump it.
     */
    const epoch = (desktopMintEpochs.get(box.id) ?? 0) + 1
    desktopMintEpochs.set(box.id, epoch)
    const authorized = currentOperation(box.id)
    const current = (): boolean => authorized() && gate() === undefined && desktopMintEpochs.get(box.id) === epoch
    renderWorkspace(box, { facet: "desktop", desktopStage: "creating" })
    const [bookmarkHead, snapshots, sessions] = await Promise.all([
      loadBookmarkHead(box.repoId, box.targetBookmark),
      loadSnapshots(box.repoId),
      loadSessions(box.repoId, box.id)
    ])
    if (!current()) return
    renderWorkspace(box, {
      facet: "desktop",
      desktopStage: "creating",
      bookmarkHead,
      ...(snapshots === null ? {} : { snapshots }),
      ...(sessions === null ? {} : { sessions })
    })
    /* A suspended box is plue's reuse answer for one that was put to sleep; waking it is this app's part. */
    if (box.status === "suspended" || box.status === "stopped") {
      renderWorkspace(box, { facet: "desktop", desktopStage: "resuming" })
      const resumed = await sendJson("POST", workspacePath(box.repoId, box.id, "/resume"))
      if (!current()) return
      if ("error" in resumed) {
        renderWorkspace(box, { facet: "desktop", desktopStage: null, error: resumed.error })
        return resumed.error
      }
      const fresh = parseWorkspaceWire(resumed.body, box.repoId)
      if (fresh !== null) {
        box = fresh
        ctx.dispatch({ type: "workspace.updated", actor: "system", workspace: box })
      }
    }
    /*
     * The readiness wait. `running` alone does not stream: plue answers the
     * mint 503 `desktop_not_ready` until the guest finishes activating, and
     * says so on the DTO as `desktop.ready`. A DTO that names no `ready` at
     * all (null) is not a "no" — the mint's own bounded retry is the
     * authority then, so a running box with an unstated readiness goes
     * through rather than burning the wait on a fact plue never asserted.
     */
    for (let attempt = 0;; attempt += 1) {
      const row: CloudWorkspaceInput = ctx.store.collections.cloudWorkspaces.get(box.id) ?? box
      if (row.status === "failed") {
        renderWorkspace(row, { facet: "desktop", desktopStage: null })
        return boxFailure(row)
      }
      if (row.status === "running" && row.desktop?.ready !== false) break
      /* `running` with `desktop.ready: false` is the guest still activating — a different fact from still booting. */
      renderWorkspace(row, { facet: "desktop", desktopStage: row.status === "running" ? "activating" : "starting" })
      if (attempt >= desktopBoxWait.maxAttempts) {
        renderWorkspace(row, { facet: "desktop", desktopStage: null })
        return `The desktop box ${row.id} on ${row.repoId} is still ${row.status} after ${
          Math.round((desktopBoxWait.maxAttempts * desktopBoxWait.pollMs) / 1_000)
        }s — /workspace.view ${row.id} reads its state, /desktop tries again.`
      }
      if (!await sleep(desktopWaitMs, box.id)) return
      if (!current()) return
      const answer = await getJson(workspacePath(box.repoId, box.id, ""))
      if (!current()) return
      if ("error" in answer) continue
      const fresh = parseWorkspaceWire(answer.body, box.repoId)
      if (fresh === null) continue
      box = fresh
      ctx.dispatch({ type: "workspace.updated", actor: "system", workspace: box })
    }
    renderWorkspace(box, { facet: "desktop", desktopStage: "streaming" })
    /*
     * The mint bumps the epoch itself, which ends this wait — by design: from
     * here the mint owns the card, including the `desktop_not_ready` 503 it
     * retries on plue's own `Retry-After`.
     */
    return mintDesktopSession(box.id, "open")
  }

  /*
   * The card's "Stop waiting": bump the epoch and clear the stage. It ends
   * the wait and any `desktop_not_ready` retry riding the same epoch, and
   * touches the box itself not at all — plue keeps building it, and
   * `/workspace.view` reads where it got to.
   */
  const stopDesktopWait: WorkspaceSeam["stopDesktopWait"] = async (workspaceId) => {
    const row = ctx.store.collections.cloudWorkspaces.get(workspaceId)
    if (row === undefined) return `Workspace ${workspaceId} is not loaded — /workspace.list refreshes the inventory`
    desktopMintEpochs.set(workspaceId, (desktopMintEpochs.get(workspaceId) ?? 0) + 1)
    cancelSleeps(workspaceId)
    renderWorkspace(row, { desktopStage: null })
  }

  /*
   * The environment images a repository has built (ADR 0002: the environment
   * is stated, never chosen). A refused listing is the server's own message —
   * an empty catalogue would read as "this repository has built nothing",
   * which is a different fact.
   */
  const listEnvironmentImages: WorkspaceSeam["listEnvironmentImages"] = async (repo) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const target = resolveTargetRepo(ctx.store, repo)
    if ("error" in target) return target.error
    const answer = await getJson(repoPath(target.repo, "/environment-images"))
    if ("error" in answer) return answer.error
    const images = arrayOf(answer.body, "images").flatMap((entry) => {
      const parsed = parseEnvironmentImage(entry)
      return parsed === null ? [] : [parsed]
    })
    const id = `environment-images-${target.repo}`
    const existing = ctx.store.collections.cards.get(id)
    ctx.dispatch({
      type: "card.upsert",
      actor: ctx.actor(),
      card: {
        id,
        kind: "environment-images",
        title: `Environment images · ${target.repo}`,
        status: "active",
        createdAt: existing?.createdAt ?? Date.now(),
        ordinal: existing?.ordinal ?? ctx.nextOrdinal(),
        payload: { repo: target.repo, images }
      }
    })
    return {
      value: images.length === 0
        ? `${target.repo} has built no environment images.`
        : `${images.length} environment image${images.length === 1 ? "" : "s"} on ${target.repo} — the card lists them.`
    }
  }

  /* One terminal-open loop per workspace: a later open supersedes the one before it. */

  const openTerminal: WorkspaceSeam["openTerminal"] = async (workspaceId) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = resolveWorkspace(workspaceId)
    if ("error" in resolved) return resolved.error
    const { workspace } = resolved
    if (workspace.status !== "running") {
      return failOnCard(
        workspace,
        `"${workspace.name}" (${workspace.id}) is ${workspace.status}, not running — ${
          workspace.status === "suspended" || workspace.status === "stopped"
            ? "/workspace.resume it first"
            : "wait for it to settle (the card tracks it)"
        }.`
      )
    }
    const epoch = (terminalOpenEpochs.get(workspace.id) ?? 0) + 1
    terminalOpenEpochs.set(workspace.id, epoch)
    const authorized = currentOperation(workspace.id)
    const current = (): boolean => authorized() && gate() === undefined && terminalOpenEpochs.get(workspace.id) === epoch
    const card = ctx.store.collections.cards.get(cardIdOf(workspace.id))
    const attached = card?.kind === "workspace" ? card.payload.terminalSessionId : undefined
    const openTab = (sessionId: string): void => {
      const existing = ctx.store.collections.tabs.get(sessionId)
      if (existing !== undefined) {
        ctx.dispatch({ type: "tab.selected", actor: ctx.actor(), id: existing.id })
        return
      }
      ctx.dispatch({
        type: "tab.opened",
        actor: ctx.actor(),
        tab: {
          id: sessionId,
          kind: "terminal",
          title: `Terminal · ${workspace.name}`,
          sessionId,
          workspaceId: workspace.id,
          repo: workspace.repoId,
          repoKey: `workspace:${workspace.id}`
        }
      })
    }
    if (attached !== undefined && attached !== "") {
      const session = await getJson(repoPath(workspace.repoId, `/workspace/sessions/${encodeURIComponent(attached)}`))
      if (!current()) return
      const parsed = "error" in session ? null : parseSession(session.body)
      if (parsed !== null && parsed.status === SESSION_LIVE) {
        openTab(attached)
        renderWorkspace(workspace, { facet: "terminal" })
        return { value: `Re-attached to session ${attached} of "${workspace.name}" (${workspace.id}).` }
      }
    }
    /*
     * The session POST, and — plue#504 — the 503 it may answer while a vm or
     * desktop guest finishes its NixOS activation. The auto-retry is the
     * server's instruction, not this app's optimism: it runs ONLY for a `wait`
     * fault (plue's own word for "nothing is wrong, it is not ready yet",
     * which is what `guest_not_ready` is), waits exactly the pacing the
     * refusal stated, gives up after `terminalSessionRetry.maxAttempts`, and
     * leaves plue's own words on the terminal facet the whole time. A later
     * open on the same workspace supersedes it. Every other refusal —
     * user, infra, dependency, bug — is answered once.
     */
    let created: { readonly body: unknown }
    for (let attempt = 1;; attempt += 1) {
      const answer = await sendJson("POST", repoPath(workspace.repoId, "/workspace/sessions"), {
        workspace_id: workspace.id,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS
      })
      if (!current()) return
      if (!("error" in answer)) {
        created = answer
        break
      }
      /* No HTTP answer at all: there is no status or code to render, only the reach failure. */
      if (answer.status === null) return failOnCard(workspace, answer)
      if (answer.refusal.rawCode === "plan_limit_exceeded") return renderPlanLimit(ctx.store, answer.refusal, ctx.checkout ?? true, ctx.actor())
      /* The worker's own credential-boundary refusal keeps the card-level marker it always had. */
      const proxyGone = answer.code === EGRESS_PROXY_UNAVAILABLE
      renderWorkspace(workspace, {
        facet: "terminal",
        ...(proxyGone ? { egressProxyUnavailable: true } : {}),
        terminalRefusal: storedRefusal(answer.refusal)
      })
      if (!mayAutoRetry(answer.refusal) || attempt >= terminalSessionRetry.maxAttempts) {
        return refusalSentence(answer.refusal)
      }
      if (!await sleep(statedRetryDelayMs(answer.refusal) ?? terminalSessionRetry.defaultDelayMs, workspace.id)) return
      if (!current()) return
    }
    const session = parseSession(created.body)
    if (session === null) return `Smithers Cloud's answer for the new session on ${workspace.id} was malformed.`
    /*
     * A fresh session may still be pending: poll it until it runs, or the
     * honest refusal names what it settled as.
     */
    let live = session
    for (let attempt = 0; live.status !== SESSION_LIVE && attempt < SESSION_SETTLE_ATTEMPTS; attempt += 1) {
      if (live.status === "failed" || live.status === "stopped") break
      if (!await sleep(pollMs, workspace.id) || !current()) return
      const answer = await getJson(repoPath(workspace.repoId, `/workspace/sessions/${encodeURIComponent(session.id)}`))
      if (!current()) return
      const parsed = "error" in answer ? null : parseSession(answer.body)
      if (parsed === null) break
      live = parsed
    }
    if (live.status !== SESSION_LIVE) {
      return failOnCard(workspace, `Session ${live.id} of "${workspace.name}" settled as ${live.status}, not running.`)
    }
    const sessions = await loadSessions(workspace.repoId, workspace.id)
    if (!current()) return
    openTab(live.id)
    renderWorkspace(workspace, {
      facet: "terminal",
      terminalSessionId: live.id,
      ...(sessions === null ? {} : { sessions })
    })
    /* A refusal belongs to the act that just ran; this render already dropped it. */
    return { value: `Terminal open on session ${live.id} of "${workspace.name}" (${workspace.id}).` }
  }

  return {
    listWorkspaces,
    refreshWorkspaces,
    openWorkspace,
    viewWorkspace,
    openTerminal,
    suspendWorkspace: (workspaceId) => transitionWorkspace("suspend", workspaceId),
    resumeWorkspace: (workspaceId) => transitionWorkspace("resume", workspaceId),
    forkWorkspace,
    snapshotWorkspace,
    deleteSnapshot,
    forkFromSnapshot,
    templateSnapshot,
    listSessions,
    destroySession,
    deleteWorkspace,
    setFacet,
    listFiles,
    readFile,
    listServices,
    listEgress,
    openDesktop,
    rotateDesktop,
    openDesktopBox,
    stopDesktopWait,
    listEnvironmentImages,
    applyStatusEvent,
    dispose
  }
}
