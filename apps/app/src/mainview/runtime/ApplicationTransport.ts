import type { FetchLike } from "@smthrs/rpc/NativeAgent"
import { createApplicationClient } from "./ApplicationClient"
import type { ApplicationClient } from "./ApplicationClient"
import { loadApplicationTarget } from "./ApplicationTargetRuntime"
import { createAppFetch } from "./LocalSession"

export const DEVELOPER_API_TOKEN_KEY = "smithers.developer-api-token"

const developerToken = (): string | undefined => {
  try {
    return globalThis.sessionStorage?.getItem(DEVELOPER_API_TOKEN_KEY) ?? undefined
  } catch {
    return undefined
  }
}

let clientRead: Promise<ApplicationClient> | undefined

const nativeRuntimeAvailable = (): boolean => typeof window !== "undefined" && window.__electrobun !== undefined

const nativeTarget = async () => (await import("../native/NativeBridge")).nativeApplicationTarget()

const nativeToken = async () => (await import("../native/NativeBridge")).nativeApplicationToken()

/** One runtime-selected transport, shared by preload, bootstrap, and controllers. */
export const loadRuntimeApplicationClient = (): Promise<ApplicationClient> => {
  if (clientRead !== undefined) return clientRead
  const native = nativeRuntimeAvailable()
  clientRead = loadApplicationTarget({
    native: native ? nativeTarget : undefined
  }).then((target) =>
    createApplicationClient(target, {
      fetchImpl: createAppFetch(),
      token: native ? nativeToken : developerToken
    })
  )
  void clientRead.catch(() => {
    clientRead = undefined
  })
  return clientRead
}

/** Async adapter for startup services that are created before target resolution settles. */
export const runtimeApplicationFetch: FetchLike = async (input, init) =>
  (await loadRuntimeApplicationClient()).fetch(input, init)
