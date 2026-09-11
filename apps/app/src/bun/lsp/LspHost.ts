/*
 * The language-server host (code-intel PLAN.md §3 "Native"): one session per
 * (repository, language), spawned on first use under the `lsp` seatbelt
 * policy with an environment of its own (`lspChildEnv`: HOME, PATH, scratch,
 * locale and zone — none of the PTYs' credentials, which a language server
 * has no use for), retired after ten idle minutes with no request in flight,
 * with the repository (`POST /api/repo/close`) and with the server (`stop`).
 * At most four servers run; the least recently used one makes room. A
 * missing binary is answered with its install line and never installed.
 */
import { readdirSync, realpathSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import type { LspServerStatus } from "@smthrs/rpc/LocalApp"
import type { NodeSidecar } from "../Node"
import { binDirOf, childEnv } from "../Pty"
import { lspPolicy, wrapSandbox } from "../Sandbox"
import type { SandboxHost } from "../Sandbox"
import { languageFor, resolveServer, serverFor } from "./LanguageServers"
import type { LanguageId, ServerLookup } from "./LanguageServers"
import { createLspSession, LspRequestError } from "./LspSession"
import type { LspSession } from "./LspSession"

export const LSP_MAX_SERVERS = 4
export const LSP_IDLE_MS = 10 * 60 * 1000

/**
 * What a language server's environment carries. The PTYs' allowlist
 * (Pty.ts ENV_ALLOWLIST) hands a harness its provider keys, SSH agent and
 * config dirs because a harness acts on the user's behalf; a language server
 * reads the repository and answers questions, and the lsp policy denies it
 * the network, so it gets none of them.
 */
export const LSP_ENV_KEYS = ["HOME", "PATH", "TMPDIR", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ"] as const

/** The child environment for a language server: the PTYs' PATH assembly, the keys above and nothing else. */
export const lspChildEnv = (
  source: Readonly<Record<string, string | undefined>>,
  home: string,
  pathPrepend: ReadonlyArray<string>
): Record<string, string> => {
  const full = childEnv(source, home, pathPrepend)
  const env: Record<string, string> = {}
  for (const key of LSP_ENV_KEYS) {
    const value = full[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

export interface LspHostOptions {
  /** `lsp:<repoId>` frames go out through here (the server's publish). */
  readonly publish: (topic: string, message: unknown) => void
  readonly node: Promise<NodeSidecar | null>
  readonly home: string
  readonly sandbox: SandboxHost
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly tmpdir?: string
  /** Where binaries are looked up; default this process's filesystem and environment. */
  readonly lookup?: ServerLookup
  readonly maxServers?: number
  readonly idleMs?: number
  readonly requestTimeoutMs?: number
  readonly startupTimeoutMs?: number
  readonly killGraceMs?: number
  readonly log?: (line: string) => void
}

export type LspSessionResult =
  | { readonly status: "ok"; readonly session: LspSession }
  /** No binary for the language on this machine; `install` is the line to run. */
  | { readonly status: "missing"; readonly language: LanguageId; readonly install: string }
  /** No row in the registry handles the file. */
  | { readonly status: "unsupported" }

export interface LspHost {
  /** The live session for the file's language in the repository, started when absent. */
  session(repoId: string, repoRoot: string, path: string): Promise<LspSessionResult>
  list(): ReadonlyArray<LspServerStatus>
  closeRepo(repoId: string): Promise<void>
  killAll(): Promise<void>
}

const safeRealpath = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** This process's filesystem and environment, the way Harnesses.ts reads them. */
export const defaultServerLookup = (env: Readonly<Record<string, string | undefined>> = Bun.env, home?: string): ServerLookup => ({
  env,
  home: home ?? env.HOME ?? tmpdir(),
  listDir: (dir) => {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  },
  isFile: (path) => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  },
  realpath: safeRealpath
})

interface Live {
  readonly key: string
  readonly repoId: string
  readonly session: LspSession
  timer: ReturnType<typeof setTimeout> | undefined
  retiring: Promise<void> | undefined
}

export const createLspHost = (options: LspHostOptions): LspHost => {
  const log = options.log ?? ((line: string) => console.error(line))
  const env = options.env ?? Bun.env
  const scratch = options.tmpdir ?? safeRealpath(tmpdir())
  const lookup = options.lookup ?? defaultServerLookup(env, options.home)
  const maxServers = options.maxServers ?? LSP_MAX_SERVERS
  const idleMs = options.idleMs ?? LSP_IDLE_MS
  const live = new Map<string, Live>()
  const pending = new Set<{
    readonly repoId: string
    readonly cancel: () => void
    readonly settled: Promise<void>
  }>()
  const closingRepos = new Map<string, Promise<void>>()
  let stopping = false
  const closedError = () => new LspRequestError("language_server_failed", 503, "Language server acquisition cancelled: repository closed or host stopping.")
  const keyOf = (repoId: string, language: LanguageId): string => `${repoId}\n${language}`

  const retire = (entry: Live, reason: string): Promise<void> => {
    if (entry.retiring !== undefined) return entry.retiring
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.timer = undefined
    if (entry.session.state !== "exited") log(`lsp ${entry.repoId}/${entry.session.language}: shutting down (${reason})`)
    // Keep the process owned while shutdown is in flight: closeRepo/killAll
    // must still await it, and a replacement must not overlap its lifetime.
    entry.retiring = entry.session.shutdown().finally(() => {
      if (live.get(entry.key) === entry) live.delete(entry.key)
    })
    return entry.retiring
  }

  const arm = (entry: Live): void => {
    if (entry.retiring !== undefined) return
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      // A request still running (the first one carries tsserver's project load) is activity: the clock restarts behind it.
      if (entry.session.inFlight > 0) {
        arm(entry)
        return
      }
      void retire(entry, "idle")
    }, idleMs)
    entry.timer.unref()
  }

  const start = (repoId: string, repoRoot: string, language: LanguageId, argv: ReadonlyArray<string>, node: NodeSidecar | null): Live => {
    const key = keyOf(repoId, language)
    const spec = serverFor(language)
    const wrapped = wrapSandbox(argv, lspPolicy({ tmpdir: scratch }), options.sandbox)
    const entry: Live = {
      key,
      repoId,
      timer: undefined,
      retiring: undefined,
      session: createLspSession({
        repoId,
        repoRoot,
        spec,
        argv: wrapped.argv,
        env: lspChildEnv(env, options.home, binDirOf(node?.path)),
        publish: options.publish,
        ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
        ...(options.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: options.startupTimeoutMs }),
        ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
        onTouch: () => {
          if (live.get(key) === entry) arm(entry)
        },
        onExit: () => {
          if (live.get(key) === entry) live.delete(key)
          if (entry.timer !== undefined) clearTimeout(entry.timer)
        },
        log
      })
    }
    live.set(key, entry)
    arm(entry)
    log(`lsp ${repoId}/${language}: pid ${entry.session.pid} in ${repoRoot} (sandbox ${wrapped.enforced ? "on" : "off"})`)
    // A server that never initializes is retired so the next request starts a fresh one.
    entry.session.ready.catch(() => void retire(entry, "did not initialize"))
    return entry
  }

  const session: LspHost["session"] = async (repoId, repoRoot, path) => {
    if (stopping || closingRepos.has(repoId)) throw closedError()
    const cancelled = Promise.withResolvers<never>()
    const settled = Promise.withResolvers<void>()
    let stale = false
    const acquisition = {
      repoId,
      cancel: () => { stale = true; cancelled.reject(closedError()) },
      settled: settled.promise
    }
    pending.add(acquisition)
    // Cancellation settles the caller even if discovery never resolves. The
    // token survives retries, and every resumed continuation checks it before
    // it can return a session or spawn a process.
    const wait = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, cancelled.promise])
    const acquire = async (): Promise<LspSessionResult> => {
      if (stale) throw closedError()
      const language = languageFor(path)
      if (language === null) return { status: "unsupported" }
      const key = keyOf(repoId, language)
      const existing = live.get(key)
      if (existing?.retiring !== undefined) {
        await wait(existing.retiring)
        return acquire()
      }
      if (existing !== undefined && existing.session.state !== "exited") return { status: "ok", session: existing.session }
      const root = safeRealpath(repoRoot)
      const node = await wait(options.node)
      if (stale) throw closedError()
      // The await above is the one window a second caller could open the same key in.
      const raced = live.get(key)
      if (raced?.retiring !== undefined) {
        await wait(raced.retiring)
        return acquire()
      }
      if (raced !== undefined && raced.session.state !== "exited") return { status: "ok", session: raced.session }
      const spec = serverFor(language)
      const resolved = resolveServer(spec, lookup, node)
      if ("missing" in resolved) return { status: "missing", language, install: resolved.missing }
      while (live.size >= maxServers) {
        const oldest = [...live.values()].sort((left, right) => left.session.lastUsed - right.session.lastUsed)[0]
        if (oldest === undefined) break
        await wait(retire(oldest, `room for ${repoId}`))
        if (stale) throw closedError()
      }
      // Another caller may have filled this same key while capacity was freed.
      if (live.has(key)) return acquire()
      return { status: "ok", session: start(repoId, root, language, resolved.argv, node).session }
    }
    try {
      const result = await wait(acquire())
      if (stale) throw closedError()
      return result
    } finally {
      pending.delete(acquisition)
      settled.resolve()
    }
  }

  const list: LspHost["list"] = () =>
    [...live.values()].map((entry) => ({ repoId: entry.repoId, language: entry.session.language, state: entry.session.state }))

  const cancelPending = (repoId?: string): ReadonlyArray<Promise<void>> =>
    [...pending].filter((entry) => repoId === undefined || entry.repoId === repoId).map((entry) => {
      entry.cancel()
      return entry.settled
    })

  const closeRepo: LspHost["closeRepo"] = (repoId) => {
    const existing = closingRepos.get(repoId)
    if (existing !== undefined) return existing
    const closing = Promise.all([
      ...cancelPending(repoId),
      ...[...live.values()].filter((entry) => entry.repoId === repoId).map((entry) => retire(entry, "repository closed"))
    ]).then(() => {}).finally(() => { closingRepos.delete(repoId) })
    closingRepos.set(repoId, closing)
    return closing
  }

  const killAll: LspHost["killAll"] = async () => {
    stopping = true
    await Promise.all([
      ...cancelPending(),
      ...[...live.values()].map((entry) => retire(entry, "server stopping"))
    ])
  }

  return { session, list, closeRepo, killAll }
}
