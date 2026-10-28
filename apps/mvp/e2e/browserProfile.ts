import type { BrowserType } from "@playwright/test"

type Options = NonNullable<Parameters<BrowserType["launchPersistentContext"]>[1]>

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
