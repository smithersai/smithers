import { burnsTrayStatusSchema, type BurnsTrayStatus } from "@burns/shared"

export const DEFAULT_TRAY_STATUS: BurnsTrayStatus = {
  pendingCount: 0,
  runningCount: 0,
  pendingTarget: null,
}

const LIGHT_MODE_TRAY_ICON = "views://tray/favicon-black.png"
const DARK_MODE_TRAY_ICON = "views://tray/favicon-white.png"

function isDarkModeOnMac() {
  if (process.platform !== "darwin") {
    return false
  }

  const result = Bun.spawnSync(["defaults", "read", "-g", "AppleInterfaceStyle"], {
    stdout: "pipe",
    stderr: "pipe",
  })

  if (result.exitCode !== 0) {
    return false
  }

  const output = new TextDecoder().decode(result.stdout).trim().toLowerCase()
  return output.includes("dark")
}

export function resolveTrayIconPath() {
  return isDarkModeOnMac() ? DARK_MODE_TRAY_ICON : LIGHT_MODE_TRAY_ICON
}

export async function fetchTrayStatus(baseUrl: string): Promise<BurnsTrayStatus> {
  const response = await fetch(new URL("/api/system/tray-status", baseUrl), {
    headers: {
      "cache-control": "no-cache",
    },
  })

  if (!response.ok) {
    throw new Error(`Failed to fetch tray status: ${response.status}`)
  }

  return burnsTrayStatusSchema.parse(await response.json())
}

export function buildInAppNavigationScript(pathname: string) {
  const payload = JSON.stringify(pathname)
  return `(() => {
    const nextPath = ${payload};
    if (window.location.pathname === nextPath) {
      return;
    }

    window.history.replaceState(window.history.state ?? null, "", nextPath);
    window.dispatchEvent(new PopStateEvent("popstate"));
  })();`
}
