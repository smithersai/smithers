import { resolveApplicationTarget } from "@smthrs/rpc/ApplicationTarget"
import type { ApplicationTargetDocument } from "@smthrs/rpc/ApplicationTarget"

export interface NativeBackendConfig {
  readonly rendererOrigin: string
  readonly target: ApplicationTargetDocument
  readonly token: string | null
}

const origin = (name: string, value: string | undefined): string => {
  const raw = value?.trim()
  if (raw === undefined || raw === "") throw new Error(`${name} is required.`)
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) origin.`)
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== raw.replace(/\/$/, "")) {
    throw new Error(`${name} must be an absolute HTTP(S) origin without a path.`)
  }
  return parsed.origin
}

/**
 * Consume the package supervisor handshake. This function never launches a
 * database or backend; issue12 supplies SMITHERS_BACKEND_ORIGIN for own mode.
 */
export const nativeBackendConfig = (env: Readonly<Record<string, string | undefined>>): NativeBackendConfig => {
  const backend = env.SMITHERS_BACKEND_MODE?.trim() || "own"
  if (backend !== "own" && backend !== "plue") throw new Error("SMITHERS_BACKEND_MODE must be own or plue.")
  const apiOrigin = origin(
    backend === "own" ? "SMITHERS_BACKEND_ORIGIN" : "SMITHERS_API_ORIGIN",
    backend === "own" ? env.SMITHERS_BACKEND_ORIGIN : env.SMITHERS_API_ORIGIN
  )
  const rendererOrigin =
    env.SMITHERS_RENDERER_ORIGIN?.trim() === undefined || env.SMITHERS_RENDERER_ORIGIN?.trim() === ""
      ? apiOrigin
      : origin("SMITHERS_RENDERER_ORIGIN", env.SMITHERS_RENDERER_ORIGIN)
  const external = apiOrigin !== rendererOrigin
  const token = env.SMITHERS_API_TOKEN?.trim() || null
  const auth = token === null ? "session" : backend === "plue" ? "bearer" : "token"
  const document: ApplicationTargetDocument = {
    apiVersion: 1,
    mode: backend === "own" ? "native-own" : "native-plue",
    apiOrigin,
    auth: { kind: auth },
    cors: external ? "credentialed" : "same-origin",
    developerExternal: false
  }
  // Run the shared validator here too; a malformed package handshake never opens a window.
  resolveApplicationTarget(document, rendererOrigin)
  return { rendererOrigin, target: document, token }
}
