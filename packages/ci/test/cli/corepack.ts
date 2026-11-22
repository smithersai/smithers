/**
 * Package managers that corepack runs, for the cases that replay a repository
 * naming one in `packageManager`.
 *
 * Such a case needs corepack's own `pnpm` or `yarn` first on `PATH` and a
 * release of the manager for the steps. It opens no network and reads no
 * cache it did not fill: it gives the replay a corepack home of its own,
 * filled from a release this machine's corepack keeps. The tests keep no
 * release with them: one is 18 to 61 MB, and the cases are about what the
 * real release does. A machine that has no corepack, or keeps no such release,
 * skips the case and prints the command that keeps one.
 */
import { execFileSync } from "node:child_process"
import { cpSync, existsSync, readdirSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** A release corepack keeps: where it is, and where `PATH` finds corepack's program that runs it. */
export interface Release {
  readonly name: string
  readonly version: string
  readonly directory: string
  readonly program: string
}

/** Why this machine cannot give a case the release it needs. */
export interface Missing {
  readonly missing: string
}

/** Where this machine's corepack keeps releases: `COREPACK_HOME`, else the cache directory's `node/corepack`. */
export const machineCorepack = (environment: NodeJS.ProcessEnv = process.env): string =>
  environment["COREPACK_HOME"] ?? join(environment["XDG_CACHE_HOME"] ?? join(homedir(), ".cache"), "node", "corepack")

/** Orders releases by their numbers, `9.6.0` before `12.15.0`. */
export const byRelease = (left: string, right: string): number => {
  const numbers = (release: string) => (release.match(/^\d+(?:\.\d+)*/)?.[0] ?? "").split(".").map(Number)
  const [a, b] = [numbers(left), numbers(right)]
  for (let at = 0; at < Math.max(a.length, b.length); at++) {
    if ((a[at] ?? 0) !== (b[at] ?? 0)) return (a[at] ?? 0) - (b[at] ?? 0)
  }
  return 0
}

/** Where `PATH` finds a program, or nothing. */
const found = (name: string, path: string | undefined): string | undefined => {
  try {
    return execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8", env: { ...process.env, PATH: path } })
      .trim() || undefined
  } catch {
    return undefined
  }
}

/**
 * The newest release of `name` that `accepts` takes, kept by the corepack of `environment`, whose own `name` is the
 * one its `PATH` finds; or what to run so that there is one. `wanted` names the releases in words, `pnpm@10`.
 */
export const corepackRelease = (
  name: string,
  wanted: string,
  accepts: (release: string) => boolean,
  environment: NodeJS.ProcessEnv = process.env
): Release | Missing => {
  const program = found(name, environment["PATH"])
  if (program === undefined || !realpathSync(program).endsWith(join("corepack", "dist", `${name}.js`))) {
    return { missing: `${program ?? name} is not corepack's ${name}: run \`corepack enable\`` }
  }
  const versions = join(machineCorepack(environment), "v1", name)
  const version = (existsSync(versions) ? readdirSync(versions) : [])
    .filter((entry) => !entry.startsWith(".") && accepts(entry) && existsSync(join(versions, entry, ".corepack")))
    .sort(byRelease)
    .at(-1)
  if (version === undefined) {
    return { missing: `corepack keeps no ${wanted} in ${versions}: run \`corepack ${wanted} --version\` to keep one` }
  }
  return { name, version, directory: join(versions, version), program }
}

/** A corepack home under `parent` holding `release` alone, where corepack looks for it. */
export const homeWith = (parent: string, release: Release): string => {
  const home = join(parent, "corepack")
  cpSync(release.directory, join(home, "v1", release.name, release.version), { recursive: true })
  return home
}
