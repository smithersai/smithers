import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { access, lstat, mkdir, readFile, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"

const LEASE_VERSION = 1
const ACTIVE_DIRECTORY = "active"
const LEASE_FILE = "lease.json"
const ACTIVE_TEST_FILE = "active-test.json"

const safeLabel = (label: string): string =>
  label.replaceAll(/[^a-zA-Z0-9._-]+/g, "-").replaceAll(/^-+|-+$/g, "").slice(0, 80) || "test"

const exists = async (path: string): Promise<boolean> => access(path, constants.F_OK).then(() => true, () => false)

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

const assertDirectory = async (path: string): Promise<void> => {
  const entry = await lstat(path)
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`Packaged E2E fixture path is not a real directory: ${path}`)
  }
}

const isInside = (parent: string, child: string): boolean => {
  const prefix = resolve(parent) + sep
  return resolve(child).startsWith(prefix)
}

const removeInside = async (parent: string, child: string): Promise<void> => {
  if (!isInside(parent, child)) throw new Error(`Refusing to remove fixture path outside ${parent}: ${child}`)
  await rm(child, { recursive: true, force: true })
  if (await exists(child)) throw new Error(`Fixture cleanup did not remove ${child}`)
}

interface RunLease {
  readonly version: typeof LEASE_VERSION
  readonly runId: string
  readonly pid: number
  readonly startedAt: string
  readonly workDirectory: string
}

interface ActiveTestLease {
  readonly version: typeof LEASE_VERSION
  readonly runId: string
  readonly testId: string
  readonly label: string
  readonly startedAt: string
  readonly directory: string
}

export interface StartPackagedFixtureRunOptions {
  readonly registryDirectory?: string
  readonly artifactsDirectory?: string
  readonly allowStaleRecovery?: boolean
  /** Tests can inject liveness without manufacturing operating-system processes. */
  readonly isProcessAlive?: (pid: number) => boolean
}

const defaultRegistryDirectory = (): string => {
  const user = typeof process.getuid === "function" ? String(process.getuid()) : "user"
  return join(tmpdir(), `smithers-packaged-e2e-${user}`)
}

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"))

const parseRunLease = (value: unknown): RunLease | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const row = value as Partial<RunLease>
  return row.version === LEASE_VERSION && typeof row.runId === "string" && Number.isSafeInteger(row.pid) &&
      typeof row.startedAt === "string" && typeof row.workDirectory === "string"
    ? row as RunLease
    : undefined
}

const parseActiveTestLease = (value: unknown): ActiveTestLease | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const row = value as Partial<ActiveTestLease>
  return row.version === LEASE_VERSION && typeof row.runId === "string" && typeof row.testId === "string" &&
      typeof row.label === "string" && typeof row.startedAt === "string" && typeof row.directory === "string"
    ? row as ActiveTestLease
    : undefined
}

const atomicJson = async (path: string, value: unknown): Promise<void> => {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

const staleReport = async (
  artifactsDirectory: string | undefined,
  lease: RunLease | undefined,
  reason: string
): Promise<void> => {
  if (artifactsDirectory === undefined) return
  await mkdir(artifactsDirectory, { recursive: true })
  const path = join(artifactsDirectory, `stale-fixture.${new Date().toISOString().replaceAll(/[:.]/g, "-")}.json`)
  await atomicJson(path, { detectedAt: new Date().toISOString(), reason, lease: lease ?? null })
}

// All removal of an active generation goes through this exclusive claim.
// Moving it aside before recursive deletion keeps a new owner's pathname safe.
// A crashed claimant leaves the guard in place for manual inspection.
const retireRun = async (
  registryDirectory: string,
  activeDirectory: string,
  expected: Pick<RunLease, "runId" | "pid">,
  alive?: (pid: number) => boolean
): Promise<void> => {
  const guard = join(activeDirectory, ".retiring")
  await mkdir(guard, { mode: 0o700 })
  let retired: string | undefined
  try {
    const current = await readJson(join(activeDirectory, LEASE_FILE)).then(parseRunLease, () => undefined)
    if (current?.runId !== expected.runId || current.pid !== expected.pid) {
      throw new Error(`Fixture cleanup does not own active run ${expected.runId}.`)
    }
    if (alive?.(current.pid)) throw new Error(`Another packaged E2E run is active (pid ${current.pid}).`)
    const destination = join(registryDirectory, `retired-${randomUUID()}`)
    await rename(activeDirectory, destination)
    retired = destination
  } finally {
    if (retired === undefined) await rmdir(guard)
  }
  await removeInside(registryDirectory, retired)
}

export class PackagedTestFixture {
  readonly label: string
  readonly directory: string

  private closed = false

  constructor(
    private readonly owner: PackagedFixtureRun,
    private readonly lease: ActiveTestLease
  ) {
    this.label = lease.label
    this.directory = lease.directory
  }

  async makeDirectory(name: string): Promise<string> {
    if (this.closed) throw new Error(`Fixture ${this.label} has already been cleaned.`)
    const directory = join(this.directory, safeLabel(name))
    if (!isInside(this.directory, directory)) throw new Error(`Invalid fixture directory name: ${name}`)
    await mkdir(directory, { recursive: true })
    return directory
  }

  async cleanup(): Promise<void> {
    if (this.closed) return
    await this.owner.finishTest(this.lease)
    this.closed = true
  }
}

/**
 * One deliberately small lifecycle for the packaged lane. The on-disk lease
 * survives SIGKILL, so the next invocation can distinguish a clean prior run
 * from cleanup that never executed.
 */
export class PackagedFixtureRun {
  readonly registryDirectory: string
  readonly workDirectory: string
  readonly runId: string

  private readonly activeDirectory: string
  private readonly activeTestPath: string
  private currentTest: ActiveTestLease | undefined
  private closed = false

  private constructor(registryDirectory: string, activeDirectory: string, lease: RunLease) {
    this.registryDirectory = registryDirectory
    this.activeDirectory = activeDirectory
    this.activeTestPath = join(activeDirectory, ACTIVE_TEST_FILE)
    this.workDirectory = lease.workDirectory
    this.runId = lease.runId
  }

  static async start(options: StartPackagedFixtureRunOptions = {}): Promise<PackagedFixtureRun> {
    const registryDirectory = resolve(options.registryDirectory ?? defaultRegistryDirectory())
    await mkdir(registryDirectory, { recursive: true, mode: 0o700 })
    await assertDirectory(registryDirectory)
    const activeDirectory = join(registryDirectory, ACTIVE_DIRECTORY)
    const alive = options.isProcessAlive ?? processIsAlive

    try {
      // mkdir is the exclusive acquisition. Until lease publication completes,
      // every contender must preserve this possibly initializing owner.
      await mkdir(activeDirectory, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      await assertDirectory(activeDirectory)
      const leasePath = join(activeDirectory, LEASE_FILE)
      const lease = await readJson(leasePath).then(parseRunLease, () => undefined)
      if (lease !== undefined && alive(lease.pid)) {
        throw new Error(
          `Another packaged E2E run is active (pid ${lease.pid}, started ${lease.startedAt}, run ${lease.runId}).`
        )
      }

      if (lease === undefined) {
        throw new Error(
          "Another packaged E2E run may be initializing: its lease is unreadable. " +
          "Inspect the registry after confirming no suite is running; fixtures were preserved."
        )
      }
      const reason = `The prior suite process ${lease.pid} is gone but its cleanup lease remains.`
      await staleReport(options.artifactsDirectory, lease, reason)
      if (options.allowStaleRecovery !== true) {
        throw new Error(
          `Detected an unclean prior packaged E2E run. ${reason} ` +
          "Its fixtures were preserved; enable stale recovery after inspection."
        )
      }
      await retireRun(registryDirectory, activeDirectory, lease, alive)
      await mkdir(activeDirectory, { mode: 0o700 })
    }

    const runId = randomUUID()
    const workDirectory = join(activeDirectory, "work")
    await mkdir(workDirectory, { mode: 0o700 })
    const lease: RunLease = {
      version: LEASE_VERSION,
      runId,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      workDirectory
    }
    await atomicJson(join(activeDirectory, LEASE_FILE), lease)
    return new PackagedFixtureRun(registryDirectory, activeDirectory, lease)
  }

  async beginTest(label: string): Promise<PackagedTestFixture> {
    if (this.closed) throw new Error("The packaged E2E fixture run has already been cleaned.")
    const markerExists = await exists(this.activeTestPath)
    const onDisk = await readJson(this.activeTestPath).then(parseActiveTestLease, () => undefined)
    const previous = this.currentTest ?? onDisk
    if (previous !== undefined) {
      throw new Error(
        `Refusing to start ${JSON.stringify(label)}: cleanup never completed for prior test ` +
          `${JSON.stringify(previous.label)} (${previous.testId}).`
      )
    }
    if (markerExists) {
      throw new Error(
        `Refusing to start ${JSON.stringify(label)}: the prior test left an unreadable cleanup marker.`
      )
    }

    const testId = `${safeLabel(label)}-${randomUUID()}`
    const directory = join(this.workDirectory, testId)
    await mkdir(directory, { mode: 0o700 })
    const lease: ActiveTestLease = {
      version: LEASE_VERSION,
      runId: this.runId,
      testId,
      label,
      startedAt: new Date().toISOString(),
      directory
    }
    await atomicJson(this.activeTestPath, lease)
    this.currentTest = lease
    return new PackagedTestFixture(this, lease)
  }

  async finishTest(lease: ActiveTestLease): Promise<void> {
    if (this.closed) return
    if (lease.runId !== this.runId || this.currentTest?.testId !== lease.testId) {
      throw new Error(`Fixture cleanup does not own active test ${lease.testId}.`)
    }
    await removeInside(this.workDirectory, lease.directory)
    await unlink(this.activeTestPath)
    this.currentTest = undefined
  }

  async cleanup(): Promise<void> {
    if (this.closed) return
    const markerExists = await exists(this.activeTestPath)
    const leaked = this.currentTest ?? await readJson(this.activeTestPath).then(parseActiveTestLease, () => undefined)
    await retireRun(this.registryDirectory, this.activeDirectory, { runId: this.runId, pid: process.pid })
    await rmdir(this.registryDirectory).catch((error: NodeJS.ErrnoException) => {
      // A caller-supplied registry may contain reports, and a new suite may
      // acquire it immediately after this lease is removed.
      if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error
    })
    this.closed = true
    if (leaked !== undefined) {
      throw new Error(
        `Packaged E2E suite cleanup recovered test ${JSON.stringify(leaked.label)} because its cleanup never completed.`
      )
    }
    if (markerExists) {
      throw new Error("Packaged E2E suite cleanup recovered an unreadable test marker because cleanup never completed.")
    }
  }
}
