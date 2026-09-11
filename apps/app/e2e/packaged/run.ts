import { constants } from "node:fs"
import { access, cp, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { PackagedFixtureRun } from "./FixtureRun"
import { findMountedProductionAppExecutable, findProductionAppExecutable } from "./PackagedApp"

const UI_DIRECTORY = fileURLToPath(new URL("../../", import.meta.url))
const ROOT_DIRECTORY = resolve(UI_DIRECTORY, "../..")
const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-")
let activeChild: ReturnType<typeof Bun.spawn> | undefined
let interrupted: NodeJS.Signals | undefined

const forwardSignal = (signal: NodeJS.Signals): void => {
  interrupted = signal
  try {
    activeChild?.kill(signal)
  } catch {
    // The child already received the terminal's signal.
  }
}

const run = async (
  label: string,
  argv: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly env?: Record<string, string> } = {}
): Promise<void> => {
  console.log(`[packaged-e2e] ${label}: ${argv.join(" ")}`)
  const child = Bun.spawn([...argv], {
    cwd: options.cwd ?? UI_DIRECTORY,
    env: { ...process.env, ...options.env },
    stdout: "inherit",
    stderr: "inherit"
  })
  activeChild = child
  const exitCode = await child.exited
  if (activeChild === child) activeChild = undefined
  if (interrupted !== undefined) throw new Error(`${label} interrupted by ${interrupted}.`)
  if (exitCode !== 0) throw new Error(`${label} failed with exit code ${exitCode}.`)
}

const copyOnWriteDirectory = async (source: string, destination: string): Promise<void> => {
  await access(source, constants.R_OK)
  await cp(source, destination, {
    recursive: true,
    mode: constants.COPYFILE_FICLONE
  })
}

export const stagePackageProject = async (): Promise<{
  readonly root: string
  readonly ui: string
  readonly hutchHome: string
}> => {
  const root = await mkdtemp(join(tmpdir(), `smithers-electrobun-package-${process.pid}-`))
  try {
    const workspace = join(root, "workspace")
    const ui = join(workspace, "apps", "ui")
    await mkdir(join(workspace, "apps"), { recursive: true })
    const excluded = new Set([".hutch", "artifacts", "build", "node_modules", "packaged-runtime", "test-results"])
    await cp(UI_DIRECTORY, ui, {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
      filter: (source) => {
        const path = relative(UI_DIRECTORY, source)
        const top = path.split(sep)[0]
        return path === "" || top === undefined || !excluded.has(top)
      }
    })
    await cp(join(UI_DIRECTORY, "packaged-runtime"), join(ui, "packaged-runtime"), {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
      verbatimSymlinks: true
    })
    await symlink(join(UI_DIRECTORY, "node_modules"), join(ui, "node_modules"), "dir")

    // Preserve pnpm's real workspace view without copying or mutating sibling
    // packages. In particular, verifyDepsBeforeRun=false prevents Hutch's
    // package hook from trying to install a standalone app with workspace: deps.
    for (const file of ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", "bun.lock"]) {
      await cp(join(ROOT_DIRECTORY, file), join(workspace, file))
    }
    await symlink(join(ROOT_DIRECTORY, "node_modules"), join(workspace, "node_modules"), "dir")
    for (const directory of ["packages", "e2e", "examples", "patches"]) {
      await symlink(join(ROOT_DIRECTORY, directory), join(workspace, directory), "dir")
    }
    for (const entry of await readdir(join(ROOT_DIRECTORY, "apps"), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "ui") continue
      await symlink(join(ROOT_DIRECTORY, "apps", entry.name), join(workspace, "apps", entry.name), "dir")
    }

    // Hutch serializes access to its global release graph. Copy-on-write clones
    // retain the exact installed bits while giving this package run private
    // lock inodes, so a live `electrobun dev` cannot block its writer.
    const sharedHutchHome = process.env.HUTCH_HOME ?? join(homedir(), ".hutch")
    const hutchHome = join(root, "hutch")
    await mkdir(hutchHome, { recursive: true })
    for (const directory of ["releases", "toolchains", "npm"]) {
      await copyOnWriteDirectory(join(sharedHutchHome, directory), join(hutchHome, directory))
    }
    return { root, ui, hutchHome }
  } catch (error) {
    try {
      await cleanupStage(root)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Package staging and cleanup both failed.")
    }
    throw error
  }
}

const cleanupStage = async (root: string): Promise<void> => {
  const prefix = join(tmpdir(), "smithers-electrobun-package-")
  if (!resolve(root).startsWith(prefix)) throw new Error(`Refusing to remove unexpected package stage: ${root}`)
  await rm(root, { recursive: true, force: true })
  const remains = await access(root, constants.F_OK).then(() => true, () => false)
  if (remains) throw new Error(`Electrobun package stage was not removed: ${root}`)
}

const findStableDiskImage = async (uiDirectory: string): Promise<string> => {
  const artifacts = join(uiDirectory, "artifacts")
  const candidates: Array<{ readonly path: string; readonly modifiedAt: number }> = []
  for (const entry of await readdir(artifacts, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".dmg")) continue
    const path = join(artifacts, entry.name)
    candidates.push({ path, modifiedAt: (await Bun.file(path).stat()).mtimeMs })
  }
  candidates.sort((left, right) => right.modifiedAt - left.modifiedAt)
  const candidate = candidates[0]
  if (candidate === undefined) throw new Error(`No stable Electrobun disk image found under ${artifacts}.`)
  return candidate.path
}

const main = async (): Promise<void> => {
  process.on("SIGINT", () => forwardSignal("SIGINT"))
  process.on("SIGTERM", () => forwardSignal("SIGTERM"))
  if (process.platform !== "darwin") {
    console.log("SKIP: packaged Electrobun E2E currently supports macOS only.")
    return
  }

  const artifacts = resolve(
    process.env.SMITHERS_E2E_ARTIFACTS ?? join(UI_DIRECTORY, "test-results", "electrobun-packaged", timestamp)
  )
  await mkdir(artifacts, { recursive: true })
  console.log(`[packaged-e2e] artifacts: ${artifacts}`)
  const preflight = await PackagedFixtureRun.start({
    artifactsDirectory: artifacts,
    ...(process.env.SMITHERS_E2E_FIXTURE_REGISTRY === undefined
      ? {}
      : { registryDirectory: process.env.SMITHERS_E2E_FIXTURE_REGISTRY }),
    allowStaleRecovery: process.env.SMITHERS_E2E_RECOVER_STALE === "1"
  })
  await preflight.cleanup()
  const suppliedExecutable = process.env.SMITHERS_E2E_EXECUTABLE
  let stage: Awaited<ReturnType<typeof stagePackageProject>> | undefined
  let mountedVolume: string | undefined
  let installedExecutable: string | undefined
  let portableRuntimePrepared = false
  let operationError: unknown
  try {
    let packageDirectory = UI_DIRECTORY
    if (suppliedExecutable === undefined && process.env.SMITHERS_E2E_SKIP_BUILD !== "1") {
      await run("project devkit", [process.execPath, "scripts/ensure-devkit.mjs"])
      await run("production web bundle", ["pnpm", "exec", "vite", "build", "--configLoader", "runner"])
      await run("portable smithers-build runtime", [process.execPath, "scripts/prepare-packaged-build-cli.ts"])
      portableRuntimePrepared = true
      stage = await stagePackageProject()
      packageDirectory = stage.ui
      console.log(`[packaged-e2e] isolated package project: ${packageDirectory}`)
      await run(
        "portable runtime source cleanup",
        [process.execPath, "scripts/prepare-packaged-build-cli.ts", "--clean"]
      )
      portableRuntimePrepared = false
      await run(
        "stable Electrobun package",
        ["pnpm", "exec", "electrobun", "build", "--env=stable"],
        {
          cwd: packageDirectory,
          env: {
            HUTCH_HOME: stage.hutchHome,
            DASH_RELEASE_OFFLINE: "1"
          }
        }
      )
      const diskImage = await findStableDiskImage(packageDirectory)
      const mountDirectory = join(stage.root, "mounted-app")
      await mkdir(mountDirectory)
      await run(
        "mount stable Electrobun disk image",
        ["/usr/bin/hdiutil", "attach", "-readonly", "-nobrowse", "-mountpoint", mountDirectory, diskImage]
      )
      mountedVolume = mountDirectory
      const mountedExecutable = await findMountedProductionAppExecutable(mountedVolume)
      const mountedBundle = resolve(dirname(mountedExecutable), "../..")
      const installedBundle = join(stage.root, "installed-app", "Smithers.app")
      await mkdir(dirname(installedBundle), { recursive: true })
      await run("install packaged app", ["/usr/bin/ditto", mountedBundle, installedBundle])
      installedExecutable = join(installedBundle, "Contents", "MacOS", "launcher")
      await run("detach stable Electrobun disk image", ["/usr/bin/hdiutil", "detach", mountedVolume])
      mountedVolume = undefined
    }

    const executable = suppliedExecutable === undefined
      ? installedExecutable ?? await findProductionAppExecutable(packageDirectory)
      : resolve(suppliedExecutable)
    console.log(`[packaged-e2e] executable: ${executable}`)
    await run(
      "bridge and cleanup contracts",
      [
        process.execPath,
        "test",
        "src/bun/PackagedE2EBridge.test.ts",
        "e2e/packaged/FixtureRun.test.ts",
        "e2e/packaged/PackagedApp.test.ts",
        "e2e/packaged/bridge.test.ts",
        "e2e/packaged/run.test.ts",
        "e2e/contracts"
      ]
    )
    await run(
      "Bun packaged-app suite",
      [process.execPath, "test", "--timeout", "180000", "e2e/packaged/packaged-app.e2e.test.ts"],
      {
        env: {
          SMITHERS_E2E_EXECUTABLE: executable,
          SMITHERS_E2E_ARTIFACTS: artifacts
        }
      }
    )
    // A successful test process is not sufficient: a detached native child
    // can recreate HOME after the suite removes its fixture. Let late writes
    // settle, then use the same durable lease contract as startup to audit it.
    await Bun.sleep(250)
    const postflight = await PackagedFixtureRun.start({
      artifactsDirectory: artifacts,
      ...(process.env.SMITHERS_E2E_FIXTURE_REGISTRY === undefined
        ? {}
        : { registryDirectory: process.env.SMITHERS_E2E_FIXTURE_REGISTRY })
    })
    await postflight.cleanup()
  } catch (error) {
    operationError = error
  }

  const cleanupErrors: Array<unknown> = []
  if (portableRuntimePrepared) {
    try {
      await run("portable runtime source cleanup", [
        process.execPath,
        "scripts/prepare-packaged-build-cli.ts",
        "--clean"
      ])
      portableRuntimePrepared = false
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  try {
    if (mountedVolume !== undefined) {
      await run("detach stable Electrobun disk image", ["/usr/bin/hdiutil", "detach", mountedVolume])
      mountedVolume = undefined
    }
  } catch (error) {
    cleanupErrors.push(error)
  }
  if (stage !== undefined && mountedVolume === undefined) {
    try {
      await cleanupStage(stage.root)
    } catch (error) {
      cleanupErrors.push(error)
    }
  }

  if (operationError !== undefined && cleanupErrors.length > 0) {
    throw new AggregateError([operationError, ...cleanupErrors], "Packaged E2E run and cleanup both failed.")
  }
  if (operationError !== undefined) throw operationError
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Packaged E2E cleanup failed.")
}

if (import.meta.main) await main().catch((error) => {
  console.error(`[packaged-e2e] FAIL: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
