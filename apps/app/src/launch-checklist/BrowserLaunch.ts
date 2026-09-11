/*
 * Launch checklist (U7) — how the headless page driver finds and starts a
 * browser. Discovery and the argv it builds are pure, so they are tested here;
 * the spawn/socket glue lives in scripts/headless-page.ts.
 *
 * No new dependency: the driver speaks the DevTools protocol to a system
 * Chrome the same way scripts/web-chat-e2e.ts already does. Nothing is
 * downloaded and nothing is installed by a checklist run.
 */

/** Where a system Chrome/Chromium usually lives, most-preferred first. */
export const BROWSER_CANDIDATES: ReadonlyArray<string> = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser"
]

export interface DiscoveryOptions {
  /** `--browser <path>`, which wins over everything. */
  readonly explicit?: string | undefined
  readonly env: Readonly<Record<string, string | undefined>>
  readonly exists: (path: string) => boolean
}

/**
 * The browser binary to drive, or undefined when the machine has none. An
 * explicit path is returned even if `exists` says no, so a wrong `--browser`
 * fails loudly at spawn instead of silently falling back to another browser.
 */
export const findBrowser = ({ explicit, env, exists }: DiscoveryOptions): string | undefined => {
  if (explicit !== undefined && explicit !== "") return explicit
  const fromEnv = env.CHECKLIST_BROWSER
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv
  return BROWSER_CANDIDATES.find((candidate) => exists(candidate))
}

export const NO_BROWSER_REASON =
  `no Chrome/Chromium binary found for the headless page driver — pass --browser <path>, set $CHECKLIST_BROWSER, or install one of: ${
    BROWSER_CANDIDATES.join(", ")
  }`

export const NO_BROWSER_REQUESTED_REASON = "--no-browser was passed, so no headless page was opened for this row"

export const browserArgv = (binary: string, port: number, userDataDir: string): ReadonlyArray<string> => [
  binary,
  "--headless=new",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userDataDir}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "about:blank"
]

/** PUT this to open a fresh DevTools target on `url` and get its websocket back. */
export const newTargetUrl = (port: number, url: string): string =>
  `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`
