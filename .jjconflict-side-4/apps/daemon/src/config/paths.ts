import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

type ResolveDataRootOptions = {
  env?: NodeJS.ProcessEnv
  homeDirectory?: string
}

type ResolveWorkspaceRootOptions = {
  env?: NodeJS.ProcessEnv
  homeDirectory?: string
}

const configDir = path.dirname(fileURLToPath(import.meta.url))
const daemonRoot = path.resolve(configDir, "../..")
const repositoryRoot = path.resolve(daemonRoot, "../..")

export function resolveBurnsDataRoot(options: ResolveDataRootOptions = {}) {
  const env = options.env ?? process.env
  const configuredDataRoot = env.BURNS_DATA_ROOT?.trim()
  if (configuredDataRoot) {
    return path.resolve(configuredDataRoot)
  }

  const homeDirectory = options.homeDirectory ?? homedir()
  return path.join(homeDirectory, ".burns")
}

export function resolveDefaultWorkspaceRoot(options: ResolveWorkspaceRootOptions = {}) {
  const env = options.env ?? process.env
  const configuredWorkspaceRoot = env.BURNS_WORKSPACES_ROOT?.trim()
  if (configuredWorkspaceRoot) {
    return path.resolve(configuredWorkspaceRoot)
  }

  const homeDirectory = options.homeDirectory ?? homedir()
  return path.join(homeDirectory, "Documents", "Burns")
}

export const DAEMON_ROOT = daemonRoot
export const REPOSITORY_ROOT = repositoryRoot
export const DATA_ROOT = resolveBurnsDataRoot()
export const DATABASE_PATH = path.join(DATA_ROOT, "burns.sqlite")
export const DEFAULT_WORKSPACES_ROOT = resolveDefaultWorkspaceRoot()

mkdirSync(DATA_ROOT, { recursive: true })
mkdirSync(DEFAULT_WORKSPACES_ROOT, { recursive: true })
