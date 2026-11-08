// The platform code of land.vibe: lock and cache locations, file existence, glob matching and the baseline file,
// which a .vibe file does not reach directly.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { matchesGlob } from "node:path"

// The machine-wide lock ~/Smithers-Ops/dispatch/vcs_lock.py takes for this
// checkout. lockf(1) takes the same flock(2) lock.
export const lockFile = `${homedir()}/Smithers-Ops/dispatch/locks/smithers.lock`

/** Shared Go build cache every sandbox may write, so Go tests stay warm across issues. */
export const goCache = `${tmpdir()}/issue-sweep-go-build`

/**
 * Whether a file or directory exists at `path`.
 * @throws {never}
 */
export function fileExists(path: string): boolean {
  return existsSync(path)
}

/** Whether `file` matches the glob `pattern`. */
export const matchesPath = (file: string, pattern: string): boolean => matchesGlob(file, pattern)

/**
 * The landing lock a lander takes: the configured one, else `SMITHERS_LAND_LOCK`, else the builders' main-push lock.
 * @throws {never}
 */
export function landingLockPath(configured: string | undefined): string {
  return configured ?? process.env.SMITHERS_LAND_LOCK ?? `${homedir()}/smithers-builders/main-push.lock`
}

/** The baseline answers saved in `file`: commit to label to red; an unreadable or malformed file is empty. */
export const readBaselines = (file: string | undefined): Record<string, Record<string, boolean>> => {
  if (file === undefined) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([commit, labels]) =>
        typeof labels === "object" && labels !== null
          ? [[
            commit,
            Object.fromEntries(
              Object.entries(labels).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean")
            )
          ]]
          : []
      )
    )
  } catch {
    return {}
  }
}

/** Writes the baseline answers through a temporary name; a write that fails loses nothing but a restart's head start. */
export const saveBaselines = (file: string, saved: Record<string, Record<string, boolean>>): void => {
  try {
    writeFileSync(`${file}.tmp`, JSON.stringify(saved))
    renameSync(`${file}.tmp`, file)
  } catch {
    // The file only saves work after a restart; memory still holds the answer.
  }
}
