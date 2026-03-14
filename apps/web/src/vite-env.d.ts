/// <reference types="vite/client" />
/// <reference types="bun-types" />

type BurnsStartupError = {
  title?: unknown
  message?: unknown
  details?: unknown
}

type BurnsRuntimeConfig = {
  burnsApiUrl?: unknown
  runtimeMode?: "dev" | "desktop" | "cli"
}

interface Window {
  __BURNS_RUNTIME_CONFIG__?: BurnsRuntimeConfig
  __BURNS_STARTUP_ERROR__?: BurnsStartupError
}

interface ImportMetaEnv {
  readonly VITE_BURNS_API_URL?: string
}
