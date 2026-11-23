/**
 * Platform-side read-only collectors for `smthrs node serve`, `smthrs node overview --local`,
 * and `smthrs node inspect`.
 *
 * Strictly read-only: users continue running normal interactive `claude`, `codex`, `agy`,
 * and Antigravity IDE sessions without wrappers or mutation, while the running Smithers
 * node client gives full observability (model, account, branch/lane, repo, status, PID,
 * CPU seconds, tokens, recent tool activity, scrubbed titles) locally and synced to
 * `https://smithers.sh/app/fleet` over BYOA MCP-over-HTTP.
 *
 * OBS-5: every title, command, and event snippet is scrubbed before returning so tokens,
 * secrets, API keys, and credentials never leave the machine.
 * @since 1.0.0
 */

import { Effect, Layer } from "effect"
import { execFileSync } from "node:child_process"
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs"
import { cpus, freemem, homedir, hostname, loadavg, totalmem } from "node:os"
import { basename, join } from "node:path"
import { type AccountSnapshot, type HostSnapshot, NodeCollectors, type SessionSnapshot } from "./NodeDaemon.vibe"

const SECRET_RE =
  /(gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-ant-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{16,}|sma_[0-9a-f]{32,}|xox[baprs]-[A-Za-z0-9-]+|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._-]{12,}|(?:TOKEN|SECRET|PASSWORD|API_KEY)\s*=\s*\S+)/gi

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

/** Reads at most the trailing `maxBytes` of a file without loading large transcripts into memory. */
const readTail = (filePath: string, maxBytes = 32_768): string | null => {
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

const encodeClaudeProjectPath = (cwd: string): string => cwd.replace(/[/.]/g, "-")

interface TranscriptMeta {
  readonly model: string | null
  readonly gitBranch: string | null
  readonly tokensUsed: number | null
  readonly lastTool: string | null
  readonly lastActivityAt: string | null
  readonly inferredStatus: SessionSnapshot["status"] | null
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
    recentEvents: []
  }
  if (!cwd) return empty
  const jsonlPath = join(configDir, "projects", encodeClaudeProjectPath(cwd), `${sessionId}.jsonl`)
  if (!existsSync(jsonlPath)) return empty
  const tail = readTail(jsonlPath, 48_000)
  if (!tail) return empty

  let model: string | null = null
  let gitBranch: string | null = null
  let tokensUsed = 0
  let sawTokens = false
  let lastTool: string | null = null
  let lastActivityAt: string | null = null
  let inferredStatus: SessionSnapshot["status"] | null = null
  const recentEvents: Array<string> = []

  for (const line of tail.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("{")) continue
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>
      if (typeof obj["gitBranch"] === "string" && obj["gitBranch"].length > 0) {
        gitBranch = obj["gitBranch"]
      }
      if (typeof obj["timestamp"] === "string") {
        lastActivityAt = obj["timestamp"]
      }
      const msg = (typeof obj["message"] === "object" && obj["message"] !== null
        ? obj["message"]
        : null) as Record<string, unknown> | null
      if (msg) {
        if (typeof msg["model"] === "string" && !msg["model"].startsWith("<")) model = msg["model"]
        const usage = (typeof msg["usage"] === "object" && msg["usage"] !== null
          ? msg["usage"]
          : null) as Record<string, unknown> | null
        if (usage) {
          const inp = typeof usage["input_tokens"] === "number" ? usage["input_tokens"] : 0
          const out = typeof usage["output_tokens"] === "number" ? usage["output_tokens"] : 0
          const cacheRead = typeof usage["cache_read_input_tokens"] === "number" ? usage["cache_read_input_tokens"] : 0
          const cacheCreate = typeof usage["cache_creation_input_tokens"] === "number"
            ? usage["cache_creation_input_tokens"]
            : 0
          const sum = inp + out + cacheRead + cacheCreate
          if (sum > 0) {
            tokensUsed = Math.max(tokensUsed, sum)
            sawTokens = true
          }
        }
        const content = msg["content"]
        if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block === "object" && block !== null) {
              const b = block as Record<string, unknown>
              if (b["type"] === "tool_use" && typeof b["name"] === "string") {
                lastTool = b["name"]
                inferredStatus = "working"
                recentEvents.push(`tool:${b["name"]}`)
              } else if (b["type"] === "text" && typeof b["text"] === "string") {
                const snippet = scrub(b["text"], 90)
                if (snippet) recentEvents.push(`${String(msg["role"] ?? obj["type"] ?? "msg")}: ${snippet}`)
              }
            }
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
  return {
    model,
    gitBranch,
    tokensUsed: sawTokens ? tokensUsed : null,
    lastTool,
    lastActivityAt,
    inferredStatus,
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
  procByPid: ReadonlyMap<number, ProcInfo>
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
        const baseTitle = name ?? repoName ?? `claude pid ${pid}`
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
          lane: scrub(meta.gitBranch ?? name, 100),
          title: scrub(titleWithTool, 140),
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

const discoverCodexRollouts = (
  home: string,
  nodeId: string,
  activePids: ReadonlySet<number>
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
        const tail = readTail(full, 24_000) ?? ""
        let model: string | null = null
        let cwd: string | null = null
        let tokensUsed: number | null = null
        let lastTitle: string | null = null
        for (const line of tail.split("\n")) {
          const trimmed = line.trim()
          if (!trimmed.startsWith("{")) continue
          try {
            const obj = JSON.parse(trimmed) as Record<string, unknown>
            const payload = (typeof obj["payload"] === "object" && obj["payload"] !== null
              ? obj["payload"]
              : obj) as Record<string, unknown>
            if (typeof payload["model"] === "string") model = payload["model"]
            if (typeof payload["cwd"] === "string") cwd = payload["cwd"]
            if (typeof payload["total_tokens"] === "number") tokensUsed = payload["total_tokens"]
            if (typeof payload["name"] === "string") lastTitle = `tool:${payload["name"]}`
          } catch {
            // partial line
          }
        }
        const ageMs = now - st.mtimeMs
        const isLive = ageMs < 90_000 || activePids.size > 0 && ageMs < 5 * 60 * 1000
        const id = file.replace(/\.jsonl$/, "").slice(-36)
        results.push({
          sessionKey: `${nodeId}:codex-rollout:${id}`,
          managed: false,
          harness: "codex",
          model,
          accountLabel: label,
          repo: cwd ? scrub(basename(cwd), 120) : null,
          lane: null,
          title: scrub(lastTitle ?? (cwd ? basename(cwd) : id), 140),
          status: isLive ? "working" : "idle",
          pid: null,
          cpuSeconds: null,
          tokensUsed,
          startedAt: st.birthtime.toISOString(),
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
        lane: null,
        title: scrub(cmd.slice(0, 140), 140),
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
        lane: null,
        title: scrub(cmd.slice(0, 140), 140),
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
        lane: null,
        title: scrub(cmd.slice(0, 140), 140),
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

const discoverAgySessions = (
  home: string,
  nodeId: string,
  agyProcs: ReadonlyArray<ProcInfo>
): Array<SessionSnapshot> => {
  const results: Array<SessionSnapshot> = []
  const targets: Array<{ harness: "agy-cli" | "agy-ide"; db: string }> = [
    { harness: "agy-cli", db: join(home, ".gemini", "antigravity-cli", "conversation_summaries.db") },
    { harness: "agy-ide", db: join(home, ".gemini", "antigravity", "conversation_summaries.db") }
  ]
  const activeCliProc = agyProcs[0] ?? null
  for (const { harness, db } of targets) {
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
        results.push({
          sessionKey: `${nodeId}:${harness}:${id}`,
          managed: false,
          harness,
          model: "gemini-4-neon",
          accountLabel: "google-antigravity",
          repo: null,
          lane: null,
          title: scrub(
            typeof r["title"] === "string" && r["title"].length > 0
              ? r["title"]
              : `${harness} ${id.slice(0, 8)}`,
            140
          ),
          status,
          pid: harness === "agy-cli" && status === "working" ? activeCliProc?.pid ?? null : null,
          cpuSeconds: harness === "agy-cli" && status === "working" ? activeCliProc?.cpuSeconds ?? null : null,
          tokensUsed: null,
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
    return { ok: partial, stdout, held: partial ? reason : reason }
  }
}

const mapCfboxState = (state: string): SessionSnapshot["status"] => {
  const s = state.toLowerCase()
  if (s === "running" || s === "starting" || s === "reserved") return "working"
  if (s === "failed" || s === "error") return "error"
  return "ended"
}

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
        sessions.push({
          sessionKey: `cloudflare-cfbox:cfbox:${id}`,
          managed: true,
          harness: "cfbox",
          model: null,
          accountLabel: null,
          repo: null,
          lane: scrub(owner, 100),
          title: scrub(`${image} (${id})`, 140),
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
      sessions.push({
        sessionKey: `cloudflare-cfbox:cfbox:${id}`,
        managed: true,
        harness: "cfbox",
        model: null,
        accountLabel: null,
        repo: null,
        lane: scrub(owner, 100),
        title: scrub(`${image ?? "container"} (${id})`, 140),
        status: mapCfboxState(state ?? "ended"),
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
  const claude = discoverClaudeSessions(home, config.nodeId, procByPid)
  const pids = new Set<number>(claude.map((s) => s.pid).filter((p): p is number => p !== null))
  const { sessions: procSessions, codexPids, agyProcs } = discoverProcessSessions(config.nodeId, procs, pids)
  const codexRollouts = discoverCodexRollouts(home, config.nodeId, codexPids)
  const agy = discoverAgySessions(home, config.nodeId, agyProcs)
  const all = [...claude, ...procSessions, ...codexRollouts, ...agy]
  const match = all.find((s) => s.sessionKey === query || s.sessionKey.includes(query)) ?? null
  if (!match) return { session: null, recentEvents: [] }

  const recentEvents: Array<string> = []
  if (match.harness === "claude") {
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
  } else if (match.harness === "agy-cli" || match.harness === "agy-ide") {
    const convId = match.sessionKey.split(":").slice(-1)[0] ?? ""
    const baseDir = match.harness === "agy-cli" ? ".gemini/antigravity-cli" : ".gemini/antigravity"
    const transcript = join(home, baseDir, "brain", convId, ".system_generated", "logs", "transcript.jsonl")
    const tail = existsSync(transcript) ? readTail(transcript, 16_000) : null
    if (tail) {
      for (const line of tail.split("\n").slice(-10)) {
        const clean = scrub(line, 120)
        if (clean) recentEvents.push(clean)
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
        const claude = discoverClaudeSessions(home, config.nodeId, procByPid)
        const pids = new Set<number>(claude.map((s) => s.pid).filter((p): p is number => p !== null))
        const { sessions: procSessions, codexPids, agyProcs } = discoverProcessSessions(config.nodeId, procs, pids)
        const codexRollouts = discoverCodexRollouts(home, config.nodeId, codexPids)
        const agy = discoverAgySessions(home, config.nodeId, agyProcs)
        return [...claude, ...procSessions, ...codexRollouts, ...agy]
      }),
    collectAccounts: () =>
      Effect.sync(() => {
        const home = config.home ?? homedir()
        const procs = listProcs()
        const { agyProcs } = discoverProcessSessions(config.nodeId, procs, new Set())
        const agy = discoverAgySessions(home, config.nodeId, agyProcs)
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
