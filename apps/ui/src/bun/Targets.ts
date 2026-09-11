/*
 * Targets through the Node sidecar (LOCAL-APP.md, "Targets: load and run").
 * The loader is the existing build-cli, run under the loader sandbox policy;
 * its JSON listing maps 1:1 onto `Target`. A run streams the CLI's stdout,
 * stderr and exit as frames on the `target-run:<runId>` WebSocket topic.
 */
import { existsSync, realpathSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import type { RepoWorkspace, TargetDefinition } from "@smthrs/rpc/LocalApp"
import { splitLabel } from "@smthrs/rpc/LocalApp"
import { criticalPath } from "@smthrs/rpc/TargetGraph"
import type { GraphEdge, NodeTiming, RunSummary, TargetRunEvent } from "@smthrs/rpc/TargetGraph"
import type { NodeSidecar } from "./Node"
import { currentSandboxHost, loaderPolicy, wrapSandbox } from "./Sandbox"
import type { SandboxHost, SandboxPaths } from "./Sandbox"

/** How long the loader may take before the query answers with a warning. */
export const QUERY_TIMEOUT_MS = 120_000

/**
 * The build-cli entry: SMITHERS_BUILD_CLI, else the nearest
 * packages/smithers/build/build-cli/src/main.js above this file. In the source tree that is
 * four levels up (apps/ui/src/bun); under `electrobun dev` and in a built
 * bundle this file runs from apps/ui/build/<target>/<App>.app/..., so the
 * walk keeps climbing until it leaves the bundle and reaches the checkout.
 * When nothing exists on disk, the four-level path is returned so the
 * missing-loader warning names where it was expected.
 */
export const resolveBuildCli = (
  env: Readonly<Record<string, string | undefined>> = Bun.env,
  fromDir: string = import.meta.dir,
  exists: (path: string) => boolean = existsSync
): string => {
  const explicit = env.SMITHERS_BUILD_CLI?.trim()
  if (explicit !== undefined && explicit !== "") return resolve(explicit)
  const packaged = resolve(fromDir, "..", "build-cli", "launcher.mjs")
  if (exists(packaged)) return packaged
  const fallback = resolve(fromDir, "..", "..", "..", "..", "packages", "smithers", "build", "build-cli", "src", "main.js")
  let dir = resolve(fromDir)
  while (true) {
    const candidate = resolve(dir, "packages", "smithers", "build", "build-cli", "src", "main.js")
    if (exists(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return fallback
    dir = parent
  }
}

/**
 * Makes the authoring surface shipped beside a packaged CLI the final
 * Node-resolution fallback. A repository's own node_modules still wins, but
 * a standalone checkout can execute against the exact @smthrs/targets bits
 * carried by the app instead of accidentally depending on this monorepo's
 * ancestor node_modules.
 */
export const buildCliNodePath = (
  cli: string,
  inherited: string | undefined = Bun.env.NODE_PATH,
  exists: (path: string) => boolean = existsSync
): string | undefined => {
  const nodeModules = resolve(dirname(cli), "node_modules")
  const authoringManifest = join(nodeModules, "@smthrs", "targets", "package.json")
  if (!exists(authoringManifest)) return inherited
  return inherited === undefined || inherited.trim() === "" ? nodeModules : `${nodeModules}${delimiter}${inherited}`
}

/**
 * The host variables a loader, target run or CI preview child keeps. These
 * children evaluate the repository's own WORKSPACE.ts / PACKAGE.ts and run its
 * build commands, so they get what a toolchain needs to resolve and cache, and
 * never the app's credentials (SMITHERS_CLOUD_TOKEN, GITHUB_TOKEN, cloud keys).
 */
export const BUILD_CLI_ENV_KEYS: ReadonlyArray<string> = [
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PATH",
  "TMPDIR",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "CI",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  // Toolchains installed outside their default homes.
  "CARGO_HOME",
  "RUSTUP_HOME",
  "GOPATH",
  "GOCACHE",
  "GOMODCACHE",
  "JAVA_HOME",
  "BUN_INSTALL",
  "PNPM_HOME"
]

/** The build-cli child environment: BUILD_CLI_ENV_KEYS from `source`, plus NODE_PATH. Never inherits the rest. */
export const buildCliEnvironment = (
  cli: string,
  source: Readonly<Record<string, string | undefined>> = process.env,
  exists: (path: string) => boolean = existsSync
): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const key of BUILD_CLI_ENV_KEYS) {
    const value = source[key]
    if (value !== undefined && value !== "") env[key] = value
  }
  const nodePath = buildCliNodePath(cli, source.NODE_PATH, exists)
  if (nodePath !== undefined && nodePath !== "") env.NODE_PATH = nodePath
  return env
}

/**
 * The paths the loader policy is built from. The temp dir is canonicalised:
 * seatbelt matches subpaths against real paths, and macOS hands out
 * /var/folders/... for /private/var/folders/..., which the profile would
 * otherwise deny.
 */
export const sandboxPathsFor = (repo: string): SandboxPaths => {
  let tmp = tmpdir()
  try {
    tmp = realpathSync(tmp)
  } catch {
    // The unresolved path is still the right one to allow.
  }
  return { repo, home: homedir(), tmpdir: tmp }
}

const isTargetRow = (
  value: unknown
): value is { label: string; target?: unknown; kinds?: unknown; summary?: unknown; featured?: unknown } =>
  typeof value === "object" && value !== null && typeof (value as { label?: unknown }).label === "string"

/**
 * The loader's `{ targets: [{ label, target, kinds, summary?, featured? }] }`
 * listing as Targets tagged with the workspace the loader ran in, or an
 * error message when the text is not that shape. `summary` and `featured`
 * are the declaration's own presentation (PACKAGE.ts `summary: "..."`,
 * `featured: true`); a row without them is a bare target.
 */
export const mapTargets = (stdout: string, workspace: string): { readonly targets: Array<TargetDefinition> } | { readonly error: string } => {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return { error: `The loader did not answer JSON: ${stdout.trim().slice(0, 200)}` }
  }
  if (typeof parsed !== "object" || parsed === null) return { error: "The loader answered a non-object." }
  const body = parsed as { targets?: unknown; message?: unknown; code?: unknown }
  if (!Array.isArray(body.targets)) {
    const message = typeof body.message === "string" ? body.message : "no targets[] in the loader's answer"
    return { error: typeof body.code === "string" ? `${body.code}: ${message}` : message }
  }
  return {
    targets: body.targets.filter(isTargetRow).map((row) => ({
      label: row.label,
      target: typeof row.target === "string" ? row.target : "",
      kinds: Array.isArray(row.kinds) ? row.kinds.filter((kind): kind is string => typeof kind === "string") : [],
      ...splitLabel(row.label),
      workspace,
      ...(typeof row.summary === "string" && row.summary !== "" ? { summary: row.summary } : {}),
      ...(row.featured === true ? { featured: true } : {})
    }))
  }
}

export interface TargetsQueryResult {
  readonly targets: Array<TargetDefinition>
  readonly warnings: Array<string>
  readonly durationMs: number
}

export interface TargetsQueryOptions {
  readonly repo: string
  /**
   * The detected workspaces the query fans out over (one loader run each,
   * cwd = join(repo, workspace.path)). Absent or empty queries the root alone.
   */
  readonly workspaces?: ReadonlyArray<RepoWorkspace>
  readonly node: NodeSidecar | null
  readonly cli?: string
  readonly sandboxHost?: SandboxHost
  readonly timeoutMs?: number
}

/** The directory a workspace's loader (and runner) executes in. */
export const workspaceCwd = (repo: string, workspace: string): string =>
  workspace === "." ? repo : join(repo, workspace)

/** One loader run at one workspace's cwd; errors come back as warnings, never a throw. */
const queryWorkspace = async (
  options: TargetsQueryOptions & { readonly node: NodeSidecar; readonly cli: string },
  workspace: string
): Promise<{ readonly targets: Array<TargetDefinition>; readonly warnings: Array<string> }> => {
  const warnings: Array<string> = []
  const cwd = workspaceCwd(options.repo, workspace)
  const wrapped = wrapSandbox(
    [options.node.path, options.cli, "query", "//...", "--format", "json"],
    loaderPolicy(sandboxPathsFor(cwd)),
    options.sandboxHost ?? currentSandboxHost()
  )
  let child: ReturnType<typeof Bun.spawn>
  try {
    const environment = buildCliEnvironment(options.cli)
    child = Bun.spawn([...wrapped.argv], {
      cwd,
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore"
    })
  } catch (error) {
    return { targets: [], warnings: [`The loader could not start: ${error instanceof Error ? error.message : String(error)}`] }
  }
  const timer = setTimeout(() => child.kill(), options.timeoutMs ?? QUERY_TIMEOUT_MS)
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout as ReadableStream).text(),
    new Response(child.stderr as ReadableStream).text()
  ])
  clearTimeout(timer)
  const mapped = mapTargets(stdout, workspace)
  if ("error" in mapped) {
    warnings.push(code === 0 ? mapped.error : `The loader exited ${code}: ${mapped.error}`)
    const trimmed = stderr.trim()
    if (trimmed !== "") warnings.push(trimmed.slice(0, 2000))
    return { targets: [], warnings }
  }
  if (code !== 0) warnings.push(`The loader exited ${code}.`)
  return { targets: mapped.targets, warnings }
}

/**
 * `node <cli> query '//...' --format json` once per detected workspace, each
 * at its own cwd under the loader policy and each with its own timeout. One
 * workspace's failure is a warning and never blocks the others.
 */
export const queryTargets = async (options: TargetsQueryOptions): Promise<TargetsQueryResult> => {
  const started = Date.now()
  const cli = options.cli ?? resolveBuildCli()
  const warnings: Array<string> = []
  const node = options.node
  if (node === null) {
    warnings.push("No Node.js >= 22.19 was found for the smithers-build loader (SMITHERS_NODE, PATH, nvm, homebrew).")
    return { targets: [], warnings, durationMs: Date.now() - started }
  }
  if (!existsSync(cli)) {
    warnings.push(`The smithers-build loader is missing at ${cli} (set SMITHERS_BUILD_CLI).`)
    return { targets: [], warnings, durationMs: Date.now() - started }
  }
  const workspaces = options.workspaces === undefined || options.workspaces.length === 0
    ? ["."]
    : options.workspaces.map((workspace) => workspace.path)
  // A lone root query keeps the historical, unprefixed warning text.
  const lone = workspaces.length === 1 && workspaces[0] === "."
  const settled = await Promise.all(
    workspaces.map(async (workspace) => ({ workspace, ...(await queryWorkspace({ ...options, node, cli }, workspace)) }))
  )
  const targets: Array<TargetDefinition> = []
  for (const result of settled) {
    targets.push(...result.targets)
    for (const warning of result.warnings) warnings.push(lone ? warning : `[${result.workspace}] ${warning}`)
  }
  return { targets, warnings, durationMs: Date.now() - started }
}

export type TargetRunStatus = "pending" | "running" | "done" | "failed"

export interface TargetRun {
  readonly runId: string
  readonly repoId: string
  readonly repo: string
  /** The detected workspace the run executes in ("." for the repo root). */
  readonly workspace: string
  /** The target label, or `<verb> <pattern>` for a pattern run. */
  readonly label: string
  readonly labels: ReadonlyArray<string>
  /** Set on a pattern run (`ci //packages/...`): the CLI resolves the pattern to its targets. */
  readonly verb?: string
  readonly pattern?: string
  readonly startedAt: number
  status: TargetRunStatus
  exitCode: number | null
}

export interface TargetRunnerOptions {
  readonly publish: (topic: string, message: unknown) => void
  readonly cli?: string
  /** A run nobody attached to starts on its own after this long. */
  readonly autoStartMs?: number
  readonly log?: (line: string) => void
  /**
   * Observes every recorded frame. A returned promise is awaited before the
   * next chunk of child output is read, so a journal that cannot keep up
   * paces the run instead of queueing every frame the child ever wrote.
   */
  readonly onEvent?: (run: TargetRun, event: TargetRunEvent) => void | Promise<void>
  /** Maximum pending/running children; default 4. */
  readonly maxActiveRuns?: number
  /** Maximum retained run handles; settled handles are evicted oldest-first. */
  readonly maxRetainedRuns?: number
  /** Grace between the termination signal and SIGKILL on the run's process group; default 2000. */
  readonly killGraceMs?: number
}

export class TargetRunCapacityError extends Error {
  readonly code = "target_run_capacity"
}

export interface TargetRunner {
  /** Registers an inert run. Persist its journal before calling `arm`. */
  readonly reserve: (run: {
    readonly repoId: string
    readonly repo: string
    readonly workspace: string
    readonly label: string
    /** The target's kinds from the snapshot; the first one is the verb a legacy declaration workspace runs it with. */
    readonly kinds?: ReadonlyArray<string>
    /** A pattern run: `<verb> <pattern> --ui plain`; `label` is then ignored for argv and reads `<verb> <pattern>`. */
    readonly verb?: string
    readonly pattern?: string
    readonly node: NodeSidecar; readonly edges?: ReadonlyArray<GraphEdge> }) => TargetRun
  /** Enables attach and schedules auto-start once; false if no longer pending or already armed. */
  readonly arm: (runId: string) => boolean
  /** Reserves and arms immediately for callers without a journal initialization step. */
  readonly start: TargetRunner["reserve"]
  /** A subscriber is listening: spawn now if armed and not yet started. */
  readonly attach: (runId: string) => boolean
  /**
   * Releases an unarmed reservation silently; cancels an armed run with
   * terminal frames. A running child gets the termination signal on its
   * process group, SIGKILL after the grace, and the promise settles only once
   * the run is no longer running.
   */
  readonly cancel: (runId: string) => Promise<boolean>
  /** Cancel pending runs and kill running children before revocation succeeds. */
  readonly revokeRepo: (repoId: string) => Promise<void>
  readonly get: (runId: string) => TargetRun | undefined
  /**
   * Closes admission synchronously (reserve throws, arm and attach refuse),
   * fails runs that never started, terminates every running process tree with
   * escalation, and settles once each run is reaped. Idempotent.
   */
  readonly stop: () => Promise<void>
}

export const runTopic = (runId: string): string => `target-run:${runId}`

const durationMs = (amount: string | undefined, unit: string | undefined): number | undefined => {
  if (amount === undefined) return undefined
  const number = Number(amount)
  if (!Number.isFinite(number)) return undefined
  return Math.round(unit === "s" ? number * 1000 : number)
}

export interface RunStdoutParser {
  readonly push: (type: "stdout" | "stderr", data: string, at?: number) => ReadonlyArray<TargetRunEvent>
  readonly finish: (at?: number) => ReadonlyArray<TargetRunEvent>
  readonly timings: () => ReadonlyArray<NodeTiming>
  readonly summary: () => RunSummary | undefined
}

/*
 * The CLI verbs a target kind maps to. The kinds come from `query --format
 * json` in the CLI's own order, so a target's first kind is the verb the
 * repository authored it for.
 */
const VERB_BY_KIND: Readonly<Record<string, string>> = {
  build: "build",
  test: "test",
  lint: "lint",
  run: "run",
  docs: "docs",
  review: "review"
}

/**
 * The argv that executes one target in a workspace.
 *
 * Two authoring surfaces, two forms. A WORKSPACE.ts (build-system) workspace
 * runs the bare-label form, `smithers-build <label>`, whose verb the target's
 * flavor implies. A legacy declaration-rooted workspace has no WORKSPACE.ts and the CLI
 * refuses that form there ("the bare-label form executes PACKAGE.ts targets;
 * this workspace has no WORKSPACE.ts"), so it runs `smithers-build <verb>
 * <label>` with the verb from the target's first kind. `--ui plain` goes on
 * BOTH forms, with an explicit human audience: the parser reads the plain renderer's `//label  status  ms`
 * lines, and the CLI's `auto` renderer picks `stream` (ANSI, no status
 * lines) whenever FORCE_COLOR reaches the child — which a Playwright
 * webserver, and any coloured terminal that launched the app, hands down.
 * Piped output and inherited agent/CI markers otherwise silence successful
 * progress. Failed runs then omit those targets and their totals entirely.
 * stdin is ignored, so this output policy never enables interactive prompts.
 */
export const runArgv = (
  cwd: string,
  label: string,
  kinds: ReadonlyArray<string>,
  exists: (path: string) => boolean = existsSync
): Array<string> => {
  const packageMode = exists(join(cwd, "WORKSPACE.ts")) || exists(join(cwd, ".smithers", "WORKSPACE.ts"))
  if (packageMode) return [label, "--audience", "human", "--ui", "plain"]
  const verb = kinds.map((kind) => VERB_BY_KIND[kind]).find((candidate) => candidate !== undefined) ?? "build"
  return [verb, label, "--audience", "human", "--ui", "plain"]
}

/**
 * The argv of a pattern run: the verb over the pattern, on either authoring
 * surface (`smithers-build ci '//packages/...'` is how CI runs everything).
 */
export const patternRunArgv = (verb: string, pattern: string): Array<string> => [verb, pattern, "--audience", "human", "--ui", "plain"]

/**
 * The argv that PLANS one target (`--plan --format json`), under the same
 * two-form rule as `runArgv`: the bare label in a WORKSPACE.ts workspace, the
 * verb-led form in a legacy declaration one — where the bare form is refused with the
 * same "no WORKSPACE.ts" answer the runner used to get.
 */
export const planArgv = (
  cwd: string,
  label: string,
  kinds: ReadonlyArray<string>,
  exists: (path: string) => boolean = existsSync
): Array<string> => {
  const packageMode = exists(join(cwd, "WORKSPACE.ts")) || exists(join(cwd, ".smithers", "WORKSPACE.ts"))
  if (packageMode) return [label, "--plan", "--format", "json"]
  const verb = kinds.map((kind) => VERB_BY_KIND[kind]).find((candidate) => candidate !== undefined) ?? "build"
  return [verb, label, "--plan", "--format", "json"]
}

/** Incrementally parses stable executor status/summary lines and JSON envelopes. */
export const createRunStdoutParser = (options: {
  readonly edges?: ReadonlyArray<GraphEdge>
  readonly startedAt: number
}): RunStdoutParser => {
  const buffers: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" }
  const nodes = new Map<string, NodeTiming>()
  let lastSummary: RunSummary | undefined
  const timing = (row: {
    readonly label: string
    readonly status: NodeTiming["status"]
    readonly at: number
    readonly startedAt?: number
    readonly endedAt?: number
    readonly durationMs?: number
    readonly key?: string
    readonly reason?: string
  }): NodeTiming => {
    const prior = nodes.get(row.label)
    const settled = !["pending", "running"].includes(row.status)
    const endedAt = settled ? row.endedAt ?? row.at : undefined
    const startedAt = row.startedAt ?? prior?.startedAt ?? (
      settled ? (endedAt ?? row.at) - (row.durationMs ?? 0) : row.status === "running" ? row.at : undefined
    )
    return {
      label: row.label,
      status: row.status,
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(endedAt === undefined ? {} : { endedAt }),
      ...(settled ? { durationMs: endedAt! - startedAt! } : {}),
      ...(row.key === undefined ? {} : { key: row.key }),
      ...(row.reason === undefined ? {} : { reason: row.reason })
    }
  }
  const parseSummary = (line: string, at: number): TargetRunEvent | undefined => {
    const head = /^\s*(\d+)\s+targets?:\s*(.*)$/i.exec(line)
    if (head === null) return undefined
    const rest = head[2]!
    const count = (status: string): number => Number(new RegExp(`(?:^|[,;]\\s*)?(\\d+)\\s+${status}\\b`, "i").exec(rest)?.[1] ?? 0)
    const elapsed = /\((\d+(?:\.\d+)?)\s*(ms|s)\)\s*$/.exec(rest)
    const failed = count("failed") + count("refused")
    lastSummary = {
      total: Number(head[1]), hit: count("hit"), ran: count("ran"), failed, skipped: count("skipped"),
      durationMs: durationMs(elapsed?.[1], elapsed?.[2]) ?? at - options.startedAt,
      ok: failed === 0,
      criticalPath: [...criticalPath([...nodes.values()], options.edges ?? [])]
    }
    return { type: "summary", summary: lastSummary, at }
  }
  const parseObject = (line: string, at: number): Array<TargetRunEvent> => {
    if (!line.trimStart().startsWith("{")) return []
    let value: unknown
    try { value = JSON.parse(line) } catch { return [] }
    if (typeof value !== "object" || value === null) return []
    const body = value as { targets?: unknown; summary?: unknown }
    if (!Array.isArray(body.targets)) return []
    const events: Array<TargetRunEvent> = []
    for (const item of body.targets) {
      if (typeof item !== "object" || item === null) continue
      const row = item as Record<string, unknown>
      if (typeof row.label !== "string" || typeof row.status !== "string") continue
      if (!["pending", "running", "hit", "ran", "failed", "skipped", "refused", "cancelled"].includes(row.status)) continue
      const ms = typeof row.durationMs === "number" ? row.durationMs : undefined
      const node = timing({
        label: row.label,
        status: row.status as NodeTiming["status"],
        at,
        ...(typeof row.startedAt === "number" ? { startedAt: row.startedAt } : {}),
        ...(typeof row.endedAt === "number" ? { endedAt: row.endedAt } : {}),
        ...(ms === undefined ? {} : { durationMs: ms }),
        ...(typeof row.key === "string" ? { key: row.key } : {}),
        ...(typeof row.reason === "string" ? { reason: row.reason } : {})
      })
      nodes.set(node.label, node)
      events.push({ type: "node", node, at })
    }
    return events
  }
  /*
   * The executor's trailing results block (its default TOON envelope):
   *   results[7]{label,target,status,durationMs,key}:
   *     "//packages/smithers/flows/canonical:fmt",Dprint,ran,393.87,ce0698…
   * It is the one place the RULE of each target is printed, so its rows
   * re-emit the node with `rule` set; status/duration/key agree with the
   * status lines already parsed.
   */
  let resultColumns: ReadonlyArray<string> | undefined
  const parseResults = (line: string, at: number): Array<TargetRunEvent> | undefined => {
    const head = /^\s*results\[\d+\]\{([^}]*)\}:\s*$/.exec(line)
    if (head !== null) {
      resultColumns = head[1]!.split(",").map((column) => column.trim())
      return []
    }
    if (resultColumns === undefined) return undefined
    const row = /^\s+"([^"]+)",(.*)$/.exec(line)
    if (row === null) {
      if (line.trim() !== "" && !/^\s/.test(line)) resultColumns = undefined
      return undefined
    }
    const cells = [row[1]!, ...row[2]!.split(",")]
    const record: Record<string, string> = {}
    resultColumns.forEach((column, index) => {
      record[column] = (cells[index] ?? "").trim()
    })
    const label = record.label
    const status = record.status
    if (label === undefined || !label.startsWith("//") || status === undefined) return []
    if (!["pending", "running", "hit", "ran", "failed", "skipped", "refused", "cancelled"].includes(status)) return []
    const ms = Number(record.durationMs)
    const prior = nodes.get(label)
    const node: NodeTiming = {
      ...timing({
        label,
        status: status as NodeTiming["status"],
        at,
        ...(prior?.startedAt === undefined ? {} : { startedAt: prior.startedAt }),
        ...(prior?.endedAt === undefined ? {} : { endedAt: prior.endedAt }),
        ...(Number.isFinite(ms) ? { durationMs: Math.round(ms) } : {}),
        ...(record.key === undefined || record.key === "" ? {} : { key: record.key }),
        ...(prior?.reason === undefined ? {} : { reason: prior.reason })
      }),
      ...(record.target === undefined || record.target === "" ? {} : { rule: record.target })
    }
    nodes.set(label, node)
    return [{ type: "node", node, at }]
  }
  const parseLine = (line: string, at: number): Array<TargetRunEvent> => {
    const fromResults = parseResults(line, at)
    if (fromResults !== undefined) return fromResults
    const fromJson = parseObject(line, at)
    if (fromJson.length > 0) return fromJson
    const summary = parseSummary(line, at)
    if (summary !== undefined) return [summary]
    const match = /^(\/\/\S+)\s+(pending|running|hit|ran|failed|skipped|refused|cancelled)\b(?:\s+(\d+(?:\.\d+)?)\s*(ms|s))?(?:\s+(.+))?\s*$/.exec(line)
    if (match === null) return []
    const status = match[2] as NodeTiming["status"]
    const ms = durationMs(match[3], match[4])
    const detail = match[5]?.trim()
    const key = /(?:^|\s)key[=:]\s*([^\s]+)/i.exec(detail ?? "")?.[1]
    const reason = (status === "failed" || status === "refused" || status === "skipped") && detail !== undefined ? detail : undefined
    const node = timing({ label: match[1]!, status, at, ...(ms === undefined ? {} : { durationMs: ms }), ...(key === undefined ? {} : { key }), ...(reason === undefined ? {} : { reason }) })
    nodes.set(node.label, node)
    return [{ type: "node", node, at }]
  }
  const push: RunStdoutParser["push"] = (type, data, at = Date.now()) => {
    buffers[type] += data
    const lines = buffers[type].split(/\r?\n/)
    buffers[type] = lines.pop() ?? ""
    return lines.flatMap((line) => parseLine(line, at))
  }
  return {
    push,
    finish: (at = Date.now()) => {
      const lines = [buffers.stdout, buffers.stderr].filter(Boolean)
      buffers.stdout = ""
      buffers.stderr = ""
      return lines.flatMap((line) => parseLine(line, at))
    },
    timings: () => [...nodes.values()],
    summary: () => lastSummary
  }
}

/** `node <cli> '<label>'` per run, streamed to the run's topic. */
export const createTargetRunner = (options: TargetRunnerOptions): TargetRunner => {
  const cli = options.cli ?? resolveBuildCli()
  const log = options.log ?? (() => {})
  interface Live {
    readonly run: TargetRun
    readonly node: NodeSidecar
    armed: boolean
    child: ReturnType<typeof Bun.spawn> | undefined
    timer: ReturnType<typeof setTimeout> | undefined
    /** Resolves once the exit frame is emitted; undefined until the child is spawned. */
    settled: Promise<void> | undefined
    termination: Promise<void> | undefined
    readonly readers: Array<ReadableStreamDefaultReader<Uint8Array>>
    readonly edges: ReadonlyArray<GraphEdge>
    readonly kinds: ReadonlyArray<string>
    readonly parser: RunStdoutParser
    summaryEmitted: boolean
    nextSeq: number
  }
  const runs = new Map<string, Live>()
  const maxActiveRuns = options.maxActiveRuns ?? 4
  const maxRetainedRuns = options.maxRetainedRuns ?? 64
  const killGraceMs = options.killGraceMs ?? 2000
  let stopped = false
  let stopPromise: Promise<void> | undefined

  /*
   * Every frame the backend records is stamped with a run-local monotonic
   * `seq` (@smthrs/rpc/TargetGraph). stdout/stderr/exit/error frames
   * carry no `at` of their own, so `seq` is the ONLY total order replay can
   * use; without it two frames in one millisecond — or any untimed frame —
   * are unordered by construction.
   */
  const emit = (run: TargetRun, frame: TargetRunEvent): void | Promise<void> => {
    const live = runs.get(run.runId)
    const sequenced = { ...frame, seq: live?.nextSeq ?? 0 } as TargetRunEvent
    if (live !== undefined) live.nextSeq += 1
    options.publish(runTopic(run.runId), { type: "target-run", runId: run.runId, frame: sequenced })
    return options.onEvent?.(run, sequenced)
  }

  const pump = async (stream: ReadableStream<Uint8Array>, live: Live, type: "stdout" | "stderr"): Promise<void> => {
    const decoder = new TextDecoder()
    const reader = stream.getReader()
    live.readers.push(reader)
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        const data = decoder.decode(value, { stream: true })
        if (data !== "") {
          const label = /^(\/\/\S+)/.exec(data)?.[1]
          // Backpressure: the next read waits for the consumer of this frame.
          await emit(live.run, { type, data, ...(label === undefined ? {} : { label }) })
          for (const event of live.parser.push(type, data)) {
            if (event.type === "summary") live.summaryEmitted = true
            await emit(live.run, event)
          }
        }
      }
      const rest = decoder.decode()
      if (rest !== "") {
        const label = /^(\/\/\S+)/.exec(rest)?.[1]
        await emit(live.run, { type, data: rest, ...(label === undefined ? {} : { label }) })
        for (const event of live.parser.push(type, rest)) await emit(live.run, event)
      }
    } finally {
      reader.releaseLock()
    }
  }

  /*
   * The child owns a process group (detached spawn), so one signal reaches
   * every descendant. A loader that swallows the termination signal, or a
   * descendant that keeps the output pipes open, is escalated to SIGKILL after
   * the grace; the readers are then cancelled so a stray pipe holder that left
   * the group cannot keep the run "running". Resolves once the run settled.
   */
  const signalTree = (child: ReturnType<typeof Bun.spawn>, signal: NodeJS.Signals): void => {
    try {
      process.kill(-child.pid, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
      try {
        child.kill(signal)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
      }
    }
  }

  const groupExists = (child: ReturnType<typeof Bun.spawn>): boolean => {
    try {
      process.kill(-child.pid, 0)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
      throw error
    }
  }

  const terminate = (live: Live): Promise<void> => live.termination ??= (async () => {
    const child = live.child
    const settled = live.settled
    if (child === undefined || settled === undefined) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), killGraceMs) })
    try {
      signalTree(child, "SIGTERM")
      if (await Promise.race([settled.then(() => true), deadline])) {
        // A parent can exit and close its streams while a silent descendant
        // still owns the process group. Give that descendant the same grace.
        if (!groupExists(child)) return
        await deadline
      }
      log(`target-run ${live.run.runId}: killing its process group after ${killGraceMs}ms (pid ${child.pid})`)
      signalTree(child, "SIGKILL")
      // Do not wait on inherited pipes: a descendant may have left the group.
      // Reader cancellation releases pending reads even if its source's
      // cancellation promise never settles. Reaping the child is still required.
      for (const reader of live.readers) void reader.cancel().catch(() => {})
      await settled
      // The host reaps its child; the OS reaps orphaned descendants. Observe
      // that the group is gone before reporting success, with a bounded wait.
      const reapDeadline = Date.now() + 2000
      while (groupExists(child)) {
        if (Date.now() >= reapDeadline) throw new Error(`Target process group ${child.pid} did not exit after SIGKILL.`)
        await Bun.sleep(10)
      }
    } finally {
      clearTimeout(timer)
      live.termination = undefined
    }
  })()

  const failBeforeStart = (live: Live, message: string): void => {
    if (live.timer !== undefined) clearTimeout(live.timer)
    live.timer = undefined
    live.run.status = "failed"
    emit(live.run, { type: "error", message })
    emit(live.run, { type: "exit", code: null })
  }

  const spawn = (live: Live): void => {
    if (stopped || !live.armed || live.run.status !== "pending") return
    if (live.timer !== undefined) clearTimeout(live.timer)
    live.timer = undefined
    live.run.status = "running"
    emit(live.run, { type: "started", runId: live.run.runId, label: live.run.label, labels: [...live.run.labels], at: live.run.startedAt })
    if (!existsSync(cli)) {
      live.run.status = "failed"
      emit(live.run, { type: "error", message: `The smithers-build loader is missing at ${cli} (set SMITHERS_BUILD_CLI).` })
      emit(live.run, { type: "exit", code: null })
      return
    }
    const cwd = workspaceCwd(live.run.repo, live.run.workspace)
    let child: ReturnType<typeof Bun.spawn>
    try {
      const argv = live.run.verb !== undefined && live.run.pattern !== undefined
        ? patternRunArgv(live.run.verb, live.run.pattern)
        : runArgv(cwd, live.run.label, live.kinds)
      const environment = buildCliEnvironment(cli)
      child = Bun.spawn([live.node.path, cli, ...argv], {
        cwd,
        env: environment,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        detached: true
      })
    } catch (error) {
      live.run.status = "failed"
      emit(live.run, { type: "error", message: error instanceof Error ? error.message : String(error) })
      emit(live.run, { type: "exit", code: null })
      return
    }
    live.child = child
    log(`target-run ${live.run.runId}: ${live.run.label} in ${workspaceCwd(live.run.repo, live.run.workspace)} (pid ${child.pid})`)
    live.settled = Promise.allSettled([
      pump(child.stdout as ReadableStream<Uint8Array>, live, "stdout"),
      pump(child.stderr as ReadableStream<Uint8Array>, live, "stderr")
    ])
      .then(() => child.exited)
      .then((code) => {
        for (const event of live.parser.finish()) {
          if (event.type === "summary") live.summaryEmitted = true
          emit(live.run, event)
        }
        if (!live.summaryEmitted) {
          const timings = [...live.parser.timings()]
          const count = (status: NodeTiming["status"]): number => timings.filter((node) => node.status === status).length
          const failed = count("failed") + count("refused")
          const summary: RunSummary = { total: timings.length, hit: count("hit"), ran: count("ran"), failed, skipped: count("skipped"), durationMs: Date.now() - live.run.startedAt, ok: code === 0 && failed === 0, criticalPath: [...criticalPath(timings, live.edges)] }
          emit(live.run, { type: "summary", summary, at: Date.now() })
        }
        live.run.exitCode = code
        live.run.status = code === 0 ? "done" : "failed"
        emit(live.run, { type: "exit", code })
      })
  }

  const reserve: TargetRunner["reserve"] = ({ repoId, repo, workspace, label, node, edges = [], kinds = [], verb, pattern }) => {
    if (stopped) throw new TargetRunCapacityError("The target runner is stopped.")
    const active = [...runs.values()].filter((live) => live.run.status === "pending" || live.run.status === "running" || live.termination !== undefined)
    if (active.length >= maxActiveRuns) {
      throw new TargetRunCapacityError(`At most ${maxActiveRuns} target runs may execute at once.`)
    }
    while (runs.size >= maxRetainedRuns) {
      const settled = [...runs].find(([, live]) => live.run.status !== "pending" && live.run.status !== "running" && live.termination === undefined)
      if (settled === undefined) {
        throw new TargetRunCapacityError(`At most ${maxRetainedRuns} target runs may be retained.`)
      }
      runs.delete(settled[0])
    }
    const startedAt = Date.now()
    const isPattern = verb !== undefined && pattern !== undefined
    const title = isPattern ? `${verb} ${pattern}` : label
    const labels = title.split(/\s+/).filter((part) => part.startsWith("//"))
    const run: TargetRun = {
      runId: crypto.randomUUID(), repoId, repo, workspace, label: title, labels, startedAt, status: "pending", exitCode: null,
      ...(isPattern ? { verb, pattern } : {})
    }
    const live: Live = { run, armed: false, node, edges, kinds, parser: createRunStdoutParser({ edges, startedAt }), child: undefined, timer: undefined, settled: undefined, termination: undefined, readers: [], summaryEmitted: false, nextSeq: 0 }
    runs.set(run.runId, live)
    return run
  }

  const arm: TargetRunner["arm"] = (runId) => {
    const live = runs.get(runId)
    if (stopped || live === undefined || live.armed || live.run.status !== "pending") return false
    live.armed = true
    live.timer = setTimeout(() => spawn(live), options.autoStartMs ?? 1000)
    return true
  }

  return {
    reserve,
    arm,
    start: (input) => {
      const run = reserve(input)
      arm(run.runId)
      return run
    },
    attach: (runId) => {
      const live = runs.get(runId)
      if (stopped || live === undefined || !live.armed) return false
      spawn(live)
      return true
    },
    cancel: async (runId) => {
      const live = runs.get(runId)
      if (live === undefined) return false
      if (live.run.status === "pending") {
        if (!live.armed) {
          runs.delete(runId)
          return true
        }
        failBeforeStart(live, "Cancelled before it started.")
        return true
      }
      if (live.run.status === "running" || live.termination !== undefined) {
        await terminate(live)
        return true
      }
      return false
    },
    revokeRepo: async (repoId) => {
      const exiting: Array<Promise<number>> = []
      for (const live of runs.values()) {
        if (live.run.repoId !== repoId) continue
        if (live.run.status === "pending") {
          failBeforeStart(live, "Repository access was revoked.")
        } else if (live.run.status === "running" && live.child !== undefined) {
          signalTree(live.child, "SIGKILL")
          exiting.push(live.child.exited)
        }
      }
      await Promise.all(exiting)
    },
    get: (runId) => runs.get(runId)?.run,
    stop: () => stopPromise ??= (async () => {
      stopped = true
      const reaping: Array<Promise<void>> = []
      for (const live of runs.values()) {
        if (live.timer !== undefined) clearTimeout(live.timer)
        live.timer = undefined
        if (live.run.status === "pending" && live.armed) failBeforeStart(live, "Cancelled: the app is shutting down.")
        else if (live.run.status === "pending") runs.delete(live.run.runId)
        else if (live.run.status === "running" || live.termination !== undefined) reaping.push(terminate(live))
      }
      const results = await Promise.allSettled(reaping)
      const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
      if (errors.length > 0) throw new AggregateError(errors, "Target runner shutdown failed.")
    })()
  }
}
