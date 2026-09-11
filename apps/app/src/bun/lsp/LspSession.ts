/*
 * One language server for one (repository, language) (code-intel PLAN.md
 * §3): spawn, `initialize`, documents synced from DISK text, hover,
 * definition, diagnostics, and a clean shutdown. Positions are 1-based on
 * the wire and in flows; this module converts once, in both directions.
 * Every path goes through the files seam's rule (RepoFiles.ts): plain
 * segments under the root, real path inside it, bounded read. The server
 * publishes diagnostics for the files it was asked about; each publication
 * goes out as one `lsp.diagnostics` frame on `lsp:<repoId>`.
 *
 * What leaves this module is bounded and names no host path: every answer
 * carries the digest of the text the server saw (so a card showing older
 * text is not annotated as if it were this one), every cap says it cut
 * (`total`, `omitted`, `truncated`), and the free text the server writes —
 * hover markdown, diagnostic messages, its last words on stderr — has the
 * host's absolute paths made repository-relative, or cut to their last
 * segment when they point outside it. The boundary is the path, not the
 * type: a symbol imported from outside the repository still hovers as the
 * type the server computed for it, because that is the truth about the code
 * the card shows.
 */
import { createHash } from "node:crypto"
import { basename, join, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { LSP_DIAGNOSTICS_CAP, LSP_LOCATIONS_CAP, LSP_REQUEST_TIMEOUT_MS, lspTopic } from "@smthrs/rpc/LocalApp"
import type {
  LspDefinitionResponse,
  LspDiagnosticsMessage,
  LspDiagnosticsResponse,
  LspHoverResponse,
  LspLocation
} from "@smthrs/rpc/LocalApp"
import { hoverContents, LSP_CLIENT_CAPABILITIES, redactHostPaths, toDiagnostic, toWireRange } from "@smthrs/rpc/LspWire"
import type { LspDiagnosticWire, LspHoverWire, LspLocationLinkWire, LspLocationWire } from "@smthrs/rpc/LspWire"
import { readRepoPath } from "../RepoFiles"
import { createJsonRpc, JsonRpcError } from "./JsonRpc"
import type { JsonRpc } from "./JsonRpc"
import type { LanguageId, ServerSpec } from "./LanguageServers"

export type LspSessionState = "starting" | "ready" | "exited"
export const LSP_STARTUP_TIMEOUT_MS = 15_000

/** A 1-based position as the wire carries it. */
export interface WirePosition {
  readonly line: number
  readonly character: number
}

export type LspRequestErrorCode =
  | "invalid_path"
  | "path_outside_repository"
  | "path_not_found"
  | "read_failed"
  | "file_too_large"
  | "language_server_busy"
  | "language_server_timeout"
  | "language_server_failed"

/** A refused request, with the HTTP status the route answers it with. */
export class LspRequestError extends Error {
  constructor(readonly code: LspRequestErrorCode, readonly http: number, message: string) {
    super(message)
    this.name = "LspRequestError"
  }
}

export interface LspSessionOptions {
  readonly repoId: string
  /** The repository's real path; the server's one workspace folder and its cwd. */
  readonly repoRoot: string
  readonly spec: ServerSpec
  /** The full argv, sandbox wrapper included. */
  readonly argv: ReadonlyArray<string>
  readonly env: Record<string, string>
  readonly publish: (topic: string, message: unknown) => void
  readonly requestTimeoutMs?: number
  /** Initialization and the shared first project-load window; steady requests keep their shorter bound. */
  readonly startupTimeoutMs?: number
  /** Requests in flight per server; default 8. */
  readonly maxInFlight?: number
  /** Grace between the LSP `exit` and SIGKILL. */
  readonly killGraceMs?: number
  /** Every request passes through here (the host's idle clock). */
  readonly onTouch?: () => void
  readonly onExit?: (code: number | null) => void
  readonly log: (line: string) => void
}

export interface LspSession {
  readonly repoId: string
  readonly language: LanguageId
  readonly state: LspSessionState
  readonly pid: number
  /** Milliseconds since the epoch of the last request. */
  readonly lastUsed: number
  /** Settles when `initialize` answered; rejects when the server left first. */
  readonly ready: Promise<void>
  /** The child's exit code, once it exits. */
  readonly exited: Promise<number | null>
  /** Requests started and not yet answered; the host's idle clock never fires past one. */
  readonly inFlight: number
  hover(path: string, position: WirePosition): Promise<LspHoverResponse>
  definition(path: string, position: WirePosition): Promise<LspDefinitionResponse>
  /**
   * The server's publication for the file: the last one when the file is
   * unchanged since it arrived, otherwise the next one within `waitMs`.
   * `items` is null when none arrived in time.
   */
  diagnostics(path: string, waitMs: number): Promise<LspDiagnosticsResponse>
  touch(): void
  /** LSP `shutdown` then `exit`, SIGKILL after the grace; idempotent. */
  shutdown(): Promise<void>
}

/*
 * The wire shapes and their one conversion live in @smthrs/rpc/LspWire, shared
 * with the renderer's cloud client (CloudLspClient.ts); the host's own
 * redaction root is the repository's real path.
 */
export { hoverContents, redactHostPaths, toDiagnostic, toWireRange } from "@smthrs/rpc/LspWire"

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

/** RepoFilesResponse.digest for text the route did not stamp (a peer without the field). */
const digestOf = (text: string): string => createHash("sha256").update(text).digest("hex")

interface OpenDocument {
  readonly relative: string
  readonly uri: string
  version: number
  text: string
  /** The digest of `text` as the files route stamps it; every answer about this document names it. */
  digest: string
  /** The last publication for this document, or null before the first. */
  latest: LspDiagnosticsResponse | null
  /** True from an open or change until the server publishes for it. */
  awaitingPublication: boolean
  waiters: Array<(response: LspDiagnosticsResponse) => void>
}

export const createLspSession = (options: LspSessionOptions): LspSession => {
  const { repoId, repoRoot, spec, publish, log } = options
  const requestTimeoutMs = options.requestTimeoutMs ?? LSP_REQUEST_TIMEOUT_MS
  const startupTimeoutMs = options.startupTimeoutMs ?? LSP_STARTUP_TIMEOUT_MS
  const killGraceMs = options.killGraceMs ?? 2000
  const documents = new Map<string, OpenDocument>()
  let state: LspSessionState = "starting"
  let lastUsed = Date.now()
  let inFlight = 0
  let stderrTail = ""
  const redact = (text: string): string => redactHostPaths(text, repoRoot)

  const proc = Bun.spawn([...options.argv], {
    cwd: repoRoot,
    env: options.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe"
  })

  void (async () => {
    const decoder = new TextDecoder()
    const reader = proc.stderr.getReader()
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      stderrTail = (stderrTail + decoder.decode(value, { stream: true })).slice(-2048)
    }
  })().catch(() => {})

  /** A file URI the server named, as a repository-relative path; null outside the root. */
  const relativeOf = (uri: string): string | null => {
    let path: string
    try {
      path = fileURLToPath(uri)
    } catch {
      return null
    }
    if (!path.startsWith(`${repoRoot}${sep}`)) return null
    return path.slice(repoRoot.length + 1).split(sep).join("/")
  }

  const onPublishDiagnostics = (params: unknown): void => {
    if (!isRecord(params) || typeof params.uri !== "string" || !Array.isArray(params.diagnostics)) return
    const relative = relativeOf(params.uri)
    if (relative === null) return
    // A publication for a file this session never opened has no card and no digest to name: it stays with the server.
    const document = documents.get(relative)
    if (document === undefined) return
    const version = typeof params.version === "number" && Number.isInteger(params.version) && params.version >= 0 ? params.version : null
    // An older publication must not acquire the current text's digest or settle its waiters.
    if (version !== null && version !== document.version) return
    const wire = params.diagnostics as ReadonlyArray<LspDiagnosticWire>
    const items = wire.slice(0, LSP_DIAGNOSTICS_CAP).map((item) => toDiagnostic(item, redact))
    const response: LspDiagnosticsResponse = { path: relative, version, items, total: wire.length, digest: document.digest }
    document.latest = response
    document.awaitingPublication = false
    const waiters = document.waiters
    document.waiters = []
    for (const waiter of waiters) waiter(response)
    const frame: LspDiagnosticsMessage = { type: "lsp.diagnostics", repoId, path: relative, version, items, total: wire.length, digest: document.digest }
    publish(lspTopic(repoId), frame)
  }

  const rpc: JsonRpc = createJsonRpc(proc, {
    maxInFlight: options.maxInFlight ?? 8,
    log,
    onNotification: (method, params) => {
      if (method === "textDocument/publishDiagnostics") onPublishDiagnostics(params)
      else if (method === "window/logMessage" && isRecord(params) && params.type === 1) {
        log(`lsp ${repoId}/${spec.id}: ${String(params.message)}`)
      }
    },
    onRequest: (method, params) => {
      // The server asks for settings per document; we have none, and null keeps its defaults.
      if (method === "workspace/configuration" && isRecord(params) && Array.isArray(params.items)) {
        return params.items.map(() => null)
      }
      return null
    }
  })

  const rootUri = pathToFileURL(repoRoot).href
  const ready: Promise<void> = rpc
    .request<unknown>("initialize", {
      processId: process.pid,
      clientInfo: { name: "smithers" },
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: basename(repoRoot) }],
      capabilities: LSP_CLIENT_CAPABILITIES,
      ...(spec.initializationOptions === undefined ? {} : { initializationOptions: spec.initializationOptions })
    }, startupTimeoutMs)
    .then(() => {
      rpc.notify("initialized", {})
      if (state === "starting") state = "ready"
    })
  ready.catch((error: unknown) => {
    log(`lsp ${repoId}/${spec.id}: initialize failed: ${error instanceof Error ? error.message : String(error)}`)
  })

  const exited: Promise<number | null> = proc.exited.then((code) => {
    state = "exited"
    rpc.close()
    const exitCode = typeof code === "number" ? code : null
    for (const document of documents.values()) {
      const waiters = document.waiters
      document.waiters = []
      for (const waiter of waiters) waiter({ path: document.relative, version: null, items: null, total: null, digest: document.digest })
    }
    log(`lsp ${repoId}/${spec.id}: exited ${String(code)}`)
    options.onExit?.(exitCode)
    return exitCode
  })

  const touch = (): void => {
    lastUsed = Date.now()
    options.onTouch?.()
  }

  /** The request's failure as the route's refusal. */
  const refused = (error: unknown): LspRequestError => {
    if (error instanceof LspRequestError) return error
    if (error instanceof JsonRpcError) {
      switch (error.kind) {
        case "timeout":
          return new LspRequestError("language_server_timeout", 504, error.message)
        case "busy":
          return new LspRequestError("language_server_busy", 429, error.message)
        case "closed":
          return new LspRequestError(
            "language_server_failed",
            502,
            stderrTail.trim() === ""
              ? `The ${spec.displayName} language server exited.`
              : `The ${spec.displayName} language server exited: ${redact(stderrTail.trim().split("\n").at(-1) ?? "")}`
          )
        case "response":
          return new LspRequestError("language_server_failed", 502, error.message)
      }
    }
    return new LspRequestError("language_server_failed", 502, error instanceof Error ? error.message : String(error))
  }

  /**
   * The document as the server should see it: opened from disk on first
   * use, re-sent in full when the disk text changed since.
   */
  const sync = async (path: string): Promise<OpenDocument> => {
    const read = await readRepoPath(repoRoot, path)
    if (read.status === "error") throw new LspRequestError(read.code, read.http, read.message)
    if (read.body.kind !== "file") throw new LspRequestError("path_not_found", 404, `${read.body.path === "" ? "/" : read.body.path} is a directory.`)
    if (read.body.binary) throw new LspRequestError("invalid_path", 400, `${read.body.path} is binary.`)
    if (read.body.truncated) {
      throw new LspRequestError("file_too_large", 413, `${read.body.path} is larger than the language server read cap.`)
    }
    const relative = read.body.path
    const digest = read.body.digest ?? digestOf(read.body.content)
    const existing = documents.get(relative)
    if (existing === undefined) {
      const document: OpenDocument = {
        relative,
        uri: pathToFileURL(join(repoRoot, ...relative.split("/"))).href,
        version: 1,
        text: read.body.content,
        digest,
        latest: null,
        awaitingPublication: true,
        waiters: []
      }
      documents.set(relative, document)
      rpc.notify("textDocument/didOpen", {
        textDocument: { uri: document.uri, languageId: spec.documentLanguageId(relative), version: 1, text: document.text }
      })
      return document
    }
    if (existing.text !== read.body.content) {
      existing.version += 1
      existing.text = read.body.content
      existing.digest = digest
      existing.awaitingPublication = true
      rpc.notify("textDocument/didChange", {
        textDocument: { uri: existing.uri, version: existing.version },
        contentChanges: [{ text: existing.text }]
      })
    }
    return existing
  }

  /*
   * The idle clock counts from the last activity: a request touches on entry
   * and on exit, and counts itself in flight in between so the host never
   * retires a server mid-answer (a first request carries the project load).
   */
  let projectLoaded = false
  let projectLoadDeadline: number | undefined
  const positioned = async <T>(path: string, position: WirePosition, method: string): Promise<{ readonly answer: T; readonly document: Readonly<Pick<OpenDocument, "digest" | "version">> }> => {
    touch()
    inFlight += 1
    try {
      await ready
      const document = await sync(path)
      // Initialize does not load tsserver's project. Concurrent first queries
      // share one bounded cold-load window, then every query returns to 5 s.
      if (!projectLoaded) projectLoadDeadline ??= Date.now() + startupTimeoutMs
      const coldRemaining = (projectLoadDeadline ?? 0) - Date.now()
      const timeout = !projectLoaded && coldRemaining > 0 ? coldRemaining : requestTimeoutMs
      // Another query can sync an edit while this RPC is pending. Stamp the
      // answer with the document revision sent with this query.
      const snapshot = { digest: document.digest, version: document.version }
      const answer = await rpc.request<T>(method, {
        textDocument: { uri: document.uri },
        position: { line: position.line - 1, character: position.character - 1 }
      }, timeout)
      projectLoaded = true
      return { answer, document: snapshot }
    } catch (error) {
      throw refused(error)
    } finally {
      inFlight -= 1
      touch()
    }
  }

  const hover: LspSession["hover"] = async (path, position) => {
    const { answer, document } = await positioned<LspHoverWire | null>(path, position, "textDocument/hover")
    if (answer === null || !isRecord(answer) || answer.contents === undefined) return { hover: null, digest: document.digest }
    const { contents, truncated } = hoverContents(answer.contents, redact)
    if (contents.trim() === "") return { hover: null, digest: document.digest }
    return { hover: { contents, truncated, ...(answer.range === undefined ? {} : { range: toWireRange(answer.range) }) }, digest: document.digest }
  }

  const definition: LspSession["definition"] = async (path, position) => {
    const { answer, document } = await positioned<LspLocationWire | ReadonlyArray<LspLocationWire | LspLocationLinkWire> | null>(
      path,
      position,
      "textDocument/definition"
    )
    const list = answer === null ? [] : Array.isArray(answer) ? answer : [answer as LspLocationWire]
    const locations: Array<LspLocation> = []
    let omitted = 0
    for (const entry of list) {
      const uri = "targetUri" in entry ? entry.targetUri : entry.uri
      const range = "targetUri" in entry ? entry.targetSelectionRange ?? entry.targetRange : entry.range
      const relative = relativeOf(uri)
      // A target outside the repository (a linked package, a lib.d.ts) is not a file card the renderer can open; it is counted, never invented away.
      if (relative === null) {
        omitted += 1
        continue
      }
      if (locations.length < LSP_LOCATIONS_CAP) locations.push({ path: relative, ...toWireRange(range) })
    }
    return { locations, total: list.length, omitted, digest: document.digest }
  }

  const diagnostics: LspSession["diagnostics"] = async (path, waitMs) => {
    touch()
    inFlight += 1
    try {
      let document: OpenDocument
      try {
        await ready
        document = await sync(path)
      } catch (error) {
        throw refused(error)
      }
      if (!document.awaitingPublication && document.latest !== null) return document.latest
      return await new Promise<LspDiagnosticsResponse>((resolve) => {
        const timer = setTimeout(() => {
          document.waiters = document.waiters.filter((waiter) => waiter !== settle)
          resolve({ path: document.relative, version: null, items: null, total: null, digest: document.digest })
        }, waitMs)
        const settle = (response: LspDiagnosticsResponse): void => {
          clearTimeout(timer)
          resolve(response)
        }
        document.waiters.push(settle)
      })
    } finally {
      inFlight -= 1
      touch()
    }
  }

  let shutdownPromise: Promise<void> | undefined
  const shutdown: LspSession["shutdown"] = () =>
    shutdownPromise ??= (async () => {
      if (state === "exited") return
      try {
        await rpc.request("shutdown", null, Math.min(requestTimeoutMs, 2000))
      } catch {
        // A server that cannot answer shutdown still gets exit, then the signal.
      }
      rpc.notify("exit", null)
      const left = await Promise.race([exited.then(() => true), Bun.sleep(killGraceMs).then(() => false)])
      if (!left) {
        try {
          proc.kill("SIGKILL")
        } catch {
          // Already gone.
        }
        await Promise.race([exited, Bun.sleep(1000)])
      }
      rpc.close()
    })()

  return {
    repoId,
    language: spec.id,
    get state() {
      return state
    },
    pid: proc.pid,
    get lastUsed() {
      return lastUsed
    },
    get inFlight() {
      return inFlight
    },
    ready,
    exited,
    hover,
    definition,
    diagnostics,
    touch,
    shutdown
  }
}
