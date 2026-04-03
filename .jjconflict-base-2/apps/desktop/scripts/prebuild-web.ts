import { join } from "node:path"

const webAppDir = join(import.meta.dir, "..", "..", "web")

export function resolveBunExecutable(
  currentExecPath = process.execPath,
  env: NodeJS.ProcessEnv = process.env
) {
  const configuredExecutable = env.BURNS_DESKTOP_PREBUILD_BUN?.trim()
  if (configuredExecutable) {
    return configuredExecutable
  }

  const normalizedPath = currentExecPath.trim()
  return normalizedPath.length > 0 ? normalizedPath : "bun"
}

type SpawnResult = {
  exitCode: number
}

type RunWebPrebuildOptions = {
  bunExecutable?: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  spawnSync?: (
    command: string[],
    options: {
      cwd: string
      stdout: "inherit"
      stderr: "inherit"
    }
  ) => SpawnResult
  log?: (message: string) => void
}

export function runWebPrebuild(options: RunWebPrebuildOptions = {}) {
  const env = options.env ?? process.env
  const bunExecutable = options.bunExecutable ?? resolveBunExecutable(undefined, env)
  const cwd = options.cwd ?? webAppDir
  const spawnSync = options.spawnSync ?? Bun.spawnSync
  const log = options.log ?? console.log

  if (env.BURNS_DESKTOP_SKIP_WEB_PREBUILD === "1") {
    log("[desktop][preBuild] Skipping web build because BURNS_DESKTOP_SKIP_WEB_PREBUILD=1")
    return
  }

  log("[desktop][preBuild] Building web app for desktop packaging...")

  const result = spawnSync([bunExecutable, "run", "build", "--", "--configLoader", "runner"], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  })

  if (result.exitCode !== 0) {
    throw new Error(`[desktop][preBuild] Web build failed with exit code ${result.exitCode}`)
  }

  log("[desktop][preBuild] Web build complete")
}

if (import.meta.main) {
  runWebPrebuild()
}
