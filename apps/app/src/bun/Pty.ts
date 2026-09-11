/*
 * PTY sessions (LOCAL-APP.md, "HTTP and WebSocket API", the `/api/pty*`
 * routes and the `pty:<sessionId>` topics). A session is one
 * `Bun.spawn({ terminal })` child: the login shell for a terminal tab, the
 * harness's interactive command for a harness tab. Both run under the
 * sandbox policy of their kind (Sandbox.ts), in the expanded cwd, with an
 * allowlisted environment.
 *
 * Output goes out as UTF-8 text frames on the session's topic; input comes
 * back through `write`. Exited sessions stay listed (`alive: false`) until
 * the SPA deletes them, so a tab can still show the exit line and close
 * without a second kill.
 */
import { Buffer } from "node:buffer"
import { randomBytes } from "node:crypto"
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { delimiter, dirname, resolve } from "node:path"
import { AGENT_ROLES, findAgentRole, roleLaunchArgv } from "@smthrs/rpc/AgentRoles"
import type { AgentRole, AgentRoleId } from "@smthrs/rpc/AgentRoles"
import type { Harness, PtySession } from "@smthrs/rpc/LocalApp"
import { harnessCandidateDirs, harnessModelSpec } from "./Harnesses"
import { PtySpawnError, spawnPty } from "./PtySpawn"
import { currentSandboxHost, harnessPolicy, terminalPolicy, wrapSandbox } from "./Sandbox"
import type { SandboxHost } from "./Sandbox"

export interface PtyCreateInput {
  readonly kind: PtySession["kind"]
  /** "~" or "~/x" expands against the server's home. */
  readonly cwd: string
  readonly cols: number
  readonly rows: number
  readonly harnessId?: Harness["id"]
  /**
   * A named role (AgentRoles.ts), built-in or custom: the server resolves it
   * against the agents store to the role's harness and composes the launch
   * argv, so the renderer never supplies argv.
   */
  readonly roleId?: AgentRoleId
  /** The delegated task, handed to the role's CLI as its first prompt. */
  readonly task?: string
}

export type PtyCreateResult =
  | { readonly status: "ok"; readonly session: PtySession }
  | {
    readonly status: "error"
    readonly code:
      | "bad_cwd"
      | "unknown_role"
      | "role_unlaunchable"
      | "unknown_harness"
      | "harness_unavailable"
      | "capacity_reached"
      | "manager_closed"
      | "spawn_failed"
    readonly message: string
  }

export interface PtyManager {
  readonly create: (input: PtyCreateInput) => Promise<PtyCreateResult>
  readonly list: () => Array<PtySession>
  readonly get: (sessionId: string) => PtySession | undefined
  /** Text typed by the user; false when the session is unknown or gone. */
  readonly write: (sessionId: string, data: string) => boolean
  readonly resize: (sessionId: string, cols: number, rows: number) => boolean
  /** SIGHUP, then SIGKILL after a grace period; the record is dropped. False when unknown. */
  readonly kill: (sessionId: string) => Promise<boolean>
  /** Permanently close admission, cancel pending creates, and stop every owned child. Idempotent. */
  readonly dispose: () => Promise<void>
  /**
   * The session's recent output as plain text (`tab.read`): the tail of a
   * bounded scrollback with ANSI escapes stripped. `tailBytes` is a
   * non-negative safe integer UTF-8 byte cap. Partial code points are dropped,
   * so the result may use fewer bytes. Undefined when the session is unknown.
   */
  readonly read: (sessionId: string, tailBytes?: number) => PtyOutput | undefined
}

export interface PtyOutput {
  readonly output: string
  readonly alive: boolean
  readonly truncated: boolean
}

/** How much raw output a session keeps for `read`; older bytes fall off the front. */
export const PTY_SCROLLBACK_BYTES = 64 * 1024

/*
 * Escape sequences an emulator would consume: CSI (`ESC [ ... final`), OSC
 * (`ESC ] ... BEL|ST`), the two-byte ESC forms, and the C0 controls other
 * than tab and newline. The model reads text, not cursor motion.
 */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]|[\u0000-\u0008\u000b-\u001f\u007f]/g

/** The buffered output as the model should read it. */
export const plainText = (raw: string): string => raw.replace(ANSI, "").replace(/\r/g, "")

/** Keep a UTF-8 suffix without manufacturing a replacement character at the cut. */
const tailUtf8 = (text: string, limit: number): string => {
  if (Buffer.byteLength(text, "utf8") <= limit) return text
  const bytes = Buffer.from(text, "utf8")
  let start = bytes.length - limit
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1
  return bytes.toString("utf8", start)
}

export interface PtyManagerOptions {
  /** `pty:<sessionId>` frames go out through here (the server's publish). */
  readonly publish: (topic: string, message: unknown) => void
  /** The harness table, read when a harness tab opens (its binary and launch argv). */
  readonly harnesses: () => Promise<ReadonlyArray<Harness>>
  /**
   * The agents (routes/agents.ts, `<stateDir>/agents.json`), read when a
   * role launches: a custom agent resolves exactly like a built-in. Default
   * the built-in table (tests, one-shot hosts).
   */
  readonly roles?: () => Promise<ReadonlyArray<AgentRole>>
  readonly home?: string
  readonly tmpdir?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  /** The login shell for terminal tabs; default `$SHELL`, then /bin/zsh. */
  readonly shell?: string
  /** Extra PATH entries the children inherit ahead of the app's own PATH (the Node sidecar's dir). */
  readonly pathPrepend?: ReadonlyArray<string> | (() => Promise<ReadonlyArray<string>>)
  readonly sandboxHost?: SandboxHost
  /** Grace between SIGHUP and SIGKILL on kill. */
  readonly killGraceMs?: number
  /** Capacity includes pending launches and children still terminating; default 8, zero disables. */
  readonly maxSessions?: number
  readonly log?: (line: string) => void
}

/** What a child inherits from the app's environment, and nothing else. */
export const ENV_ALLOWLIST: ReadonlyArray<string> = [
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "SSH_AUTH_SOCK",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
  "EDITOR",
  "VISUAL",
  "PAGER",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "GEMINI_DIR",
  "KIMI_SHARE_DIR",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENCODE_API_KEY",
  /* OpenCode's "Kimi For Coding" provider reads this (`opencode providers list`). */
  "KIMI_API_KEY",
  "CEREBRAS_API_KEY",
  "CURSOR_API_KEY",
  "AMP_API_KEY"
]

/** `~` and `~/x` against the home directory; anything else resolved as-is. */
export const expandCwd = (cwd: string, home: string): string => {
  const trimmed = cwd.trim()
  if (trimmed === "" || trimmed === "~") return home
  if (trimmed.startsWith("~/")) return resolve(home, trimmed.slice(2))
  return resolve(trimmed)
}

/**
 * The child's environment: the allowlist, TERM/COLORTERM/LANG for an
 * xterm-256color emulator, and a PATH that starts with the harness
 * candidate dirs (a Finder launch has the launchd PATH, which lacks
 * `~/.local/bin` and homebrew) and the Node sidecar so a `#!/usr/bin/env node`
 * CLI like codex resolves.
 */
export const childEnv = (
  source: Readonly<Record<string, string | undefined>>,
  home: string,
  pathPrepend: ReadonlyArray<string>
): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const name of ENV_ALLOWLIST) {
    const value = source[name]
    if (value !== undefined && value !== "") env[name] = value
  }
  env.HOME = home
  env.TERM = "xterm-256color"
  env.COLORTERM = "truecolor"
  env.LANG = env.LANG ?? "en_US.UTF-8"
  const listDir = (dir: string): ReadonlyArray<string> => {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  }
  const path = [
    ...pathPrepend,
    ...harnessCandidateDirs({ home, listDir }).filter((dir) => existsSync(dir)),
    ...(source.PATH ?? "").split(delimiter),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin"
  ].filter((dir) => dir !== "")
  env.PATH = [...new Set(path)].join(delimiter)
  return env
}

const newSessionId = (): string => `pty-${randomBytes(16).toString("hex")}`

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

interface LiveSession {
  record: PtySession
  readonly proc: ReturnType<typeof Bun.spawn>
  readonly decoder: TextDecoder
  exited: Promise<void>
  /** The bounded scrollback `read` serves; appended by every output frame. */
  scrollback: string
  /** True once older output has fallen off the front of `scrollback`. */
  dropped: boolean
  processExited: boolean
  stopping?: Promise<boolean>
}

interface PendingCreate {
  readonly canceled: ReturnType<typeof Promise.withResolvers<PtyCreateResult>>
  closed: boolean
}

export const createPtyManager = (options: PtyManagerOptions): PtyManager => {
  const logger = options.log ?? ((line: string) => console.error(line))
  const log = (line: string): void => { try { logger(line) } catch { /* Diagnostics cannot break child ownership. */ } }
  const publish = (topic: string, message: unknown): void => {
    try { options.publish(topic, message) } catch { log("A PTY observer failed; child ownership is unchanged.") }
  }
  const home = options.home ?? homedir()
  const scratch = options.tmpdir ?? safeRealpath(tmpdir())
  const env = options.env ?? Bun.env
  const shell = options.shell ?? (env.SHELL !== undefined && env.SHELL !== "" ? env.SHELL : "/bin/zsh")
  const sandboxHost = options.sandboxHost ?? currentSandboxHost(env)
  const killGraceMs = options.killGraceMs ?? 2000
  const maxSessions = options.maxSessions ?? 8
  if (!Number.isSafeInteger(maxSessions) || maxSessions < 0) throw new RangeError("maxSessions must be a non-negative safe integer.")
  const sessions = new Map<string, LiveSession>()
  // Display records may disappear before their child exits. Admission and
  // disposal retain ownership independently until the OS reports termination.
  const children = new Map<string, LiveSession>()
  const retiring = new Map<string, LiveSession>()
  const preparing = new Set<PendingCreate>()
  let disposed = false
  let disposal: Promise<void> | undefined
  const closedResult = (): PtyCreateResult => ({ status: "error", code: "manager_closed", message: "The terminal manager is closed." })

  const topic = (sessionId: string): string => `pty:${sessionId}`

  /** Publish one output frame and keep it in the session's scrollback. */
  const emitOutput = (sessionId: string, text: string): void => {
    if (text === "") return
    const live = sessions.get(sessionId)
    if (live !== undefined) {
      const joined = live.scrollback + text
      live.scrollback = tailUtf8(joined, PTY_SCROLLBACK_BYTES)
      if (live.scrollback !== joined) live.dropped = true
    }
    publish(topic(sessionId), { type: "pty.output", sessionId, data: text })
  }

  const prepare = async (
    input: PtyCreateInput,
    admission: PendingCreate
  ): Promise<PtyCreateResult> => {
    const cwd = expandCwd(input.cwd, home)
    if (!isDirectory(cwd)) return { status: "error", code: "bad_cwd", message: `${cwd} is not a directory.` }
    let argv: Array<string>
    let harnessId: Harness["id"] | undefined
    if (input.kind === "harness") {
      // A role names its harness; the launch argv is COMPOSED from the role's model and the harness's model flag, never the renderer's.
      let role: AgentRole | undefined
      if (input.roleId !== undefined) {
        role = findAgentRole(input.roleId, await (options.roles ?? (async () => AGENT_ROLES))())
        if (admission.closed) return closedResult()
        if (role === undefined) return { status: "error", code: "unknown_role", message: `There is no agent with id ${input.roleId}.` }
      }
      const wantedHarness = role?.harness ?? input.harnessId
      const harness = (await options.harnesses()).find((candidate) => candidate.id === wantedHarness)
      if (admission.closed) return closedResult()
      if (harness === undefined) {
        return { status: "error", code: "unknown_harness", message: `There is no harness with id ${String(wantedHarness)}.` }
      }
      if (harness.status === "unavailable" || harness.binary === null) {
        return { status: "error", code: "harness_unavailable", message: `${harness.displayName} is not installed here.` }
      }
      harnessId = harness.id
      let launch: ReadonlyArray<string>
      if (role === undefined) launch = harness.launch.argv
      else {
        const spec = harnessModelSpec(harness.id)
        if (spec === undefined) {
          return { status: "error", code: "role_unlaunchable", message: `${harness.displayName} takes no model flag, so ${role.label} cannot launch on it.` }
        }
        try {
          launch = roleLaunchArgv(role, spec, input.task)
        } catch (error) {
          return { status: "error", code: "role_unlaunchable", message: error instanceof Error ? error.message : String(error) }
        }
      }
      // The resolved binary, so a Finder launch's PATH cannot lose it.
      argv = [harness.binary, ...launch.slice(1)]
    } else {
      argv = [shell, "-il"]
    }
    const paths = { repo: cwd, home, tmpdir: scratch }
    const wrapped = wrapSandbox(argv, input.kind === "harness" ? harnessPolicy(paths) : terminalPolicy(paths), sandboxHost)
    const sessionId = newSessionId()
    const prepend = typeof options.pathPrepend === "function" ? await options.pathPrepend() : options.pathPrepend ?? []
    if (admission.closed) return closedResult()
    const childEnvironment = childEnv(env, home, prepend)
    const decoder = new TextDecoder("utf-8")
    let eof: () => void = () => {}
    const eofSeen = new Promise<void>((resolveEof) => {
      eof = resolveEof
    })
    let proc: ReturnType<typeof Bun.spawn>
    try {
      proc = spawnPty(wrapped.argv, {
        cwd,
        env: childEnvironment,
        terminal: {
          cols: Math.max(2, Math.floor(input.cols)),
          rows: Math.max(1, Math.floor(input.rows)),
          name: "xterm-256color",
          data: (_terminal, chunk) => {
            emitOutput(sessionId, decoder.decode(chunk, { stream: true }))
          },
          exit: () => eof()
        }
      })
    } catch (error) {
      if (error instanceof PtySpawnError) await error.stopped
      return { status: "error", code: "spawn_failed", message: error instanceof Error ? error.message : String(error) }
    }
    const record: PtySession = {
      sessionId,
      kind: input.kind,
      ...(harnessId === undefined ? {} : { harnessId }),
      cwd,
      pid: proc.pid,
      alive: true
    }
    const live: LiveSession = { record, proc, decoder, exited: Promise.resolve(), scrollback: "", dropped: false, processExited: false }
    sessions.set(sessionId, live)
    preparing.delete(admission)
    children.set(sessionId, live)
    live.exited = proc.exited.then(async (code) => {
      live.processExited = true
      children.delete(sessionId)
      // The last output usually lands after SIGCHLD; the PTY's EOF (or a short grace) orders it before the exit frame.
      await Promise.race([eofSeen, Bun.sleep(300)])
      emitOutput(sessionId, decoder.decode())
      const current = sessions.get(sessionId)
      const exitCode = typeof code === "number" ? code : null
      // The list (and tab.read) name the exit code too, not only the one-shot exit frame.
      if (current !== undefined) current.record = { ...current.record, alive: false, exitCode }
      publish(topic(sessionId), { type: "pty.exit", sessionId, code: exitCode })
      log(`pty ${sessionId}: exited ${String(code)}`)
      try {
        proc.terminal?.close()
      } catch {
        // Already closed.
      }
    })
    // An OS observation failure remains visible to kill/dispose, without an
    // unhandled rejection when no caller is currently awaiting this session.
    void live.exited.catch(() => log("A PTY exit could not be observed; its child remains owned."))
    log(`pty ${sessionId}: ${input.kind} pid ${proc.pid} in ${cwd} (sandbox ${wrapped.enforced ? "on" : "off"})`)
    return { status: "ok", session: record }
  }

  const create: PtyManager["create"] = (input) => {
    if (disposed) return Promise.resolve(closedResult())
    if (preparing.size + children.size >= maxSessions) {
      return Promise.resolve({ status: "error", code: "capacity_reached", message: `At most ${maxSessions} terminal sessions may run at once.` })
    }
    const admission = { canceled: Promise.withResolvers<PtyCreateResult>(), closed: false }
    preparing.add(admission)
    return Promise.race([prepare({ ...input }, admission), admission.canceled.promise])
      .finally(() => preparing.delete(admission))
  }

  const list: PtyManager["list"] = () => [...sessions.values()].map((live) => ({ ...live.record }))

  const get: PtyManager["get"] = (sessionId) => {
    const live = sessions.get(sessionId)
    return live === undefined ? undefined : { ...live.record }
  }

  const write: PtyManager["write"] = (sessionId, data) => {
    const live = sessions.get(sessionId)
    if (live === undefined || !live.record.alive || live.proc.terminal === undefined) return false
    try {
      live.proc.terminal.write(data)
      return true
    } catch {
      return false
    }
  }

  const resize: PtyManager["resize"] = (sessionId, cols, rows) => {
    const live = sessions.get(sessionId)
    if (live === undefined || !live.record.alive || live.proc.terminal === undefined) return false
    try {
      live.proc.terminal.resize(Math.max(2, Math.floor(cols)), Math.max(1, Math.floor(rows)))
      return true
    } catch {
      return false
    }
  }

  const stopSession = (live: LiveSession): Promise<boolean> => {
    if (live.stopping !== undefined) return live.stopping
    const sessionId = live.record.sessionId
    sessions.delete(sessionId)
    retiring.set(sessionId, live)
    live.stopping = (async () => {
      try {
        if (!live.processExited) {
          try { live.proc.kill("SIGHUP") } catch { /* Observe termination below. */ }
          const exited = await Promise.race([live.exited.then(() => true), Bun.sleep(killGraceMs).then(() => false)])
          if (!exited) {
            try { live.proc.kill("SIGKILL") } catch { /* Observe termination below. */ }
            const killed = await Promise.race([live.exited.then(() => true), Bun.sleep(1000).then(() => false)])
            if (!killed) throw new Error("The PTY child did not exit after termination. Its capacity remains reserved.")
          }
        } else {
          await live.exited
        }
        return true
      } finally {
        try {
          live.proc.terminal?.close()
        } catch {
          // Already closed.
        }
        retiring.delete(sessionId)
      }
    })()
    return live.stopping
  }

  const kill: PtyManager["kill"] = (sessionId) => {
    const live = sessions.get(sessionId) ?? children.get(sessionId) ?? retiring.get(sessionId)
    return live === undefined ? Promise.resolve(false) : stopSession(live)
  }

  const dispose: PtyManager["dispose"] = () => {
    if (disposal !== undefined) return disposal
    disposed = true
    for (const admission of preparing) {
      admission.closed = true
      admission.canceled.resolve(closedResult())
    }
    const owned = new Set([...sessions.values(), ...children.values(), ...retiring.values()])
    disposal = Promise.allSettled([...owned].map(stopSession)).then((results) => {
      const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
      if (errors.length > 0) throw new AggregateError(errors, "Some PTY children could not be stopped.")
    })
    return disposal
  }

  const read: PtyManager["read"] = (sessionId, tailBytes) => {
    if (tailBytes !== undefined && (!Number.isSafeInteger(tailBytes) || tailBytes < 0)) {
      throw new RangeError("tailBytes must be a non-negative safe integer.")
    }
    const live = sessions.get(sessionId)
    if (live === undefined) return undefined
    const text = plainText(live.scrollback)
    const output = tailBytes === undefined ? text : tailUtf8(text, tailBytes)
    return {
      output,
      alive: live.record.alive,
      truncated: live.dropped || output !== text
    }
  }

  return { create, list, get, write, resize, kill, dispose, read }
}

const safeRealpath = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** The directory of a Node sidecar, for `pathPrepend`. */
export const binDirOf = (path: string | null | undefined): ReadonlyArray<string> =>
  path === null || path === undefined || path === "" ? [] : [dirname(path)]
