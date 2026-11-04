import type { BrowserContextOptions, BrowserType } from "@playwright/test"
import { readFile } from "node:fs/promises"

type Options = NonNullable<Parameters<BrowserType["launchPersistentContext"]>[1]>

/** Persistent WebKit has no storageState option: seed exactly the selected device's cookies. */
export const deviceCookies = async (
  state: BrowserContextOptions["storageState"],
  fallback: () => Promise<{ cookies: NonNullable<Exclude<BrowserContextOptions["storageState"], string>>["cookies"] }>,
) => {
  if (state === undefined) return (await fallback()).cookies
  if (typeof state !== "string") return state.cookies
  try {
    return (JSON.parse(await readFile(state, "utf8")) as Exclude<NonNullable<BrowserContextOptions["storageState"]>, string>).cookies
  } catch {
    throw new Error("The device's storage state is unreadable or invalid")
  }
}

/** macOS WebKit's OPFS follows Foundation's home, independently of its cookie/IndexedDB userDataDir. */
export const browserProfile = (
  browser: string,
  platform: string,
  directory: string,
  options: Options,
  environment: NodeJS.ProcessEnv,
): Options => ({
  ...options,
  ...(platform === "darwin" && browser === "webkit"
    ? { env: { ...(options.env ?? environment), CFFIXED_USER_HOME: directory } }
    : {}),
})
