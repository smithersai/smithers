/*
 * The Node sidecar probe (LOCAL-APP.md, "Targets: load and run"). The
 * `smithers-build` loader runs only under the runtimes its engines field
 * allows, and a Finder launch gets the launchd PATH, so the probe walks
 * explicit candidates rather than trusting PATH alone. Every host read is
 * injectable so the order and the version gate can be asserted without a
 * machine's node installs.
 */
import { readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"

/** The lowest runtime the sidecar accepts, on the oldest supported major. */
export const MIN_NODE_VERSION = "22.19.0"

/*
 * One row per supported Node major, mirroring the sidecar's engines field
 * (packages/smithers/build/build-cli/package.json: "node": "^22.19.0 ||
 * >=24.11.0"). A major with a row has to clear that row's floor; a major above
 * the last row is accepted whole, which is what `>=24.11.0` means. Node 23
 * shipped no LTS line and 24.0 through 24.10 are excluded, so the single floor
 * this replaced handed the loader runtimes it refuses to run under.
 */
export const SUPPORTED_NODE_LINES = [
  { major: 22, floor: MIN_NODE_VERSION },
  { major: 24, floor: "24.11.0" }
] as const satisfies ReadonlyArray<{ readonly major: number; readonly floor: string }>

export interface NodeSidecar {
  readonly path: string
  readonly version: string
}

export interface NodeProbeHost {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly home: string
  /** Entries of a directory, or [] when it does not exist. */
  readonly listDir: (dir: string) => ReadonlyArray<string>
  readonly isFile: (path: string) => boolean
  /** `node --version` for the candidate, or null when it cannot run. */
  readonly version: (path: string) => Promise<string | null>
}

const parseVersion = (raw: string): [number, number, number] | null => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim())
  if (match === null) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export const compareVersions = (left: string, right: string): number => {
  const a = parseVersion(left) ?? [0, 0, 0]
  const b = parseVersion(right) ?? [0, 0, 0]
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return (a[index] ?? 0) - (b[index] ?? 0)
  }
  return 0
}

/** Whether a `node --version` string satisfies SUPPORTED_NODE_LINES. */
export const meetsMinimum = (version: string): boolean => {
  const parsed = parseVersion(version)
  if (parsed === null) return false
  const [major] = parsed
  const line = SUPPORTED_NODE_LINES.find((entry) => entry.major === major)
  if (line !== undefined) return compareVersions(version, line.floor) >= 0
  const newest = SUPPORTED_NODE_LINES[SUPPORTED_NODE_LINES.length - 1]
  return newest !== undefined && major > newest.major
}

const nvmCandidates = (host: NodeProbeHost): ReadonlyArray<string> => {
  const root = join(host.home, ".nvm", "versions", "node")
  return [...host.listDir(root)]
    .filter((entry) => parseVersion(entry) !== null)
    .sort((left, right) => compareVersions(right, left))
    .map((entry) => join(root, entry, "bin", "node"))
}

const fnmCandidates = (host: NodeProbeHost): ReadonlyArray<string> => {
  const root = join(host.home, ".local", "share", "fnm")
  const found: Array<string> = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return
    for (const entry of host.listDir(dir)) {
      const child = join(dir, entry)
      if (entry === "bin") {
        const node = join(child, "node")
        if (host.isFile(node)) found.push(node)
        continue
      }
      walk(child, depth + 1)
    }
  }
  walk(root, 0)
  return found.sort((left, right) => compareVersions(right, left))
}

/**
 * The probe order: SMITHERS_NODE, PATH, nvm (highest first), homebrew,
 * /usr/local, volta, fnm. Duplicates keep their first position.
 */
export const nodeCandidates = (host: NodeProbeHost): ReadonlyArray<string> => {
  const explicit = host.env.SMITHERS_NODE?.trim()
  const fromPath = (host.env.PATH ?? "").split(delimiter).filter((dir) => dir !== "").map((dir) => join(dir, "node"))
  const ordered = [
    ...(explicit === undefined || explicit === "" ? [] : [explicit]),
    ...fromPath,
    ...nvmCandidates(host),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    join(host.home, ".volta", "bin", "node"),
    ...fnmCandidates(host)
  ]
  return [...new Set(ordered)]
}

/** The first candidate that exists and reports a supported version. */
export const findNodeWith = async (host: NodeProbeHost): Promise<NodeSidecar | null> => {
  for (const candidate of nodeCandidates(host)) {
    if (!host.isFile(candidate)) continue
    const version = await host.version(candidate)
    if (version === null || !meetsMinimum(version)) continue
    return { path: candidate, version: version.trim() }
  }
  return null
}

const runVersion = async (path: string): Promise<string | null> => {
  try {
    const child = Bun.spawn([path, "--version"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" })
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
    return code === 0 && parseVersion(stdout) !== null ? stdout.trim() : null
  } catch {
    return null
  }
}

export const currentNodeProbeHost = (env: Readonly<Record<string, string | undefined>> = Bun.env): NodeProbeHost => ({
  env,
  home: env.HOME ?? homedir(),
  listDir: (dir) => {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  },
  isFile: (path) => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  },
  version: runVersion
})

export const findNode = (env?: Readonly<Record<string, string | undefined>>): Promise<NodeSidecar | null> =>
  findNodeWith(currentNodeProbeHost(env))
