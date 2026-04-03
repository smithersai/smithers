import type { BurnsRuntimeConfig } from "./runtime-config";

declare global {
  interface Window {
    __BURNS_RUNTIME_CONFIG__?: BurnsRuntimeConfig;
  }
}

export {};
