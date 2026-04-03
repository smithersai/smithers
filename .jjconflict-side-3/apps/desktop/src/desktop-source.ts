export const DESKTOP_BUNDLED_URL = "views://mainview/index.html"
export const DEFAULT_DESKTOP_VITE_URL = "http://localhost:5173"

export type DesktopDevSource = "views" | "vite"

type ResolveDesktopSourceUrlOptions = {
  devSource?: DesktopDevSource
  viteUrl?: string
  canReach?: (url: string) => Promise<boolean>
}

export function resolveDesktopDevSource(rawValue: string | undefined): DesktopDevSource {
  return rawValue === "vite" ? "vite" : "views"
}

function parseViteUrl(candidate: string | undefined): string {
  const rawValue = candidate?.trim()
  if (!rawValue) {
    return DEFAULT_DESKTOP_VITE_URL
  }

  try {
    const parsed = new URL(rawValue)
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return rawValue
    }
  } catch {
    // fall through to default
  }

  return DEFAULT_DESKTOP_VITE_URL
}

export function resolveDesktopViteUrl(rawValue: string | undefined): string {
  return parseViteUrl(rawValue)
}

async function canReachDesktopUrl(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      headers: {
        "cache-control": "no-cache",
      },
    })

    return response.status < 500
  } catch {
    return false
  }
}

export async function resolveDesktopSourceUrl(
  options: ResolveDesktopSourceUrlOptions = {}
): Promise<string> {
  const devSource = options.devSource ?? resolveDesktopDevSource(process.env.BURNS_DESKTOP_DEV_SOURCE)
  if (devSource === "views") {
    return DESKTOP_BUNDLED_URL
  }

  const viteUrl = options.viteUrl ?? resolveDesktopViteUrl(process.env.BURNS_DESKTOP_DEV_VITE_URL)
  const canReach = options.canReach ?? canReachDesktopUrl

  if (await canReach(viteUrl)) {
    return viteUrl
  }

  console.warn(
    `[desktop] Vite URL is not reachable (${viteUrl}), falling back to ${DESKTOP_BUNDLED_URL}`
  )
  return DESKTOP_BUNDLED_URL
}
