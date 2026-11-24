/**
 * Platform-side read-only collectors for `smthrs node serve`, `smthrs node overview --local`,
 * and `smthrs node inspect`.
 *
 * Strictly read-only: users continue running normal interactive `claude`, `codex`, `agy`,
 * and Antigravity IDE sessions without wrappers or mutation, while the running Smithers
 * node client gives full observability (model, account, canonical project, branch/lane,
 * repo, cwd, human-readable summary, structured scrubbed transcript, status, PID,
 * CPU seconds, tokens) locally and synced to `https://smithers.sh/app/fleet` over BYOA
 * MCP-over-HTTP.
 *
 * OBS-5: every title, summary, command, and transcript entry is scrubbed before returning
 * so tokens, secrets, API keys, and credentials never leave the machine.
 * @since 1.0.0
 */

import { Effect, Layer } from "effect"
import { execFileSync } from "node:child_process"
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs"
import { cpus, freemem, homedir, hostname, loadavg, totalmem } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import {
  type AccountSnapshot,
  type HostSnapshot,
  NodeCollectors,
  type SessionSnapshot,
  type TranscriptEntry
} from "./NodeDaemon.vibe"

const SECRET_RE =
  /(gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-ant-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{16,}|sma_[0-9a-f]{32,}|xox[baprs]-[A-Za-z0-9-]+|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._-]{12,}|(?:TOKEN|SECRET|PASSWORD|API_KEY)\s*=\s*\S+)/gi

const MAX_TRANSCRIPT_ITEMS = 20

const scrub = (s: string | null | undefined, max = 140): string | null => {
  if (!s) return null
  const out = s.replace(SECRET_RE, "[redacted]").replace(/[\r\n\t]+/g, " ").trim()
  return out.length === 0 ? null : out.slice(0, max)
}

const runCmd = (bin: string, args: ReadonlyArray<string>, timeoutMs = 4000): string | null => {
  try {
    return execFileSync(bin, [...args], {
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "ignore"]
    })
  } catch {
    return null
  }
}

const pidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Parses `ps` cputime (`DD-HH:MM:SS`, `HH:MM:SS`, or `MM:SS.xx`) into seconds. */
const parseCpuSeconds = (raw: string): number | null => {
  const s = raw.trim()
  if (!s) return null
  let days = 0
  let rest = s
  if (rest.includes("-")) {
    const [d, r] = rest.split("-")
    days = Number(d)
    rest = r ?? ""
  }
  const parts = rest.split(":").map(Number)
  if (parts.some((n) => !Number.isFinite(n))) return null
  let secs = 0
  if (parts.length === 3) secs = parts[0]! * 3600 + parts[1]! * 60 + parts[2]!
  else if (parts.length === 2) secs = parts[0]! * 60 + parts[1]!
  else if (parts.length === 1) secs = parts[0]!
  else return null
  const total = days * 86400 + secs
  return Number.isFinite(total) ? Math.round(total * 10) / 10 : null
}

interface ProcInfo {
  readonly pid: number
  readonly cpuSeconds: number | null
  readonly command: string
}

const listProcs = (): Array<ProcInfo> => {
  const out = runCmd("ps", ["-axww", "-o", "pid=,cputime=,command="], 3000)
  if (!out) return []
  const procs: Array<ProcInfo> = []
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+([0-9:.-]+)\s+(.*)$/.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    if (!Number.isInteger(pid) || pid <= 0) continue
    procs.push({
      pid,
      cpuSeconds: parseCpuSeconds(m[2] ?? ""),
      command: (m[3] ?? "").trim()
    })
  }
  return procs
}

/** Reads at most the leading `maxBytes` of a file without loading large transcripts into memory. */
const readHead = (filePath: string, maxBytes = 28_000): string | null => {
  let fd: number | null = null
  try {
    const st = statSync(filePath)
    if (st.size === 0) return ""
    const len = Math.min(st.size, maxBytes)
    fd = openSync(filePath, "r")
    const buf = Buffer.alloc(len)
    const n = readSync(fd, buf, 0, len, 0)
    return buf.subarray(0, n).toString("utf8")
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // ignore
      }
    }
  }
}

/** Reads at most the trailing `maxBytes` of a file without loading large transcripts into memory. */
const readTail = (filePath: string, maxBytes = 64_000): string | null => {
  let fd: number | null = null
  try {
    const st = statSync(filePath)
    if (st.size === 0) return ""
    const len = Math.min(st.size, maxBytes)
    const offset = Math.max(0, st.size - len)
    fd = openSync(filePath, "r")
    const buf = Buffer.alloc(len)
    const n = readSync(fd, buf, 0, len, offset)
    return buf.subarray(0, n).toString("utf8")
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // ignore
      }
    }
  }
}

const parseGitRemoteOrigin = (configText: string): string | null => {
  const lines = configText.split(/\r?\n/)
  let inOrigin = false
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line.startsWith("[")) {
      inOrigin = /^\[remote\s+"origin"\]$/i.test(line)
      continue
    }
    if (!inOrigin) continue
    const m = /^url\s*=\s*(.+)$/.exec(line)
    if (!m) continue
    const rawUrl = (m[1] ?? "").trim()
    if (!rawUrl) continue
    // Normalize SSH (`git@github.com:owner/repo.git`), ssh://, and https:// URLs without leaking credentials.
    const cleaned = rawUrl
      .replace(/\.git$/i, "")
      .replace(/\/+$/, "")
    const scpMatch = /^[^/:@]+@[^:]+:([^/]+)\/([^/]+)$/.exec(cleaned)
    if (scpMatch) return `${scpMatch[1]}/${scpMatch[2]}`
    const urlMatch = /^[a-z]+:\/\/(?:[^/@]+@)?[^/]+\/(.+)$/i.exec(cleaned)
    if (urlMatch && urlMatch[1]) {
      const parts = urlMatch[1].split("/").filter(Boolean)
      if (parts.length >= 2) {
        return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`
      }
    }
  }
  return null
}

const readOriginFromConfigFile = (configPath: string): string | null => {
  try {
    if (!existsSync(configPath)) return null
    const st = statSync(configPath)
    if (!st.isFile()) return null
    return parseGitRemoteOrigin(readFileSync(configPath, "utf8"))
  } catch {
    return null
  }
}

const readOriginFromGitDir = (gitDir: string): string | null => {
  const direct = readOriginFromConfigFile(join(gitDir, "config"))
  if (direct) return direct
  const commonFile = join(gitDir, "commondir")
  try {
    if (existsSync(commonFile) && statSync(commonFile).isFile()) {
      const rel = readFileSync(commonFile, "utf8").trim()
      if (rel) {
        return readOriginFromConfigFile(join(resolve(gitDir, rel), "config"))
      }
    }
  } catch {
    // ignore
  }
  return null
}

const readOriginFromDir = (dir: string): string | null => {
  // 1. Check `.git` (directory or gitdir pointer file for worktrees/submodules)
  const dotGit = join(dir, ".git")
  try {
    if (existsSync(dotGit)) {
      const st = statSync(dotGit)
      if (st.isDirectory()) {
        const remote = readOriginFromGitDir(dotGit)
        if (remote) return remote
      } else if (st.isFile()) {
        const text = readFileSync(dotGit, "utf8")
        const m = /^gitdir:\s*(.+)$/m.exec(text)
        if (m && m[1]) {
          const remote = readOriginFromGitDir(resolve(dir, m[1].trim()))
          if (remote) return remote
        }
      }
    }
  } catch {
    // ignore
  }

  // 2. Check `.jj/repo` (directory or workspace pointer file pointing to parent repo's `.jj/repo`)
  const jjRepoPath = join(dir, ".jj", "repo")
  try {
    if (existsSync(jjRepoPath)) {
      const st = statSync(jjRepoPath)
      const jjRepoDir = st.isFile()
        ? resolve(join(dir, ".jj"), readFileSync(jjRepoPath, "utf8").trim())
        : st.isDirectory()
        ? jjRepoPath
        : null
      if (jjRepoDir && existsSync(jjRepoDir)) {
        const storeGit = readOriginFromConfigFile(join(jjRepoDir, "store", "git", "config"))
        if (storeGit) return storeGit
        const gitTargetFile = join(jjRepoDir, "store", "git_target")
        if (existsSync(gitTargetFile) && statSync(gitTargetFile).isFile()) {
          const targetRel = readFileSync(gitTargetFile, "utf8").trim()
          if (targetRel) {
            const targetRemote = readOriginFromGitDir(resolve(join(jjRepoDir, "store"), targetRel))
            if (targetRemote) return targetRemote
          }
        }
        const siblingGit = readOriginFromGitDir(join(dirname(dirname(jjRepoDir)), ".git"))
        if (siblingGit) return siblingGit
      }
    }
  } catch {
    // ignore
  }

  return null
}

const inferProjectFromText = (text: string | null | undefined): string | null => {
  if (!text) return null
  const lower = text.toLowerCase()
  if (lower.includes("vibelang") || lower.includes("effectscript")) return "smithersai/vibelang"
  if (lower.includes("smithers")) return "smithersai/smithers"
  if (lower.includes("voltaire")) return "evmts/voltaire"
  if (lower.includes("zmux")) return "zmux"
  if (lower.includes("needlefish")) return "needlefish"
  return null
}

/**
 * Resolves a canonical project identifier (`owner/repo` or workspace name) from a working
 * directory (walking up `.git` / `.jj/repo` metadata with an optional per-tick cache) or
 * from fallback hint text when no VCS remote is present.
 * @category helpers
 * @since 1.0.0
 */
export const resolveProject = (
  cwd: string | null | undefined,
  hintText?: string | null,
  cache?: Map<string, string | null>
): string | null => {
  if (cwd && cwd.trim().length > 0) {
    const normCwd = cwd.trim()
    let remote: string | null | undefined = cache?.get(normCwd)
    if (remote === undefined) {
      remote = null
      let cur = normCwd
      for (let depth = 0; depth < 12; depth++) {
        const found = readOriginFromDir(cur)
        if (found) {
          remote = found
          break
        }
        const parent = dirname(cur)
        if (parent === cur) break
        cur = parent
      }
      cache?.set(normCwd, remote)
    }
    if (remote) return scrub(remote, 160)
  }

  const fromCwd = inferProjectFromText(cwd)
  if (fromCwd) return fromCwd
  const fromHint = inferProjectFromText(hintText)
  if (fromHint) return fromHint

  if (cwd && cwd.trim().length > 0) {
    const trimmed = cwd.trim().replace(/\/+$/, "")
    const home = homedir().replace(/\/+$/, "")
    if (trimmed && trimmed !== "/" && trimmed !== "/tmp" && trimmed !== "/private/tmp" && trimmed !== home) {
      return scrub(basename(trimmed), 160)
    }
  }
  return null
}

const isSystemPreamble = (text: string): boolean => {
  const t = text.trim()
  if (!t) return true
  const lower = t.toLowerCase()
  return (
    lower.startsWith("<system") ||
    lower.startsWith("<instructions") ||
    lower.startsWith("<skills_instructions") ||
    lower.startsWith("<environment_context") ||
    lower.startsWith("<multi_agent") ||
    lower.startsWith("<permissions") ||
    lower.startsWith("# agents.md") ||
    lower.startsWith("# environment") ||
    lower.startsWith("the following is a <system_message>") ||
    lower.startsWith("you are a claude")
  )
}

const stripUserRequestTags = (text: string): string => text.replace(/<\/?USER_REQUEST>/gi, "").trim()

const buildSummary = (goal: string | null, latestNote: string | null): string | null => {
  const g = scrub(goal, 110)
  const l = scrub(latestNote, 120)
  if (g && l) {
    if (g.toLowerCase() === l.toLowerCase() || l.toLowerCase().startsWith(g.toLowerCase().slice(0, 48))) {
      return scrub(l, 320)
    }
    return scrub(`${g} — ${l}`, 320)
  }
  return scrub(g ?? l, 320)
}

const stripWrappingQuotes = (s: string): string => {
  const trimmed = s.trim()
  if (trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

const formatToolPreview = (name: string, rawInput: unknown): string => {
  let obj: Record<string, unknown> | null = null
  let rawStr: string | null = null
  if (typeof rawInput === "string") {
    const trimmed = rawInput.trim()
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          obj = parsed as Record<string, unknown>
        }
      } catch {
        rawStr = trimmed
      }
    } else {
      rawStr = trimmed
    }
  } else if (typeof rawInput === "object" && rawInput !== null && !Array.isArray(rawInput)) {
    obj = rawInput as Record<string, unknown>
  }

  const lowerName = name.toLowerCase()
  const pickStr = (keys: ReadonlyArray<string>): string | null => {
    if (!obj) return null
    for (const k of keys) {
      const v = obj[k]
      if (typeof v === "string" && v.trim().length > 0) return stripWrappingQuotes(v)
    }
    return null
  }

  if (
    lowerName === "bash" || lowerName === "exec" || lowerName === "run_command" ||
    lowerName === "shell" || lowerName === "shell_command"
  ) {
    const cmd = pickStr(["command", "CommandLine", "cmd", "script", "input"]) ?? rawStr
    return scrub(cmd, 140) ?? name
  }
  if (
    lowerName === "read" || lowerName === "edit" || lowerName === "write" ||
    lowerName === "read_file" || lowerName === "edit_file" || lowerName === "write_file" ||
    lowerName === "view_file" || lowerName === "multi_edit"
  ) {
    const file = pickStr(["file_path", "path", "Path", "TargetFile", "AbsolutePath"])
    if (file) return scrub(basename(file), 100) ?? name
  }
  if (
    lowerName === "grep" || lowerName === "glob" || lowerName === "grep_search" ||
    lowerName === "find_by_name" || lowerName === "search_web"
  ) {
    const pat = pickStr(["pattern", "Query", "Pattern", "query", "glob"])
    if (pat) return scrub(pat, 100) ?? name
  }
  if (obj) {
    for (const v of Object.values(obj)) {
      if (typeof v === "string" && v.trim().length > 0) {
        const s = scrub(stripWrappingQuotes(v), 120)
        if (s) return s
      }
    }
  }
  if (rawStr) {
    const s = scrub(rawStr, 120)
    if (s) return s
  }
  return name
}

const pushTranscriptEntry = (
  entries: Array<TranscriptEntry>,
  ts: string | null,
  role: TranscriptEntry["role"],
  label: string | null,
  text: string | null | undefined
): void => {
  const cleanText = scrub(text, 360)
  if (!cleanText) return
  entries.push({
    ts: ts && ts.length <= 64 && !Number.isNaN(Date.parse(ts)) ? new Date(Date.parse(ts)).toISOString() : null,
    role,
    label: scrub(label, 80),
    text: cleanText
  })
}

const extractClaudeUserText = (msg: Record<string, unknown>): string | null => {
  const content = msg["content"]
  if (typeof content === "string") {
    return isSystemPreamble(content) ? null : scrub(content, 360)
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue
      const b = block as Record<string, unknown>
      if (b["type"] === "text" && typeof b["text"] === "string" && !isSystemPreamble(b["text"])) {
        const s = scrub(b["text"], 360)
        if (s) return s
      }
    }
  }
  return null
}

const encodeClaudeProjectPath = (cwd: string): string => cwd.replace(/[/.]/g, "-")

interface TranscriptMeta {
  readonly model: string | null
  readonly gitBranch: string | null
  readonly tokensUsed: number | null
  readonly lastTool: string | null
  readonly lastActivityAt: string | null
  readonly inferredStatus: SessionSnapshot["status"] | null
  readonly goal: string | null
  readonly summary: string | null
  readonly transcript: ReadonlyArray<TranscriptEntry>
  readonly recentEvents: ReadonlyArray<string>
}

const inspectClaudeTranscript = (configDir: string, cwd: string | null, sessionId: string): TranscriptMeta => {
  const empty: TranscriptMeta = {
    model: null,
    gitBranch: null,
    tokensUsed: null,
    lastTool: null,
    lastActivityAt: null,
    inferredStatus: null,
    goal: null,
    summary: null,
    transcript: [],
    recentEvents: []
  }
  if (!cwd) return empty
  const jsonlPath = join(configDir, "projects", encodeClaudeProjectPath(cwd), `${sessionId}.jsonl`)
  if (!existsSync(jsonlPath)) return empty

  const head = readHead(jsonlPath, 28_000)
  const tail = readTail(jsonlPath, 64_000)
  if (!head && !tail) return empty

  let model: string | null = null
  let gitBranch: string | null = null
  let tokensUsed = 0
  let sawTokens = false
  let lastTool: string | null = null
  let lastActivityAt: string | null = null
  let inferredStatus: SessionSnapshot["status"] | null = null
  let goal: string | null = null
  let latestAssistantNote: string | null = null
  let latestToolNote: string | null = null
  const transcript: Array<TranscriptEntry> = []
  const recentEvents: Array<string> = []

  // Pass 1: read HEAD for initial user goal and baseline metadata
  if (head) {
    for (const line of head.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed.startsWith("{")) continue
      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>
        const entryType = typeof obj["type"] === "string" ? obj["type"] : ""
        if (
          entryType === "api-request" || entryType === "api-request-blob" || entryType === "api-request-shape" ||
          obj["isMeta"] === true
        ) {
          continue
        }
        if (!gitBranch && typeof obj["gitBranch"] === "string" && obj["gitBranch"].length > 0) {
          gitBranch = obj["gitBranch"]
        }
        const msg = (typeof obj["message"] === "object" && obj["message"] !== null
          ? obj["message"]
          : null) as Record<string, unknown> | null
        if (!msg) continue
        if (!model && typeof msg["model"] === "string" && !msg["model"].startsWith("<")) {
          model = msg["model"]
        }
        if (!goal && (entryType === "user" || msg["role"] === "user")) {
          const text = extractClaudeUserText(msg)
          if (text) goal = text
        }
      } catch {
        // partial last line from head read is expected
      }
    }
  }

  // Pass 2: read TAIL for latest tokens, tool calls, transcript entries, and status
  if (tail) {
    for (const line of tail.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed.startsWith("{")) continue
      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>
        const entryType = typeof obj["type"] === "string" ? obj["type"] : ""
        if (
          entryType === "api-request" || entryType === "api-request-blob" || entryType === "api-request-shape" ||
          obj["isMeta"] === true
        ) {
          continue
        }
        if (typeof obj["gitBranch"] === "string" && obj["gitBranch"].length > 0) {
          gitBranch = obj["gitBranch"]
        }
        const ts = typeof obj["timestamp"] === "string" ? obj["timestamp"] : null
        if (ts) lastActivityAt = ts
        const msg = (typeof obj["message"] === "object" && obj["message"] !== null
          ? obj["message"]
          : null) as Record<string, unknown> | null
        if (!msg) continue

        if (typeof msg["model"] === "string" && !msg["model"].startsWith("<")) model = msg["model"]
        const usage = (typeof msg["usage"] === "object" && msg["usage"] !== null
          ? msg["usage"]
          : null) as Record<string, unknown> | null
        if (usage) {
          const inp = typeof usage["input_tokens"] === "number" ? usage["input_tokens"] : 0
          const out = typeof usage["output_tokens"] === "number" ? usage["output_tokens"] : 0
          const cacheRead = typeof usage["cache_read_input_tokens"] === "number"
            ? usage["cache_read_input_tokens"]
            : 0
          const cacheCreate = typeof usage["cache_creation_input_tokens"] === "number"
            ? usage["cache_creation_input_tokens"]
            : 0
          const sum = inp + out + cacheRead + cacheCreate
          if (sum > 0) {
            tokensUsed = Math.max(tokensUsed, sum)
            sawTokens = true
          }
        }

        const role = typeof msg["role"] === "string" ? msg["role"] : entryType
        if (role === "user") {
          const text = extractClaudeUserText(msg)
          if (text) {
            if (!goal) goal = text
            pushTranscriptEntry(transcript, ts, "user", "user", text)
            recentEvents.push(`user: ${text.slice(0, 90)}`)
          }
        } else if (role === "assistant") {
          const content = msg["content"]
          if (Array.isArray(content)) {
            for (const block of content) {
              if (typeof block !== "object" || block === null) continue
              const b = block as Record<string, unknown>
              if (b["type"] === "tool_use" && typeof b["name"] === "string") {
                const toolName = b["name"]
                const preview = formatToolPreview(toolName, b["input"])
                lastTool = toolName
                inferredStatus = "working"
                latestToolNote = `${toolName}: ${preview}`
                pushTranscriptEntry(transcript, ts, "tool", toolName, preview)
                recentEvents.push(`tool:${toolName} ${preview.slice(0, 70)}`)
              } else if (b["type"] === "text" && typeof b["text"] === "string") {
                const snippet = scrub(b["text"], 360)
                if (snippet) {
                  latestAssistantNote = snippet
                  pushTranscriptEntry(transcript, ts, "assistant", "assistant", snippet)
                  recentEvents.push(`assistant: ${snippet.slice(0, 90)}`)
                }
              }
            }
          } else if (typeof content === "string") {
            const snippet = scrub(content, 360)
            if (snippet) {
              latestAssistantNote = snippet
              pushTranscriptEntry(transcript, ts, "assistant", "assistant", snippet)
              recentEvents.push(`assistant: ${snippet.slice(0, 90)}`)
            }
          }
          if (msg["stop_reason"] === "end_turn") {
            inferredStatus = "waiting"
          }
        }
      } catch {
        // partial first line from tail read is expected
      }
    }
  }

  return {
    model,
    gitBranch,
    tokensUsed: sawTokens ? tokensUsed : null,
    lastTool,
    lastActivityAt,
    inferredStatus,
    goal,
    summary: buildSummary(goal, latestAssistantNote ?? latestToolNote),
    transcript: transcript.slice(-MAX_TRANSCRIPT_ITEMS),
    recentEvents: recentEvents.slice(-8)
  }
}

const readDiskGb = (dir: string): { freeGb: number | null; totalGb: number | null } => {
  const out = runCmd("df", ["-k", dir], 2000)
  if (!out) return { freeGb: null, totalGb: null }
  const lines = out.trim().split("\n")
  const cols = (lines[1] ?? "").trim().split(/\s+/)
  const totalKb = Number(cols[1])
  const availKb = Number(cols[3])
  return {
    totalGb: Number.isFinite(totalKb) ? Math.round((totalKb / (1024 * 1024)) * 10) / 10 : null,
    freeGb: Number.isFinite(availKb) ? Math.round((availKb / (1024 * 1024)) * 10) / 10 : null
  }
}

/**
 * Configuration for read-only local host, session, account, and cfbox collectors.
 * @category models
 * @since 1.0.0
 */
export interface CollectorConfig {
  readonly nodeId: string
  readonly name: string
  readonly kind: HostSnapshot["kind"]
  readonly labels: ReadonlyArray<string>
  readonly version: string
  readonly home?: string
}

const discoverClaudeSessions = (
  home: string,
  nodeId: string,
  procByPid: ReadonlyMap<number, ProcInfo>,
  projectCache: Map<string, string | null>
): Array<SessionSnapshot> => {
  const results: Array<SessionSnapshot> = []
  const seenPids = new Set<number>()
  const dirs: Array<{ label: string; dir: string }> = [{ label: "claude-default", dir: join(home, ".claude") }]
  const acctRoot = join(home, ".smithers", "accounts")
  if (existsSync(acctRoot)) {
    try {
      for (const entry of readdirSync(acctRoot)) {
        if (entry.startsWith("claude-")) dirs.push({ label: entry, dir: join(acctRoot, entry) })
      }
    } catch {
      // ignore
    }
  }
  for (const { label, dir } of dirs) {
    const sessDir = join(dir, "sessions")
    if (!existsSync(sessDir)) continue
    let files: Array<string> = []
    try {
      files = readdirSync(sessDir).filter((f) => f.endsWith(".json"))
    } catch {
      continue
    }
    for (const file of files) {
      try {
        const raw = JSON.parse(readFileSync(join(sessDir, file), "utf8")) as Record<string, unknown>
        const pid = Number(raw["pid"] ?? file.replace(".json", ""))
        if (!pidAlive(pid) || seenPids.has(pid)) continue
        seenPids.add(pid)
        const sessionId = typeof raw["sessionId"] === "string" ? raw["sessionId"] : String(pid)
        const cwd = typeof raw["cwd"] === "string" ? raw["cwd"] : null
        const name = typeof raw["name"] === "string"
          ? raw["name"]
          : typeof raw["tmux"] === "string"
          ? raw["tmux"]
          : null
        const meta = inspectClaudeTranscript(dir, cwd, sessionId)
        const statusRaw = typeof raw["status"] === "string" ? raw["status"].toLowerCase() : ""
        const status: SessionSnapshot["status"] = statusRaw.includes("busy") || statusRaw.includes("work")
          ? "working"
          : statusRaw.includes("wait")
          ? "waiting"
          : statusRaw.includes("idle")
          ? "idle"
          : meta.inferredStatus ?? "working"
        const startedAt = typeof raw["startedAt"] === "number"
          ? new Date(raw["startedAt"]).toISOString()
          : typeof raw["startedAt"] === "string"
          ? raw["startedAt"]
          : null
        const st = statSync(join(sessDir, file))
        const proc = procByPid.get(pid)
        const repoName = cwd ? basename(cwd) : null
        const project = resolveProject(cwd, meta.goal ?? name ?? repoName, projectCache)
        const baseTitle = name ?? meta.goal ?? repoName ?? `claude pid ${pid}`
        const titleWithTool = meta.lastTool && status === "working"
          ? `${baseTitle} [${meta.lastTool}]`
          : baseTitle
        results.push({
          sessionKey: `${nodeId}:claude:${sessionId}`,
          managed: false,
          harness: "claude",
          model: typeof raw["model"] === "string" ? raw["model"] : meta.model,
          accountLabel: label,
          repo: scrub(repoName, 120),
          project,
          lane: scrub(meta.gitBranch ?? name, 100),
          title: scrub(titleWithTool, 140),
          summary: meta.summary,
          cwd: scrub(cwd, 260),
          transcriptJson: meta.transcript.length > 0 ? meta.transcript : null,
          status,
          pid,
          cpuSeconds: proc?.cpuSeconds ?? null,
          tokensUsed: meta.tokensUsed,
          startedAt,
          lastActivityAt: meta.lastActivityAt ?? st.mtime.toISOString(),
          endedAt: null
        })
      } catch {
        // skip corrupt or vanished file
      }
    }
  }
  return results
}

const extractCodexMessageText = (content: unknown, skipPreamble: boolean): string | null => {
  if (typeof content === "string") {
    if (skipPreamble && isSystemPreamble(content)) return null
    return scrub(content, 360)
  }
  if (!Array.isArray(content)) return null
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue
    const p = part as Record<string, unknown>
    const text = typeof p["text"] === "string" ? p["text"] : null
    if (!text) continue
    if (skipPreamble && isSystemPreamble(text)) continue
    const clean = scrub(text, 360)
    if (clean) return clean
  }
  return null
}

const discoverCodexRollouts = (
  home: string,
  nodeId: string,
  activePids: ReadonlySet<number>,
  projectCache: Map<string, string | null>
): Array<SessionSnapshot> => {
  const results: Array<SessionSnapshot> = []
  const now = Date.now()
  const recentWindowMs = 20 * 60 * 1000
  const roots: Array<{ label: string; dir: string }> = [{ label: "codex-default", dir: join(home, ".codex") }]
  const acctRoot = join(home, ".smithers", "accounts")
  if (existsSync(acctRoot)) {
    try {
      for (const entry of readdirSync(acctRoot)) {
        if (entry.startsWith("codex-")) roots.push({ label: entry, dir: join(acctRoot, entry) })
      }
    } catch {
      // ignore
    }
  }
  const today = new Date()
  const yyyy = String(today.getFullYear())
  const mm = String(today.getMonth() + 1).padStart(2, "0")
  const dd = String(today.getDate()).padStart(2, "0")

  for (const { label, dir } of roots) {
    const dayDir = join(dir, "sessions", yyyy, mm, dd)
    if (!existsSync(dayDir)) continue
    let files: Array<string> = []
    try {
      files = readdirSync(dayDir).filter((f) => f.endsWith(".jsonl"))
    } catch {
      continue
    }
    for (const file of files) {
      try {
        const full = join(dayDir, file)
        const st = statSync(full)
        if (now - st.mtimeMs > recentWindowMs) continue

        const head = readHead(full, 32_000) ?? ""
        const tail = readTail(full, 64_000) ?? ""

        let model: string | null = null
        let cwd: string | null = null
        let tokensUsed: number | null = null
        let lastTitle: string | null = null
        let goal: string | null = null
        let startedAt: string | null = null
        let latestAssistantNote: string | null = null
        let latestToolNote: string | null = null
        const transcript: Array<TranscriptEntry> = []

        // Pass 1: HEAD for session_meta cwd, turn_context model, and first real user goal
        for (const line of head.split("\n")) {
          const trimmed = line.trim()
          if (!trimmed.startsWith("{")) continue
          try {
            const obj = JSON.parse(trimmed) as Record<string, unknown>
            const topType = typeof obj["type"] === "string" ? obj["type"] : ""
            const payload = (typeof obj["payload"] === "object" && obj["payload"] !== null
              ? obj["payload"]
              : obj) as Record<string, unknown>

            if (topType === "session_meta") {
              if (typeof payload["cwd"] === "string") cwd = payload["cwd"]
              if (typeof payload["timestamp"] === "string") startedAt = payload["timestamp"]
            } else if (topType === "turn_context") {
              if (typeof payload["cwd"] === "string") cwd = payload["cwd"]
              if (typeof payload["model"] === "string") model = payload["model"]
            } else if (topType === "event_msg" && payload["type"] === "thread_settings_applied") {
              const settings = (typeof payload["thread_settings"] === "object" && payload["thread_settings"] !== null
                ? payload["thread_settings"]
                : null) as Record<string, unknown> | null
              if (settings && typeof settings["model"] === "string") model = settings["model"]
            } else if (topType === "response_item" && payload["type"] === "message" && payload["role"] === "user") {
              if (!goal) {
                const text = extractCodexMessageText(payload["content"], true)
                if (text) goal = text
              }
            } else if (topType === "event_msg" && payload["type"] === "item_completed" && !goal) {
              const item = (typeof payload["item"] === "object" && payload["item"] !== null
                ? payload["item"]
                : null) as Record<string, unknown> | null
              if (item && item["type"] === "UserMessage") {
                const text = extractCodexMessageText(item["content"], true)
                if (text) goal = text
              }
            }
          } catch {
            // partial trailing line in head read
          }
        }

        // Pass 2: TAIL for token_count, latest assistant notes, user turns, and tool calls
        for (const line of tail.split("\n")) {
          const trimmed = line.trim()
          if (!trimmed.startsWith("{")) continue
          try {
            const obj = JSON.parse(trimmed) as Record<string, unknown>
            const topType = typeof obj["type"] === "string" ? obj["type"] : ""
            const ts = typeof obj["timestamp"] === "string" ? obj["timestamp"] : null
            const payload = (typeof obj["payload"] === "object" && obj["payload"] !== null
              ? obj["payload"]
              : obj) as Record<string, unknown>

            if (typeof payload["model"] === "string") model = payload["model"]
            if (typeof payload["cwd"] === "string") cwd = payload["cwd"]

            if (topType === "event_msg" && payload["type"] === "token_count") {
              const info = (typeof payload["info"] === "object" && payload["info"] !== null
                ? payload["info"]
                : null) as Record<string, unknown> | null
              const totalUsage = (info && typeof info["total_token_usage"] === "object" &&
                  info["total_token_usage"] !== null
                ? info["total_token_usage"]
                : null) as Record<string, unknown> | null
              if (totalUsage && typeof totalUsage["total_tokens"] === "number") {
                tokensUsed = totalUsage["total_tokens"]
              } else if (typeof payload["total_tokens"] === "number") {
                tokensUsed = payload["total_tokens"]
              }
            } else if (typeof payload["total_tokens"] === "number") {
              tokensUsed = payload["total_tokens"]
            }

            if (topType === "response_item") {
              const itemType = typeof payload["type"] === "string" ? payload["type"] : ""
              if (itemType === "message" && payload["role"] === "user") {
                const text = extractCodexMessageText(payload["content"], true)
                if (text) {
                  if (!goal) goal = text
                  pushTranscriptEntry(transcript, ts, "user", "user", text)
                }
              } else if (itemType === "message" && payload["role"] === "assistant") {
                const text = extractCodexMessageText(payload["content"], false)
                if (text) {
                  latestAssistantNote = text
                  pushTranscriptEntry(transcript, ts, "assistant", "assistant", text)
                }
              } else if (itemType === "custom_tool_call" || itemType === "function_call") {
                const toolName = typeof payload["name"] === "string" ? payload["name"] : "tool"
                const rawArgs = payload["input"] ?? payload["arguments"]
                const preview = formatToolPreview(toolName, rawArgs)
                lastTitle = `tool:${toolName}`
                latestToolNote = `${toolName}: ${preview}`
                pushTranscriptEntry(transcript, ts, "tool", toolName, preview)
              }
            }
          } catch {
            // partial leading line in tail read
          }
        }

        const ageMs = now - st.mtimeMs
        const isLive = ageMs < 90_000 || (activePids.size > 0 && ageMs < 5 * 60 * 1000)
        const id = file.replace(/\.jsonl$/, "").slice(-36)
        const project = resolveProject(cwd, goal, projectCache)
        const summary = buildSummary(goal, latestAssistantNote ?? latestToolNote)
        results.push({
          sessionKey: `${nodeId}:codex-rollout:${id}`,
          managed: false,
          harness: "codex",
          model,
          accountLabel: label,
          repo: cwd ? scrub(basename(cwd), 120) : null,
          project,
          lane: null,
          title: scrub(goal ?? lastTitle ?? (cwd ? basename(cwd) : id), 140),
          summary,
          cwd: scrub(cwd, 260),
          transcriptJson: transcript.length > 0 ? transcript.slice(-MAX_TRANSCRIPT_ITEMS) : null,
          status: isLive ? "working" : "idle",
          pid: null,
          cpuSeconds: null,
          tokensUsed,
          startedAt: startedAt ?? st.birthtime.toISOString(),
          lastActivityAt: st.mtime.toISOString(),
          endedAt: null
        })
      } catch {
        // ignore vanished file
      }
    }
  }
  return results
}

const inferDaemonProject = (cmd: string): string | null => {
  if (/mq\.py\b/.test(cmd)) return "smithersai/vibelang"
  if (/smithers-gateway|run-smithers-gateway\.mjs|(\/smthrs| smthrs )/.test(cmd)) return "smithersai/smithers"
  return inferProjectFromText(cmd)
}

const buildDaemonSummary = (cmd: string): string | null => {
  if (/mq\.py\b/.test(cmd)) return scrub(`vibelang merge queue daemon · ${cmd}`, 320)
  if (/run-smithers-gateway\.mjs/.test(cmd)) return scrub(`smithers gateway daemon · ${cmd}`, 320)
  if (/(\/smthrs| smthrs ) node\b/.test(cmd)) return scrub(`smithers node daemon · ${cmd}`, 320)
  if (/(\/smthrs| smthrs ) runner\b/.test(cmd)) return scrub(`smithers runner daemon · ${cmd}`, 320)
  return scrub(cmd, 320)
}

const discoverProcessSessions = (
  nodeId: string,
  procs: ReadonlyArray<ProcInfo>,
  existingPids: ReadonlySet<number>
): { sessions: Array<SessionSnapshot>; codexPids: Set<number>; agyProcs: Array<ProcInfo> } => {
  const results: Array<SessionSnapshot> = []
  const codexPids = new Set<number>()
  const agyProcs: Array<ProcInfo> = []
  const nowIso = new Date().toISOString()

  for (const proc of procs) {
    const { pid, cpuSeconds, command: cmd } = proc
    if (existingPids.has(pid)) continue

    if (/(?:^|\/)claude(?:\s|$)/.test(cmd) && !cmd.includes("claude-rr") && !cmd.includes("grep")) {
      const mMatch = /--model\s+([^\s]+)/.exec(cmd)
      results.push({
        sessionKey: `${nodeId}:claude-proc:${pid}`,
        managed: false,
        harness: "claude",
        model: mMatch ? mMatch[1] ?? null : null,
        accountLabel: null,
        repo: null,
        project: inferProjectFromText(cmd),
        lane: null,
        title: scrub(cmd.slice(0, 140), 140),
        summary: scrub(cmd, 320),
        cwd: null,
        transcriptJson: null,
        status: "working",
        pid,
        cpuSeconds,
        tokensUsed: null,
        startedAt: null,
        lastActivityAt: nowIso,
        endedAt: null
      })
    } else if (
      /\bcodex\b/i.test(cmd) && !cmd.includes("codex-rr") && !cmd.includes("grep") &&
      !cmd.includes("Codex Framework.framework") && !cmd.includes("Codex (")
    ) {
      codexPids.add(pid)
      const mMatch = /(?:-m|--model)\s+([^\s]+)/.exec(cmd)
      results.push({
        sessionKey: `${nodeId}:codex:${pid}`,
        managed: false,
        harness: "codex",
        model: mMatch ? mMatch[1] ?? null : null,
        accountLabel: null,
        repo: null,
        project: inferProjectFromText(cmd),
        lane: null,
        title: scrub(cmd.slice(0, 140), 140),
        summary: scrub(cmd, 320),
        cwd: null,
        transcriptJson: null,
        status: "working",
        pid,
        cpuSeconds,
        tokensUsed: null,
        startedAt: null,
        lastActivityAt: nowIso,
        endedAt: null
      })
    } else if (/(?:^|\/)agy(?:\s|$)/.test(cmd) && !cmd.includes("grep")) {
      agyProcs.push(proc)
    } else if (
      /(\/smthrs| smthrs ) (runner|ci|serve|node)/.test(cmd) ||
      /mq\.py (run|pool)/.test(cmd) ||
      /run-smithers-gateway\.mjs/.test(cmd)
    ) {
      results.push({
        sessionKey: `${nodeId}:daemon:${pid}`,
        managed: cmd.includes("runner serve") || cmd.includes("node serve"),
        harness: cmd.includes("smthrs") ? "smithers" : "daemon",
        model: null,
        accountLabel: null,
        repo: null,
        project: inferDaemonProject(cmd),
        lane: null,
        title: scrub(cmd.slice(0, 140), 140),
        summary: buildDaemonSummary(cmd),
        cwd: null,
        transcriptJson: null,
        status: "working",
        pid,
        cpuSeconds,
        tokensUsed: null,
        startedAt: null,
        lastActivityAt: nowIso,
        endedAt: null
      })
    }
  }
  return { sessions: results, codexPids, agyProcs }
}

const findWorkspacePathHint = (text: string): string | null => {
  const m = /(\/(?:Users|home)\/[^/\s"'`]+\/[A-Za-z0-9._-]+)/.exec(text)
  if (!m || !m[1]) return null
  const candidate = m[1]
  // Ignore hidden config dirs like ~/.gemini or ~/.claude
  const seg = basename(candidate)
  if (seg.startsWith(".")) return null
  return candidate
}

interface AgyTranscriptMeta {
  readonly model: string | null
  readonly tokensUsed: number | null
  readonly goal: string | null
  readonly summary: string | null
  readonly cwdHint: string | null
  readonly pathHints: string
  readonly transcript: ReadonlyArray<TranscriptEntry>
}

const inspectAgyTranscript = (transcriptPath: string, fallbackTitle: string | null): AgyTranscriptMeta => {
  const empty: AgyTranscriptMeta = {
    model: null,
    tokensUsed: null,
    goal: null,
    summary: buildSummary(fallbackTitle, null),
    cwdHint: null,
    pathHints: "",
    transcript: []
  }
  if (!existsSync(transcriptPath)) return empty

  const head = readHead(transcriptPath, 16_000)
  const tail = readTail(transcriptPath, 64_000)
  if (!head && !tail) return empty

  let model: string | null = null
  let tokensUsed = 0
  let sawTokens = false
  let goal: string | null = null
  let latestAssistantNote: string | null = null
  let latestThinkingNote: string | null = null
  let latestToolNote: string | null = null
  let cwdHint: string | null = null
  const hintParts: Array<string> = []
  const transcript: Array<TranscriptEntry> = []

  const notePathHint = (text: string): void => {
    if (!cwdHint) {
      const found = findWorkspacePathHint(text)
      if (found) cwdHint = found
    }
    if (hintParts.length < 6) {
      const s = scrub(text, 160)
      if (s) hintParts.push(s)
    }
  }

  // Pass 1: HEAD for first USER_INPUT goal and initial workspace hints
  if (head) {
    for (const line of head.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed.startsWith("{")) continue
      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>
        const entryType = typeof obj["type"] === "string" ? obj["type"] : ""
        if (entryType === "USER_INPUT") {
          const rawContent = typeof obj["content"] === "string"
            ? obj["content"]
            : typeof obj["text"] === "string"
            ? obj["text"]
            : null
          if (rawContent) {
            notePathHint(rawContent)
            if (!goal) {
              const cleaned = stripUserRequestTags(rawContent)
              if (cleaned && !isSystemPreamble(cleaned)) {
                goal = scrub(cleaned, 360)
              }
            }
          }
        } else if (entryType === "PLANNER_RESPONSE") {
          if (!model && typeof obj["model"] === "string") model = obj["model"]
          if (Array.isArray(obj["tool_calls"])) {
            for (const tc of obj["tool_calls"]) {
              if (typeof tc === "object" && tc !== null) {
                notePathHint(JSON.stringify(tc))
              }
            }
          }
        }
      } catch {
        // partial line at end of head read
      }
    }
  }

  // Pass 2: TAIL for real model, token usage, recent USER_INPUT / PLANNER_RESPONSE / tool_calls
  if (tail) {
    for (const line of tail.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed.startsWith("{")) continue
      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>
        const entryType = typeof obj["type"] === "string" ? obj["type"] : ""
        const ts = typeof obj["created_at"] === "string"
          ? obj["created_at"]
          : typeof obj["timestamp"] === "string"
          ? obj["timestamp"]
          : null

        if (entryType === "USER_INPUT") {
          const rawContent = typeof obj["content"] === "string"
            ? obj["content"]
            : typeof obj["text"] === "string"
            ? obj["text"]
            : null
          if (rawContent) {
            notePathHint(rawContent)
            const cleaned = stripUserRequestTags(rawContent)
            if (cleaned && !isSystemPreamble(cleaned)) {
              const text = scrub(cleaned, 360)
              if (text) {
                if (!goal) goal = text
                pushTranscriptEntry(transcript, ts, "user", "user", text)
              }
            }
          }
        } else if (entryType === "PLANNER_RESPONSE") {
          if (typeof obj["model"] === "string" && obj["model"].length > 0) {
            model = obj["model"]
          }
          const inp = typeof obj["input_tokens"] === "number" ? obj["input_tokens"] : 0
          const out = typeof obj["output_tokens"] === "number" ? obj["output_tokens"] : 0
          const cacheRead = typeof obj["cache_read_tokens"] === "number" ? obj["cache_read_tokens"] : 0
          const sum = inp + out + cacheRead
          if (sum > 0) {
            tokensUsed = Math.max(tokensUsed, sum)
            sawTokens = true
          }

          const responseText = typeof obj["content"] === "string"
            ? obj["content"]
            : typeof obj["response"] === "string"
            ? obj["response"]
            : null
          if (responseText && responseText.trim().length > 0) {
            const clean = scrub(responseText, 360)
            if (clean) {
              latestAssistantNote = clean
              pushTranscriptEntry(transcript, ts, "assistant", "assistant", clean)
            }
          } else if (typeof obj["thinking"] === "string" && obj["thinking"].trim().length > 0) {
            const cleanThinking = scrub(obj["thinking"], 360)
            if (cleanThinking) {
              latestThinkingNote = cleanThinking
              pushTranscriptEntry(transcript, ts, "assistant", "thinking", cleanThinking)
            }
          }

          if (Array.isArray(obj["tool_calls"])) {
            for (const rawTc of obj["tool_calls"]) {
              if (typeof rawTc !== "object" || rawTc === null) continue
              const tc = rawTc as Record<string, unknown>
              const toolName = typeof tc["name"] === "string" ? tc["name"] : "tool"
              const args = tc["args"] ?? tc["arguments"] ?? tc["input"]
              if (args !== undefined) {
                try {
                  notePathHint(typeof args === "string" ? args : JSON.stringify(args))
                } catch {
                  // ignore
                }
              }
              const preview = formatToolPreview(toolName, args)
              latestToolNote = `${toolName}: ${preview}`
              pushTranscriptEntry(transcript, ts, "tool", toolName, preview)
            }
          }
        }
      } catch {
        // partial first line in tail read
      }
    }
  }

  return {
    model,
    tokensUsed: sawTokens ? tokensUsed : null,
    goal,
    summary: buildSummary(goal ?? fallbackTitle, latestAssistantNote ?? latestToolNote ?? latestThinkingNote),
    cwdHint,
    pathHints: hintParts.join(" "),
    transcript: transcript.slice(-MAX_TRANSCRIPT_ITEMS)
  }
}

const discoverAgySessions = (
  home: string,
  nodeId: string,
  agyProcs: ReadonlyArray<ProcInfo>,
  projectCache: Map<string, string | null>
): Array<SessionSnapshot> => {
  const results: Array<SessionSnapshot> = []
  const targets: Array<{ harness: "agy-cli" | "agy-ide"; baseDir: string; db: string }> = [
    {
      harness: "agy-cli",
      baseDir: join(home, ".gemini", "antigravity-cli"),
      db: join(home, ".gemini", "antigravity-cli", "conversation_summaries.db")
    },
    {
      harness: "agy-ide",
      baseDir: join(home, ".gemini", "antigravity"),
      db: join(home, ".gemini", "antigravity", "conversation_summaries.db")
    }
  ]
  const activeCliProc = agyProcs[0] ?? null
  for (const { harness, baseDir, db } of targets) {
    if (!existsSync(db)) continue
    const query = "SELECT conversation_id, title, status, not_fully_idle, last_modified_time " +
      "FROM conversation_summaries " +
      "WHERE status = 'CASCADE_RUN_STATUS_RUNNING' " +
      "OR not_fully_idle = 1 " +
      "OR datetime(last_modified_time) >= datetime('now', '-60 minutes') " +
      "ORDER BY last_modified_time DESC LIMIT 30;"
    const out = runCmd("sqlite3", ["-json", `file:${db}?mode=ro&immutable=1`, query], 3000)
    if (!out || out.trim() === "") continue
    try {
      const rows = JSON.parse(out) as Array<Record<string, unknown>>
      for (const r of rows) {
        const id = typeof r["conversation_id"] === "string" ? r["conversation_id"] : ""
        if (!id) continue
        const rawStatus = typeof r["status"] === "string" ? r["status"] : ""
        const notFullyIdle = Number(r["not_fully_idle"] ?? 0) === 1
        const status: SessionSnapshot["status"] = rawStatus.includes("RUNNING")
          ? "working"
          : notFullyIdle
          ? "waiting"
          : "idle"
        const rawTime = typeof r["last_modified_time"] === "string" ? r["last_modified_time"] : null
        const parsedDate = rawTime ? new Date(rawTime.replace(" ", "T")) : null
        const lastIso = parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : null
        const rawTitle = typeof r["title"] === "string" && r["title"].length > 0 ? r["title"] : null
        const transcriptPath = join(baseDir, "brain", id, ".system_generated", "logs", "transcript.jsonl")
        const meta = inspectAgyTranscript(transcriptPath, rawTitle)
        const project = resolveProject(
          meta.cwdHint,
          `${rawTitle ?? ""} ${meta.goal ?? ""} ${meta.pathHints}`,
          projectCache
        )
        const repoName = meta.cwdHint ? basename(meta.cwdHint) : null
        results.push({
          sessionKey: `${nodeId}:${harness}:${id}`,
          managed: false,
          harness,
          model: meta.model ?? "gemini-4-neon",
          accountLabel: "google-antigravity",
          repo: scrub(repoName, 120),
          project,
          lane: null,
          title: scrub(rawTitle ?? meta.goal ?? `${harness} ${id.slice(0, 8)}`, 140),
          summary: meta.summary,
          cwd: scrub(meta.cwdHint, 260),
          transcriptJson: meta.transcript.length > 0 ? meta.transcript : null,
          status,
          pid: harness === "agy-cli" && status === "working" ? activeCliProc?.pid ?? null : null,
          cpuSeconds: harness === "agy-cli" && status === "working" ? activeCliProc?.cpuSeconds ?? null : null,
          tokensUsed: meta.tokensUsed,
          startedAt: null,
          lastActivityAt: lastIso,
          endedAt: null
        })
      }
    } catch {
      // ignore parse error
    }
  }
  return results
}

const discoverAccounts = (home: string, agyActiveCount: number): Array<AccountSnapshot> => {
  const results: Array<AccountSnapshot> = []
  const nowIso = new Date().toISOString()
  const limitsScript = join(home, ".claude", "skills", "smithers-fallback-agents", "limits.py")
  if (existsSync(limitsScript)) {
    const raw = runCmd("python3", [limitsScript, "--paid-only", "--fast", "--json"], 10_000)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as {
          claude?: Array<Record<string, unknown>>
          codex?: Array<Record<string, unknown>>
        }
        for (const item of parsed.claude ?? []) {
          const label = typeof item["label"] === "string" ? item["label"] : ""
          if (!label) continue
          const data = (typeof item["data"] === "object" && item["data"] !== null ? item["data"] : {}) as Record<
            string,
            unknown
          >
          const limits =
            (typeof data["limits"] === "object" && data["limits"] !== null ? data["limits"] : {}) as Record<
              string,
              Record<string, unknown> | undefined
            >
          const rr = (typeof item["rr"] === "object" && item["rr"] !== null ? item["rr"] : {}) as Record<
            string,
            unknown
          >
          const weeklyObj = limits["weekly_all"]
          const fiveObj = limits["five_hour"]
          const fableObj = limits["weekly_scoped:Fable"]
          const weeklyPct = typeof weeklyObj?.["percent"] === "number" ? weeklyObj["percent"] : null
          const fiveHourPct = typeof fiveObj?.["percent"] === "number" ? fiveObj["percent"] : null
          const scopedPct = typeof fableObj?.["percent"] === "number" ? fableObj["percent"] : null
          const resetsAt = typeof weeklyObj?.["resets_at"] === "string" ? weeklyObj["resets_at"] : null
          const coolObj = (typeof rr["cool"] === "object" && rr["cool"] !== null ? rr["cool"] : null) as
            | Record<string, unknown>
            | null
          const modelCools =
            (typeof rr["model_cools"] === "object" && rr["model_cools"] !== null ? rr["model_cools"] : {}) as Record<
              string,
              unknown
            >
          const coolReason = coolObj
            ? scrub(String(coolObj["reason"] ?? "cooling"), 120)
            : Object.keys(modelCools).length > 0
            ? scrub(`model cool: ${Object.keys(modelCools).join(", ")}`, 120)
            : null
          const coolUntil = typeof coolObj?.["until"] === "number"
            ? new Date(coolObj["until"] * 1000).toISOString()
            : typeof coolObj?.["until"] === "string"
            ? coolObj["until"]
            : null
          const authErr = item["status"] === "auth_error" || item["status"] === "unauthorized"
          const limitReached = (weeklyPct !== null && weeklyPct >= 100) || (scopedPct !== null && scopedPct >= 100)
          const status: AccountSnapshot["status"] = authErr
            ? "auth_expired"
            : limitReached
            ? "limit_reached"
            : coolReason !== null
            ? "cooling"
            : "ready"
          const grantsList = Array.isArray(data["grants"]) ? data["grants"] : null
          results.push({
            accountKey: `claude:${label}`,
            provider: "claude",
            label,
            plan: "max",
            status,
            fiveHourPct,
            weeklyPct,
            scopedPct,
            resetsAt,
            grantsJson: grantsList ? { grants: grantsList } : null,
            creditsBalance: null,
            activeSessions: typeof rr["active_runs"] === "number" ? rr["active_runs"] : 0,
            pools: Array.isArray(rr["pools"]) ? rr["pools"].map(String) : [],
            coolReason,
            coolUntil,
            checkedAt: nowIso
          })
        }
        for (const item of parsed.codex ?? []) {
          const label = typeof item["label"] === "string" ? item["label"] : ""
          if (!label) continue
          const data = (typeof item["data"] === "object" && item["data"] !== null ? item["data"] : {}) as Record<
            string,
            unknown
          >
          const rr = (typeof item["rr"] === "object" && item["rr"] !== null ? item["rr"] : {}) as Record<
            string,
            unknown
          >
          const weeklyPct = typeof data["used_percent"] === "number" ? data["used_percent"] : null
          const resetEpoch = typeof data["reset_at"] === "number" ? data["reset_at"] : null
          const resetsAt = resetEpoch !== null ? new Date(resetEpoch * 1000).toISOString() : null
          const coolObj = (typeof rr["cool"] === "object" && rr["cool"] !== null ? rr["cool"] : null) as
            | Record<string, unknown>
            | null
          const coolReason = coolObj ? scrub(String(coolObj["reason"] ?? "cooling"), 120) : null
          const coolUntil = typeof coolObj?.["until"] === "number"
            ? new Date(coolObj["until"] * 1000).toISOString()
            : null
          const authErr = item["status"] === "auth_error" || item["status"] === "unauthorized"
          const limitReached = Boolean(data["limit_reached"]) || (weeklyPct !== null && weeklyPct >= 100)
          const status: AccountSnapshot["status"] = authErr
            ? "auth_expired"
            : limitReached
            ? "limit_reached"
            : coolReason !== null
            ? "cooling"
            : "ready"
          results.push({
            accountKey: `codex:${label}`,
            provider: "codex",
            label,
            plan: typeof item["plan_type"] === "string"
              ? item["plan_type"]
              : typeof data["plan_type"] === "string"
              ? data["plan_type"]
              : "pro",
            status,
            fiveHourPct: null,
            weeklyPct,
            scopedPct: null,
            resetsAt,
            grantsJson: typeof data["reset_credits_available_count"] === "number"
              ? { resetCreditsAvailable: data["reset_credits_available_count"] }
              : null,
            creditsBalance: typeof data["credits_balance"] === "number" ? data["credits_balance"] : null,
            activeSessions: typeof rr["active_runs"] === "number" ? rr["active_runs"] : 0,
            pools: Array.isArray(rr["pools"]) ? rr["pools"].map(String) : [],
            coolReason,
            coolUntil,
            checkedAt: nowIso
          })
        }
      } catch {
        // ignore JSON parse failure
      }
    }
  }

  // Compliant Google / Antigravity account monitoring (local presence + active sessions + auth health; zero secrets)
  const agyTokenFile = join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token")
  const agyInstalled = runCmd("which", ["agy"], 2000) !== null || existsSync(join(home, ".local", "bin", "agy"))
  if (agyInstalled || existsSync(agyTokenFile) || agyActiveCount > 0) {
    results.push({
      accountKey: "google-agy:google-antigravity",
      provider: "google-agy",
      label: "google-antigravity",
      plan: "google-gemini-only",
      status: existsSync(agyTokenFile) ? "ready" : "unknown",
      fiveHourPct: null,
      weeklyPct: null,
      scopedPct: null,
      resetsAt: null,
      grantsJson: { policy: "google-models-only" },
      creditsBalance: null,
      activeSessions: agyActiveCount,
      pools: ["agy-gemini"],
      coolReason: null,
      coolUntil: null,
      checkedAt: nowIso
    })
  }
  return results
}

const runCfboxList = (
  home: string
): { readonly ok: boolean; readonly stdout: string; readonly held: string | null } | null => {
  const env: NodeJS.ProcessEnv = { ...process.env }
  const tokenFile = join(home, ".cfbox", "token")
  const urlFile = join(home, ".cfbox", "url")
  if (!env["CFBOX_TOKEN"] && existsSync(tokenFile)) {
    try {
      const token = readFileSync(tokenFile, "utf8").trim()
      if (token.length > 0) env["CFBOX_TOKEN"] = token
    } catch {
      // ignore unreadable token file
    }
  }
  if (!env["CFBOX_URL"] && existsSync(urlFile)) {
    try {
      const url = readFileSync(urlFile, "utf8").trim()
      if (url.length > 0) env["CFBOX_URL"] = url
    } catch {
      // ignore unreadable url file
    }
  }

  let cmd: string | null = null
  let args: Array<string> = []
  const macBin = join(home, ".vibe-orch", "bin", "cfbox")
  if (existsSync(macBin)) {
    cmd = macBin
    args = ["list", "--json"]
  } else {
    const cfboxDir = join(home, ".cfbox")
    if (existsSync(cfboxDir)) {
      try {
        const candidates = readdirSync(cfboxDir)
          .filter((f) => f.startsWith("cfbox-") && f.endsWith(".mjs"))
          .map((f) => ({ path: join(cfboxDir, f), mtime: statSync(join(cfboxDir, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime)
        const latest = candidates[0]?.path ??
          (existsSync(join(cfboxDir, "cfbox.mjs")) ? join(cfboxDir, "cfbox.mjs") : null)
        if (latest) {
          cmd = process.execPath
          args = [latest, "list", "--json"]
        }
      } catch {
        // ignore unreadable .cfbox dir
      }
    }
  }
  if (!cmd) return null
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: "utf8",
      timeout: 35_000,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    })
    return { ok: true, stdout, held: null }
  } catch (err) {
    const e = err as { readonly stdout?: string | Buffer; readonly stderr?: string | Buffer; readonly status?: number }
    const stdout = typeof e.stdout === "string" ? e.stdout : Buffer.isBuffer(e.stdout) ? e.stdout.toString("utf8") : ""
    const stderr = typeof e.stderr === "string" ? e.stderr : Buffer.isBuffer(e.stderr) ? e.stderr.toString("utf8") : ""
    const partial = stdout.trim().length > 0
    const reason = stderr.includes("no cfbox token")
      ? "cfbox token unavailable"
      : e.status === 125
      ? "cfbox partial worker timeout"
      : "cfbox list unavailable"
    return { ok: partial, stdout, held: reason }
  }
}

const mapCfboxState = (state: string): SessionSnapshot["status"] => {
  const s = state.toLowerCase()
  if (s === "running" || s === "starting" || s === "reserved") return "working"
  if (s === "failed" || s === "error") return "error"
  return "ended"
}

const inferCfboxProject = (owner: string | null, id: string): string | null =>
  inferProjectFromText(owner) ?? inferProjectFromText(id)

const discoverCfbox = (home: string): { host: HostSnapshot; sessions: ReadonlyArray<SessionSnapshot> } | null => {
  const run = runCfboxList(home)
  if (!run) return null
  const sessions: Array<SessionSnapshot> = []
  const nowIso = new Date().toISOString()
  const trimmed = run.stdout.trim()
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      const items = Array.isArray(parsed)
        ? parsed
        : (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as Record<string, unknown>)["jobs"])
          ? (parsed as Record<string, unknown>)["jobs"] as Array<unknown>
          : [])
      for (const raw of items) {
        if (typeof raw !== "object" || raw === null) continue
        const obj = raw as Record<string, unknown>
        const id = typeof obj["id"] === "string" ? obj["id"] : ""
        if (!id) continue
        const owner = typeof obj["owner"] === "string" ? obj["owner"] : null
        const image = typeof obj["image"] === "string" ? obj["image"] : "container"
        const state = typeof obj["state"] === "string" ? obj["state"] : "ended"
        const startedAt = typeof obj["startedAt"] === "string"
          ? obj["startedAt"]
          : typeof obj["started_at"] === "string"
          ? obj["started_at"]
          : null
        const lastContact = typeof obj["lastContactAt"] === "string"
          ? obj["lastContactAt"]
          : typeof obj["last_contact_at"] === "string"
          ? obj["last_contact_at"]
          : nowIso
        const laneLabel = scrub(owner, 100)
        sessions.push({
          sessionKey: `cloudflare-cfbox:cfbox:${id}`,
          managed: true,
          harness: "cfbox",
          model: null,
          accountLabel: null,
          repo: null,
          project: inferCfboxProject(owner, id),
          lane: laneLabel,
          title: scrub(`${image} (${id})`, 140),
          summary: scrub(`cfbox ${image} · ${laneLabel ?? id} (${state})`, 320),
          cwd: null,
          transcriptJson: null,
          status: mapCfboxState(state),
          pid: null,
          cpuSeconds: null,
          tokensUsed: null,
          startedAt,
          lastActivityAt: lastContact,
          endedAt: null
        })
      }
    } catch {
      // fall through if partial stdout is non-JSON
    }
  } else if (trimmed.length > 0) {
    // Columns: ID OWNER IMAGE CPU STATE STARTED LAST_CONTACT AGO
    for (const line of trimmed.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/)
      if (cols.length < 5) continue
      const [id, owner, image, , state] = cols
      if (!id || id.startsWith("-")) continue
      const laneLabel = scrub(owner, 100)
      const imgName = image ?? "container"
      const stateLabel = state ?? "ended"
      sessions.push({
        sessionKey: `cloudflare-cfbox:cfbox:${id}`,
        managed: true,
        harness: "cfbox",
        model: null,
        accountLabel: null,
        repo: null,
        project: inferCfboxProject(owner ?? null, id),
        lane: laneLabel,
        title: scrub(`${imgName} (${id})`, 140),
        summary: scrub(`cfbox ${imgName} · ${laneLabel ?? id} (${stateLabel})`, 320),
        cwd: null,
        transcriptJson: null,
        status: mapCfboxState(stateLabel),
        pid: null,
        cpuSeconds: null,
        tokensUsed: null,
        startedAt: null,
        lastActivityAt: nowIso,
        endedAt: null
      })
    }
  }
  return {
    host: {
      nodeId: "cloudflare-cfbox",
      name: "Cloudflare Sandboxes (cfbox)",
      kind: "cloudflare",
      labels: ["cloudflare", "serverless", "cfbox"],
      online: run.ok,
      held: run.held,
      load1: null,
      cpuCores: null,
      memUsedGb: null,
      memTotalGb: null,
      diskFreeGb: null,
      diskTotalGb: null,
      activeSessions: sessions.filter((s) => s.status !== "ended").length,
      runnerCapacity: 64,
      version: "cfbox"
    },
    sessions
  }
}

/**
 * Scrubbed read-only snapshot and recent activity for a single inspected local session.
 * @category models
 * @since 1.0.0
 */
export interface LocalInspection {
  readonly session: SessionSnapshot | null
  readonly recentEvents: ReadonlyArray<string>
}

/**
 * Read-only local observability inspection for a normal Claude Code, Codex, or AGY
 * session on this machine (scrubbed per OBS-5; never mutates the session).
 * @category collectors
 * @since 1.0.0
 */
export const inspectLocalSession = (config: CollectorConfig, query: string): LocalInspection => {
  const home = config.home ?? homedir()
  const procs = listProcs()
  const procByPid = new Map(procs.map((p) => [p.pid, p]))
  const projectCache = new Map<string, string | null>()
  const claude = discoverClaudeSessions(home, config.nodeId, procByPid, projectCache)
  const pids = new Set<number>(claude.map((s) => s.pid).filter((p): p is number => p !== null))
  const { sessions: procSessions, codexPids, agyProcs } = discoverProcessSessions(config.nodeId, procs, pids)
  const codexRollouts = discoverCodexRollouts(home, config.nodeId, codexPids, projectCache)
  const agy = discoverAgySessions(home, config.nodeId, agyProcs, projectCache)
  const all = [...claude, ...procSessions, ...codexRollouts, ...agy]
  const match = all.find((s) => s.sessionKey === query || s.sessionKey.includes(query)) ?? null
  if (!match) return { session: null, recentEvents: [] }

  const recentEvents: Array<string> = []
  if (match.transcriptJson && match.transcriptJson.length > 0) {
    for (const entry of match.transcriptJson.slice(-10)) {
      const prefix = entry.label ? `${entry.role}:${entry.label}` : entry.role
      recentEvents.push(`${prefix}: ${entry.text.slice(0, 120)}`)
    }
  } else if (match.harness === "claude") {
    const sessionId = match.sessionKey.split(":").slice(-1)[0] ?? ""
    const dirs = [join(home, ".claude")]
    const acctRoot = join(home, ".smithers", "accounts")
    if (existsSync(acctRoot)) {
      for (const e of readdirSync(acctRoot)) {
        if (e.startsWith("claude-")) dirs.push(join(acctRoot, e))
      }
    }
    for (const dir of dirs) {
      const sessFile = match.pid !== null ? join(dir, "sessions", `${match.pid}.json`) : ""
      if (sessFile && existsSync(sessFile)) {
        try {
          const raw = JSON.parse(readFileSync(sessFile, "utf8")) as Record<string, unknown>
          const cwd = typeof raw["cwd"] === "string" ? raw["cwd"] : null
          const meta = inspectClaudeTranscript(dir, cwd, sessionId)
          recentEvents.push(...meta.recentEvents)
          break
        } catch {
          // ignore
        }
      }
    }
  }
  return { session: match, recentEvents: recentEvents.slice(-10) }
}

/**
 * Builds the Effect `NodeCollectors` layer reading host metrics, sessions, accounts, and cfbox state.
 * @category layers
 * @since 1.0.0
 */
export const makeCollectorsLayer = (config: CollectorConfig) =>
  Layer.succeed(NodeCollectors, {
    collectHost: () =>
      Effect.sync(() => {
        const home = config.home ?? homedir()
        const disk = readDiskGb(home)
        const totalGb = Math.round((totalmem() / (1024 ** 3)) * 10) / 10
        const freeGb = Math.round((freemem() / (1024 ** 3)) * 10) / 10
        return {
          nodeId: config.nodeId,
          name: config.name,
          kind: config.kind,
          labels: [...config.labels],
          online: true,
          held: null,
          load1: Math.round((loadavg()[0] ?? 0) * 100) / 100,
          cpuCores: cpus().length,
          memUsedGb: Math.max(0, Math.round((totalGb - freeGb) * 10) / 10),
          memTotalGb: totalGb,
          diskFreeGb: disk.freeGb,
          diskTotalGb: disk.totalGb,
          activeSessions: 0,
          runnerCapacity: 0,
          version: config.version
        } satisfies HostSnapshot
      }),
    collectSessions: () =>
      Effect.sync(() => {
        const home = config.home ?? homedir()
        const procs = listProcs()
        const procByPid = new Map(procs.map((p) => [p.pid, p]))
        const projectCache = new Map<string, string | null>()
        const claude = discoverClaudeSessions(home, config.nodeId, procByPid, projectCache)
        const pids = new Set<number>(claude.map((s) => s.pid).filter((p): p is number => p !== null))
        const { sessions: procSessions, codexPids, agyProcs } = discoverProcessSessions(config.nodeId, procs, pids)
        const codexRollouts = discoverCodexRollouts(home, config.nodeId, codexPids, projectCache)
        const agy = discoverAgySessions(home, config.nodeId, agyProcs, projectCache)
        return [...claude, ...procSessions, ...codexRollouts, ...agy]
      }),
    collectAccounts: () =>
      Effect.sync(() => {
        const home = config.home ?? homedir()
        const procs = listProcs()
        const { agyProcs } = discoverProcessSessions(config.nodeId, procs, new Set())
        const projectCache = new Map<string, string | null>()
        const agy = discoverAgySessions(home, config.nodeId, agyProcs, projectCache)
        const agyWorking = agy.filter((s) => s.status === "working").length
        return discoverAccounts(home, agyWorking)
      }),
    collectCfbox: () => Effect.sync(() => discoverCfbox(config.home ?? homedir()))
  })

/**
 * Derives a stable, normalized host node identifier from the machine hostname.
 * @category helpers
 * @since 1.0.0
 */
export const defaultNodeId = (): string => hostname().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 64)
