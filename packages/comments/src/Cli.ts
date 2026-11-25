/**
 * Command-line entry point and argument parser for all smithers-comments subcommands.
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import * as Agent from "./Agent.ts"
import * as Cache from "./Cache.ts"
import * as Config from "./Config.ts"
import { atomicWrite } from "./internal/FsSafe.ts"
import * as Repository from "./internal/Repository.ts"

const VERSION = "0.1.0"

const HELP_TEXT = `smithers-comments v${VERSION} — Agentic comment workflows powered by Smithers

Usage:
  smithers-comments <command> [paths...] [options]

Commands:
  init       Initialize .smithers/comments.json (inline or external mode)
  check      Validate comments structurally and semantically (cached via Smithers)
  lint       Alias for check
  fix        Run the agentic workflow to repair stale or broken comments
  extract    Move prose comments from source files into the external comments folder
  render     Project source + external comments into commented virtual files
  status     Show active mode, comment counts, and Smithers cache statistics

Global options:
  --cwd <dir>              Repository root directory
  --config <path>          Config file path (default .smithers/comments.json)
  --mode <inline|external> Override configured mode
  --dir <path>             Override commentsDir (default .comments)
  --cache <path>           Override cache file path
  --no-cache               Ignore cached verdicts for this run
  --offline                Use deterministic local heuristic validator
  --json                   Emit machine-readable JSON output
  -h, --help               Show this help text
  -v, --version            Show version
`

/**
 * Injectable working directory and output writers for running the CLI programmatically.
 *
 * @since 1.0.0
 * @category models
 */
export interface CliIoOptions {
  readonly cwd?: string
  readonly stdout?: (text: string) => void
  readonly stderr?: (text: string) => void
}

interface ParsedArgs {
  readonly command: string | undefined
  readonly positionals: ReadonlyArray<string>
  readonly flags: ReadonlyMap<string, string | boolean>
}

const VALUE_FLAGS = new Set(["--cwd", "--config", "--mode", "--dir", "--cache", "--file", "--out"])
const BOOL_FLAGS = new Set([
  "--help",
  "-h",
  "--version",
  "-v",
  "--no-cache",
  "--offline",
  "--json",
  "--strict",
  "--dry-run",
  "--force",
  "--in-place",
  "--remove-sidecars",
  "--check"
])
const KNOWN_COMMANDS = new Set(["init", "check", "lint", "fix", "extract", "render", "status"])

const parseArgs = (
  argv: ReadonlyArray<string>
): { readonly ok: true; readonly args: ParsedArgs } | { readonly ok: false; readonly error: string } => {
  let command: string | undefined
  const positionals: Array<string> = []
  const flags = new Map<string, string | boolean>()

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token === "--") {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (VALUE_FLAGS.has(token)) {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith("-")) {
        return { ok: false, error: `Missing value for flag ${token}` }
      }
      flags.set(token, next)
      i++
      continue
    }
    if (BOOL_FLAGS.has(token)) {
      flags.set(token, true)
      continue
    }
    if (token.startsWith("-")) {
      return { ok: false, error: `Unknown flag: ${token}` }
    }
    if (command === undefined) command = token
    else positionals.push(token)
  }

  return { ok: true, args: { command, positionals, flags } }
}

const selectAgentLayer = (
  engine: Config.AgentEngine,
  cwd: string
): { readonly ok: true; readonly layer: Layer.Layer<Agent.AgentValidator> } | {
  readonly ok: false
  readonly message: string
} => {
  if (engine === "none") return { ok: true, layer: Agent.noopLayer }
  if (engine === "heuristic") return { ok: true, layer: Agent.heuristicLayer }
  const cmd = process.env.SMITHERS_COMMENTS_AGENT_CMD?.trim()
  if (cmd && cmd.length > 0) {
    const parts = cmd.split(/\s+/)
    return {
      ok: true,
      layer: Agent.commandAgentLayer({ command: parts[0]!, args: parts.slice(1), cwd })
    }
  }
  return {
    ok: false,
    message:
      "agent is set to 'smithers', but SMITHERS_COMMENTS_AGENT_CMD is not configured. Pass --offline for deterministic local checks or configure a live agent command."
  }
}

/**
 * Executes a smithers-comments CLI invocation as an Effect returning its process exit code.
 *
 * @since 1.0.0
 * @category cli
 */
export const runCli = (argv: ReadonlyArray<string>, options?: CliIoOptions): Effect.Effect<number> =>
  Effect.gen(function*() {
    const stdout = options?.stdout ?? ((s: string) => process.stdout.write(s))
    const stderr = options?.stderr ?? ((s: string) => process.stderr.write(s))

    const parsedRes = parseArgs(argv)
    if (!parsedRes.ok) {
      stderr(`smithers-comments: ${parsedRes.error}\n`)
      return 2
    }

    const { command, positionals, flags } = parsedRes.args
    if (flags.get("--version") === true || flags.get("-v") === true) {
      stdout(`${VERSION}\n`)
      return 0
    }
    if (flags.get("--help") === true || flags.get("-h") === true || command === undefined) {
      stdout(HELP_TEXT)
      return 0
    }
    if (!KNOWN_COMMANDS.has(command)) {
      stderr(`smithers-comments: unknown command '${command}'\n`)
      return 2
    }

    const cwd = (flags.get("--cwd") as string | undefined) ?? options?.cwd ?? process.cwd()
    const configFlag = flags.get("--config") as string | undefined
    const modeFlag = flags.get("--mode") as string | undefined
    const dirFlag = flags.get("--dir") as string | undefined
    const cacheFlag = flags.get("--cache") as string | undefined
    const jsonOut = flags.get("--json") === true
    const offline = flags.get("--offline") === true
    const noCache = flags.get("--no-cache") === true

    if (modeFlag !== undefined && modeFlag !== "inline" && modeFlag !== "external") {
      stderr(`smithers-comments: invalid --mode '${modeFlag}' (expected inline or external)\n`)
      return 2
    }

    if (command === "init") {
      const mode: Config.Mode = modeFlag ?? "inline"
      const dirRes = yield* Effect.result(Config.validateCommentsDir(dirFlag ?? ".comments"))
      if (dirRes._tag === "Failure") {
        stderr(`smithers-comments: ${dirRes.failure.message}\n`)
        return 2
      }
      const commentsDir = dirRes.success
      const configRel = configFlag ?? ".smithers/comments.json"
      const configAbs = Path.isAbsolute(configRel) ? configRel : Path.join(cwd, configRel)
      const force = flags.get("--force") === true

      const exists = yield* Effect.tryPromise({
        try: () => Fs.access(configAbs).then(() => true),
        catch: () => false
      }).pipe(Effect.catch(() => Effect.succeed(false)))

      if (exists && !force) {
        stderr(`smithers-comments: ${configRel} already exists (pass --force to overwrite)\n`)
        return 3
      }

      const nextConfig: Config.CommentsConfig = { ...Config.defaultConfig, mode, commentsDir }
      const writeRes = yield* Effect.result(
        Effect.tryPromise({
          try: async () => {
            await atomicWrite(configAbs, JSON.stringify(nextConfig, null, 2) + "\n")
            if (mode === "external") {
              await Fs.mkdir(Path.join(cwd, commentsDir), { recursive: true })
            }
          },
          catch: (e) => (e instanceof Error ? e : new Error(String(e)))
        })
      )
      if (writeRes._tag === "Failure") {
        stderr(`smithers-comments: init failed: ${writeRes.failure.message}\n`)
        return 3
      }

      if (jsonOut) {
        stdout(JSON.stringify({ configPath: configRel, mode, commentsDir }, null, 2) + "\n")
      } else {
        stdout(`Initialized ${configRel} (mode: ${mode}, commentsDir: ${commentsDir})\n`)
      }
      return 0
    }

    const loadedRes = yield* Effect.result(Config.loadConfig(cwd, configFlag))
    if (loadedRes._tag === "Failure") {
      stderr(`smithers-comments: ${loadedRes.failure.message}\n`)
      return 2
    }

    let commentsDir = loadedRes.success.config.commentsDir
    if (dirFlag !== undefined) {
      const dirRes = yield* Effect.result(Config.validateCommentsDir(dirFlag))
      if (dirRes._tag === "Failure") {
        stderr(`smithers-comments: ${dirRes.failure.message}\n`)
        return 2
      }
      commentsDir = dirRes.success
    }

    const effectiveConfig: Config.CommentsConfig = {
      ...loadedRes.success.config,
      ...(modeFlag !== undefined ? { mode: modeFlag } : {}),
      commentsDir,
      ...(cacheFlag !== undefined ? { cacheFile: cacheFlag } : {}),
      ...(offline ? { agent: "heuristic" as const } : {})
    }

    const cacheAbs = Path.isAbsolute(effectiveConfig.cacheFile)
      ? effectiveConfig.cacheFile
      : Path.join(cwd, effectiveConfig.cacheFile)

    if (command === "check" || command === "lint") {
      const agentChoice = selectAgentLayer(effectiveConfig.agent, cwd)
      if (!agentChoice.ok) {
        stderr(`smithers-comments: ${agentChoice.message}\n`)
        return 4
      }
      const strict = flags.get("--strict") === true
      const envLayer = Layer.merge(agentChoice.layer, Cache.fileCacheLayer(cacheAbs))
      const Flows = yield* Effect.promise(() => import("./Flows.ts"))
      const res = yield* Effect.result(
        Flows.runCheckRepository({
          cwd,
          config: effectiveConfig,
          ...(positionals.length > 0 ? { paths: positionals } : {}),
          strict,
          noCache
        }).pipe(Effect.provide(envLayer))
      )
      if (res._tag === "Failure") {
        stderr(`smithers-comments: check failed: ${res.failure.message}\n`)
        return 4
      }
      const report = res.success
      if (jsonOut) {
        stdout(JSON.stringify(report, null, 2) + "\n")
      } else {
        for (const d of report.diagnostics) {
          stdout(`${d.file}:${d.line}  ${d.severity}  [${d.code}]  ${d.message}\n`)
        }
        stdout(
          `smithers-comments check (mode: ${report.mode})\n` +
            `  files: ${report.filesScanned}  comments: ${report.commentsChecked}  diagnostics: ${report.diagnostics.length}\n` +
            `  cache: ${report.cacheHits} hits, ${report.cacheMisses} misses (${report.agentCalls} agent calls)\n`
        )
      }
      return report.ok ? 0 : 1
    }

    if (command === "fix") {
      const agentChoice = selectAgentLayer(effectiveConfig.agent, cwd)
      if (!agentChoice.ok) {
        stderr(`smithers-comments: ${agentChoice.message}\n`)
        return 4
      }
      const dryRun = flags.get("--dry-run") === true
      const envLayer = Layer.merge(agentChoice.layer, Cache.fileCacheLayer(cacheAbs))
      const Flows = yield* Effect.promise(() => import("./Flows.ts"))
      const res = yield* Effect.result(
        Flows.runFixRepository({
          cwd,
          config: effectiveConfig,
          ...(positionals.length > 0 ? { paths: positionals } : {}),
          dryRun
        }).pipe(Effect.provide(envLayer))
      )
      if (res._tag === "Failure") {
        stderr(`smithers-comments: fix failed: ${res.failure.message}\n`)
        return 4
      }
      const report = res.success
      if (jsonOut) {
        stdout(JSON.stringify(report, null, 2) + "\n")
      } else {
        stdout(
          `smithers-comments fix (mode: ${report.mode}, dryRun: ${report.dryRun})\n` +
            `  filesChanged: ${report.filesChanged}  editsApplied: ${report.editsApplied}\n`
        )
      }
      return 0
    }

    if (command === "extract") {
      const dryRun = flags.get("--dry-run") === true
      const res = yield* Effect.result(
        Repository.runExtractRepository({
          cwd,
          config: effectiveConfig,
          ...(positionals.length > 0 ? { paths: positionals } : {}),
          dryRun
        })
      )
      if (res._tag === "Failure") {
        stderr(`smithers-comments: extract failed: ${res.failure.message}\n`)
        return 3
      }
      const report = res.success
      if (jsonOut) {
        stdout(JSON.stringify(report, null, 2) + "\n")
      } else {
        stdout(
          `smithers-comments extract (dir: ${report.commentsDir}, dryRun: ${report.dryRun})\n` +
            `  files: ${report.filesProcessed}  extracted: ${report.commentsExtracted}  pragmas: ${report.pragmasPreserved}  sidecars: ${report.sidecarsWritten}\n`
        )
      }
      return 0
    }

    if (command === "render") {
      const fileFlag = flags.get("--file") as string | undefined
      const outFlag = flags.get("--out") as string | undefined
      const inPlace = flags.get("--in-place") === true
      const removeSidecars = flags.get("--remove-sidecars") === true
      const checkFlag = flags.get("--check") === true

      const modeCount = (fileFlag !== undefined ? 1 : 0) + (outFlag !== undefined ? 1 : 0) + (inPlace ? 1 : 0)
      if (modeCount > 1) {
        stderr("smithers-comments: --file, --out, and --in-place are mutually exclusive\n")
        return 2
      }
      if (removeSidecars && !inPlace) {
        stderr("smithers-comments: --remove-sidecars requires --in-place\n")
        return 2
      }
      if (checkFlag && outFlag === undefined) {
        stderr("smithers-comments: --check requires --out <dir>\n")
        return 2
      }

      const res = yield* Effect.result(
        Repository.runRenderRepository({
          cwd,
          config: effectiveConfig,
          ...(positionals.length > 0 ? { paths: positionals } : {}),
          ...(fileFlag !== undefined ? { file: fileFlag } : {}),
          ...(outFlag !== undefined ? { outDir: outFlag } : {}),
          inPlace,
          removeSidecars,
          check: checkFlag
        })
      )
      if (res._tag === "Failure") {
        stderr(`smithers-comments: render failed: ${res.failure.message}\n`)
        return 3
      }

      const { report, singleFileContent } = res.success
      if (fileFlag !== undefined && !jsonOut) {
        stdout(singleFileContent ?? "")
        return 0
      }

      if (jsonOut) {
        stdout(JSON.stringify(report, null, 2) + "\n")
      } else {
        stdout(
          `smithers-comments render\n` +
            `  files: ${report.filesRendered}  commentsInjected: ${report.commentsInjected}  treeDigest: ${
              report.treeDigest.slice(0, 12)
            }\n`
        )
      }

      if (checkFlag && report.driftedFiles.length > 0) {
        stderr(`smithers-comments: virtual drift in ${report.driftedFiles.join(", ")}\n`)
        return 1
      }
      return 0
    }

    const res = yield* Effect.result(
      Repository.runStatusRepository({
        cwd,
        config: effectiveConfig,
        configPath: loadedRes.success.configPath,
        configExists: loadedRes.success.exists
      }).pipe(Effect.provide(Cache.fileCacheLayer(cacheAbs)))
    )
    if (res._tag === "Failure") {
      stderr(`smithers-comments: status failed: ${res.failure.message}\n`)
      return 3
    }
    const report = res.success
    if (jsonOut) {
      stdout(JSON.stringify(report, null, 2) + "\n")
    } else {
      stdout(
        `smithers-comments status\n` +
          `  mode: ${report.mode}  commentsDir: ${report.commentsDir}\n` +
          `  files: ${report.sourceFiles}  sidecars: ${report.sidecarFiles}  inline: ${report.inlineComments}  external: ${report.externalComments}  pragmas: ${report.pragmasPreserved}\n` +
          `  cache: ${report.cacheEntries} entries (${report.cachePath})\n`
      )
    }
    return 0
  })

/**
 * Runs the smithers-comments CLI entry point and resolves to its exit code.
 *
 * @since 1.0.0
 * @category cli
 */
export const runCliMain = (argv: ReadonlyArray<string>, cwd: string): Promise<number> =>
  Effect.runPromise(runCli(argv, { cwd }))
