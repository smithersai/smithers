// Stays .ts: the Vitest configuration loads before the VibeLang plugin.
import { execFileSync } from "node:child_process"
import { accessSync, constants, statSync } from "node:fs"
import { delimiter, join } from "node:path"

export const nativeTools = ["flock", "Xvfb", "bun", "pnpm", "curl", "python3", "xdg-open"] as const

const executable = (path: string) => {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** The native wrapper links these libraries even when CEF renders its windows. */
export const nativeLibraries = [
  "libgtk-3.so.0",
  "libwebkit2gtk-4.1.so.0",
  "libayatana-appindicator3.so.1",
  "libX11.so.6",
  "libXtst.so.6",
  "libnss3.so",
  "libgbm.so.1",
  "libasound.so.2"
] as const

export function nativeLibrariesAvailable(python: string): boolean {
  try {
    execFileSync(
      python,
      ["-c", "import ctypes,sys; [ctypes.CDLL(name) for name in sys.argv[1:]]", ...nativeLibraries],
      {
        stdio: "pipe",
        timeout: 5_000
      }
    )
    return true
  } catch {
    return false
  }
}

/** Check prerequisites without building or starting the desktop fixture. */
export function nativeUnavailableReason(options: {
  platform: string
  bun: boolean
  path: string
  browser: () => string
  libraries?: () => boolean
}): string | undefined {
  if (options.bun) return "the native collector requires Node/V8"
  if (options.platform !== "linux") return "the native fixture requires Linux"
  const directories = options.path.split(delimiter).filter(Boolean)
  for (const tool of nativeTools) {
    if (!directories.some((directory) => executable(join(directory, tool)))) return `missing ${tool}`
  }
  const python = directories.map((directory) => join(directory, "python3")).find(executable)!
  if (!(options.libraries ?? (() => nativeLibrariesAvailable(python)))()) {
    return "missing native desktop shared libraries"
  }
  try {
    if (!executable(options.browser())) return "missing Playwright Chromium"
  } catch {
    return "missing Playwright Chromium"
  }
  return undefined
}
