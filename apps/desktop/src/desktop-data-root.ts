import path from "node:path"
import { homedir } from "node:os"

type ResolveDesktopDataRootOptions = {
  env?: NodeJS.ProcessEnv
  homeDirectory?: string
  platform?: NodeJS.Platform
}

export function resolveDesktopDataRoot(options: ResolveDesktopDataRootOptions = {}) {
  const env = options.env ?? process.env
  const configuredDataRoot = env.BURNS_DESKTOP_DATA_ROOT?.trim()
  if (configuredDataRoot) {
    return path.resolve(configuredDataRoot)
  }

  const sharedDataRoot = env.BURNS_DATA_ROOT?.trim()
  if (sharedDataRoot) {
    return path.resolve(sharedDataRoot)
  }

  const homeDirectory = options.homeDirectory ?? homedir()
  return path.join(homeDirectory, ".burns")
}
