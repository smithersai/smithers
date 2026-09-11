/**
 * Dogfood harness: runs factory background tasks as flows on the Smithers
 * library itself.
 *
 * Two atoms: `AgentTask` spawns a headless `claude -p` agent, `ShellTask`
 * runs a shell command. Both stream their output to a log file so progress
 * is tailable, and both report failure as a value (`exitCode`) instead of
 * failing the flow, so one bad task never aborts a wave.
 *
 * The harness runs against the root install: the workspace root declares
 * `@smthrs/engine`, `@smthrs/flow` and `@smthrs/plan`, so the packages are
 * imported by name through their export maps like any other consumer.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { spawn } from "node:child_process"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { libraryPackages, type WorkspacePackage } from "../../scripts/workspace-packages.mjs"

export const REPO_ROOT = path.resolve(import.meta.dirname, "../..")
export const REPORTS_DIR = path.join(REPO_ROOT, "factory/reports")

export const TaskResult = Schema.Struct({
  id: Schema.String,
  exitCode: Schema.Number,
  logPath: Schema.String,
  manifestPath: Schema.String,
  tail: Schema.String
})

export type TaskResult = typeof TaskResult.Type

export interface SpawnSpec {
  readonly id: string
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly timeoutMs: number
  readonly logDir: string
  readonly environment?: Readonly<Record<string, string>>
  readonly completionMarker?: string
  readonly validateResult?: () => string | undefined
}

const agentEnvironment = (): Record<string, string> =>
  Object.fromEntries(
    ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM"]
      .map((key) => [key, process.env[key]] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== undefined)
  )

const signalProcessTree = (pid: number | undefined, signal: NodeJS.Signals): void => {
  if (pid === undefined) return
  try {
    if (process.platform === "win32") process.kill(pid, signal)
    else process.kill(-pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
  }
}

/** Runs one owned process group and interrupts the whole group on timeout or scope closure. */
export const runProcess = (spec: SpawnSpec): Effect.Effect<TaskResult> =>
  Effect.callback<TaskResult>((resume) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(spec.id)) {
      resume(Effect.die(new Error(`Unsafe process id: ${JSON.stringify(spec.id)}`)))
      return
    }
    fs.mkdirSync(spec.logDir, { recursive: true })
    const startedAt = new Date().toISOString()
    const artifactId = `${spec.id}-${randomUUID()}`
    const logPath = path.join(spec.logDir, `${artifactId}.log`)
    const manifestPath = path.join(spec.logDir, `${artifactId}.json`)
    const log = fs.createWriteStream(logPath, { flags: "wx" })
    log.write(`# ${startedAt} ${spec.command} ${spec.args.join(" ")}\n`)
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.environment ?? process.env,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    })
    let settled = false
    let timedOut = false
    let tail = ""
    const keep = (chunk: Buffer) => {
      tail = (tail + chunk.toString()).slice(-4000)
    }
    child.stdout.on("data", (chunk: Buffer) => {
      log.write(chunk)
      keep(chunk)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      log.write(chunk)
      keep(chunk)
    })
    const finish = (exitCode: number, finalTail = tail) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (escalation !== undefined) clearTimeout(escalation)
      const markerMissing = spec.completionMarker !== undefined && !finalTail.includes(spec.completionMarker)
      const validationError = exitCode === 0 && !markerMissing ? spec.validateResult?.() : undefined
      const verifiedExitCode = exitCode === 0 && markerMissing ? -2 : exitCode === 0 && validationError ? -3 : exitCode
      if (markerMissing) log.write(`\n# MISSING COMPLETION MARKER: ${spec.completionMarker}\n`)
      if (validationError) log.write(`\n# CONFINEMENT VIOLATION: ${validationError}\n`)
      log.end(() => {
        fs.writeFileSync(
          manifestPath,
          `${
            JSON.stringify(
              {
                id: spec.id,
                startedAt,
                finishedAt: new Date().toISOString(),
                command: spec.command,
                args: spec.args,
                cwd: spec.cwd,
                exitCode: verifiedExitCode,
                logPath
              },
              null,
              2
            )
          }\n`
        )
        resume(
          Effect.succeed({
            id: spec.id,
            exitCode: verifiedExitCode,
            logPath,
            manifestPath,
            tail: finalTail
          })
        )
      })
    }
    let escalation: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(() => {
      timedOut = true
      log.write(`\n# TIMEOUT after ${spec.timeoutMs}ms\n`)
      signalProcessTree(child.pid, "SIGTERM")
      escalation = setTimeout(() => signalProcessTree(child.pid, "SIGKILL"), 2_000)
    }, spec.timeoutMs)
    child.on("error", (error) => {
      finish(-1, String(error))
    })
    child.on("close", (code) => {
      if (escalation !== undefined) clearTimeout(escalation)
      finish(timedOut ? -1 : (code ?? -1))
    })
    return Effect.callback<void>((done) => {
      if (settled) {
        done(Effect.void)
        return
      }
      settled = true
      clearTimeout(timer)
      if (escalation !== undefined) clearTimeout(escalation)
      let finalized = false
      let kill: ReturnType<typeof setTimeout> | undefined
      let bound: ReturnType<typeof setTimeout> | undefined
      const complete = () => {
        if (finalized) return
        finalized = true
        if (kill !== undefined) clearTimeout(kill)
        if (bound !== undefined) clearTimeout(bound)
        child.off("close", complete)
        log.end("\n# INTERRUPTED: owned process group terminated\n", () => done(Effect.void))
      }
      child.once("close", complete)
      signalProcessTree(child.pid, "SIGTERM")
      kill = setTimeout(() => signalProcessTree(child.pid, "SIGKILL"), 2_000)
      bound = setTimeout(complete, 3_000)
      return Effect.sync(() => {
        if (kill !== undefined) clearTimeout(kill)
        if (bound !== undefined) clearTimeout(bound)
        child.off("close", complete)
      })
    })
  })

/**
 * A headless coding-agent step: one `claude -p` invocation.
 */
export const AgentTask = Action.make("factory/AgentTask", {
  payload: {
    id: Schema.String,
    prompt: Schema.String,
    cwd: Schema.String,
    model: Schema.String,
    timeoutMs: Schema.Number,
    logDir: Schema.String,
    completionMarker: Schema.String,
    allowedPaths: Schema.Array(Schema.String)
  },
  success: TaskResult
})

const gitChangedPaths = (root: string): Array<string> => {
  const tracked = execFileSync(
    "git",
    ["-C", root, "diff", "--name-only", "-z", "--no-renames", "HEAD"],
    { encoding: "utf8" }
  )
  const untracked = execFileSync(
    "git",
    ["-C", root, "ls-files", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8" }
  )
  return [...new Set(`${tracked}${untracked}`.split("\0").filter(Boolean))]
}

const fileSnapshot = (filename: string): string => {
  try {
    return fs.readFileSync(filename).toString("base64")
  } catch {
    return "<missing>"
  }
}

/** Captures the existing dirty tree and rejects every new or altered path outside the declared roots. */
export const makeConfinementValidator = (
  cwd: string,
  allowedPaths: ReadonlyArray<string>
): () => string | undefined => {
  const root = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    encoding: "utf8"
  }).trim()
  const allowed = allowedPaths.map((candidate) => path.resolve(candidate))
  const isAllowed = (relative: string) => {
    const absolute = path.resolve(root, relative)
    return allowed.some((base) => absolute === base || absolute.startsWith(`${base}${path.sep}`))
  }
  const before = new Map(
    gitChangedPaths(root)
      .filter((relative) => !isAllowed(relative))
      .map((relative) => [relative, fileSnapshot(path.resolve(root, relative))] as const)
  )
  return () => {
    const violations = gitChangedPaths(root).filter((relative) => {
      if (isAllowed(relative)) return false
      return before.get(relative) !== fileSnapshot(path.resolve(root, relative))
    })
    return violations.length === 0
      ? undefined
      : `writes escaped allowedPaths: ${violations.join(", ")}`
  }
}

export const agentTaskLayer = AgentTask.toLayer((payload) => {
  const validateResult = makeConfinementValidator(payload.cwd, [...payload.allowedPaths, payload.logDir])
  const writeRules = payload.allowedPaths.flatMap((candidate) => {
    const absolute = path.resolve(candidate)
    return [`Edit(${absolute})`, `Edit(${absolute}/**)`, `Write(${absolute})`, `Write(${absolute}/**)`]
  })
  return runProcess({
    id: payload.id,
    command: "claude",
    args: [
      "-p",
      payload.prompt,
      "--model",
      payload.model,
      "--allowedTools",
      "Read",
      "Glob",
      "Grep",
      ...writeRules
    ],
    cwd: payload.cwd,
    timeoutMs: payload.timeoutMs,
    logDir: payload.logDir,
    environment: agentEnvironment(),
    completionMarker: payload.completionMarker,
    validateResult
  })
})

/**
 * A structured command step. Arguments are passed directly without a shell.
 */
export const ShellTask = Action.make("factory/ShellTask", {
  payload: {
    id: Schema.String,
    command: Schema.String,
    args: Schema.Array(Schema.String),
    cwd: Schema.String,
    timeoutMs: Schema.Number,
    logDir: Schema.String
  },
  success: TaskResult
})

export const shellTaskLayer = ShellTask.toLayer((payload) =>
  runProcess({
    id: payload.id,
    command: payload.command,
    args: payload.args,
    cwd: payload.cwd,
    timeoutMs: payload.timeoutMs,
    logDir: payload.logDir
  })
)

/**
 * Executes one flow on the in-memory engine with both task implementations
 * attached.
 */
export const runFlow = <F extends Flow.AnyWithProps>(
  flow: F,
  payload: Record<string, unknown>,
  executionId: string
): Promise<unknown> => {
  const layer = Layer.mergeAll(
    agentTaskLayer,
    shellTaskLayer,
    Interpreter.layer(flow as never)
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeCrypto.layer)
  )
  return Effect.runPromise(
    (
      flow as never as {
        execute: (
          payload: unknown,
          options: { readonly executionId: string }
        ) => Effect.Effect<unknown, unknown, never>
      }
    )
      .execute(payload, { executionId })
      .pipe(Effect.orDie, Effect.provide(layer)) as Effect.Effect<unknown>
  )
}

/** Splits a list into waves of at most `size`. */
export const chunk = <T>(items: ReadonlyArray<T>, size: number): Array<Array<T>> => {
  const waves: Array<Array<T>> = []
  for (let index = 0; index < items.length; index += size) {
    waves.push(items.slice(index, index + size) as Array<T>)
  }
  return waves
}

/**
 * The library packages the factory may hand to a command argument, as the
 * shared workspace reader names them: `dir` is the repository-relative
 * directory and `name` is the manifest's npm name. Both are validated here
 * because they are spliced into prompts and `pnpm --filter` arguments.
 */
export const listWorkspacePackages = (): Array<Pick<WorkspacePackage, "dir" | "name">> =>
  libraryPackages(REPO_ROOT).map(({ dir, name, manifestPath }) => {
    if (!/^packages\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/.test(dir)) {
      throw new Error(`Unsafe workspace package directory: ${JSON.stringify(dir)}`)
    }
    if (typeof name !== "string" || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) {
      throw new Error(`${manifestPath} must declare a safe npm package name`)
    }
    return { dir, name }
  })

/** Parses an optional exact `--packages a,b` selection and rejects every ambiguous form. */
export const selectPackages = (
  args: ReadonlyArray<string>,
  allPackages: ReadonlyArray<string>
): Array<string> => {
  const indexes = args.flatMap((arg, index) => arg === "--packages" ? [index] : [])
  if (indexes.length === 0) return [...allPackages]
  if (indexes.length > 1) throw new Error("--packages may be supplied only once")
  const value = args[indexes[0]! + 1]
  if (value === undefined || value.startsWith("--")) throw new Error("--packages requires a comma-separated value")
  const selected = value.split(",").map((pkg) => pkg.trim())
  if (selected.some((pkg) => pkg === "")) throw new Error("--packages contains an empty package name")
  const duplicates = selected.filter((pkg, index) => selected.indexOf(pkg) !== index)
  if (duplicates.length > 0) throw new Error(`--packages contains duplicates: ${[...new Set(duplicates)].join(", ")}`)
  const unknown = selected.filter((pkg) => !allPackages.includes(pkg))
  if (unknown.length > 0) {
    throw new Error(`Unknown package(s): ${unknown.join(", ")}. Valid packages: ${allPackages.join(", ")}`)
  }
  return selected
}
