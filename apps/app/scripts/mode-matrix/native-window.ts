import { randomUUID } from "node:crypto"
import { isAbsolute, resolve } from "node:path"
import { chromium } from "@playwright/test"
import type { Browser, Page } from "@playwright/test"
import { PackagedApp } from "../../e2e/packaged/PackagedApp"
import type { PackagedAppState } from "../../e2e/packaged/PackagedApp"
import type { DeploymentMode } from "../../e2e/real/coverage/types"

const ATTACH_TIMEOUT_MS = 30_000

export interface NativeWindowDriverEnvelope {
  readonly executable: string
  readonly cdpEndpoint: string
  readonly environment?: Readonly<Record<string, string>>
}

export interface NativeWindowDriverSession {
  readonly app: PackagedApp
  readonly browser: Browser
  readonly page: Page
  readonly state: PackagedAppState
  readonly rendererOrigin: string
  readonly targetNonce: string
  readonly close: () => Promise<void>
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const loopbackEndpoint = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("native driver cdpEndpoint must be a string")
  const endpoint = new URL(value)
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) {
    throw new Error("native driver cdpEndpoint must be a loopback HTTP endpoint")
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("native driver cdpEndpoint must not contain credentials, query, or fragment")
  }
  return endpoint.toString().replace(/\/$/, "")
}

export const parseNativeWindowDriverEnvelope = (
  raw: string,
  mode: Extract<DeploymentMode, "native-own" | "native-plue">,
  rootDirectory: string
): NativeWindowDriverEnvelope => {
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error("native driver environment must contain JSON") }
  if (!object(value) || typeof value.executable !== "string" || value.executable.trim() === "") {
    throw new Error("native driver environment requires executable and cdpEndpoint")
  }
  const executable = isAbsolute(value.executable) ? value.executable : resolve(rootDirectory, value.executable)
  let environment: Readonly<Record<string, string>> | undefined
  if (value.environment !== undefined) {
    if (!object(value.environment) || Object.values(value.environment).some((entry) => typeof entry !== "string")) {
      throw new Error("native driver environment.environment must contain only string values")
    }
    environment = value.environment as Readonly<Record<string, string>>
  }
  const backendMode = environment?.SMITHERS_BACKEND_MODE
  const expectedBackendMode = mode === "native-own" ? "own" : "plue"
  if (backendMode !== expectedBackendMode) {
    throw new Error(`${mode} native driver must set SMITHERS_BACKEND_MODE=${expectedBackendMode}`)
  }
  for (const reserved of ["SMITHERS_E2E_BRIDGE", "SMITHERS_E2E_BRIDGE_PORT", "SMITHERS_E2E_BRIDGE_TOKEN"]) {
    if (environment?.[reserved] !== undefined) throw new Error(`native driver environment may not set reserved ${reserved}`)
  }
  if (environment?.SMITHERS_CHAT_STUB === "1") {
    throw new Error("native matrix refuses the deterministic chat stub")
  }
  return { executable, cdpEndpoint: loopbackEndpoint(value.cdpEndpoint), ...(environment ? { environment } : {}) }
}

const pageForWindow = async (browser: Browser, windowUrl: string): Promise<Page> => {
  const deadline = Date.now() + ATTACH_TIMEOUT_MS
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      const page = context.pages().find((candidate) => candidate.url() === windowUrl)
      if (page !== undefined) return page
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error(`CDP did not expose the packaged window target ${windowUrl}`)
}

/**
 * Launches the stable Electrobun artifact, attaches Playwright to its actual
 * CEF webview, and correlates that target with the authenticated native bridge.
 * A browser opened separately at the backend origin cannot satisfy the nonce.
 */
export const launchNativeWindowDriver = async (options: {
  readonly envelope: NativeWindowDriverEnvelope
  readonly artifactsDirectory: string
}): Promise<NativeWindowDriverSession> => {
  const app = await PackagedApp.launch({
    executable: options.envelope.executable,
    artifactsDirectory: options.artifactsDirectory,
    env: options.envelope.environment,
    runtime: "product"
  })
  let browser: Browser | undefined
  try {
    await app.ready()
    const state = await app.state()
    if (!state.app.packaged || state.app.channel !== "stable") {
      throw new Error("native matrix requires a stable packaged Electrobun artifact")
    }
    if (state.window === null) throw new Error("native matrix found no packaged window")
    if (state.window.renderer !== "cef") {
      throw new Error(
        `packaged window renderer is ${state.window.renderer}; the shared Playwright scenarios require the issue12 CEF/CDP matrix artifact`
      )
    }
    if (state.window.url === null) throw new Error("packaged window did not report its renderer URL")
    browser = await chromium.connectOverCDP(options.envelope.cdpEndpoint, { timeout: ATTACH_TIMEOUT_MS })
    const page = await pageForWindow(browser, state.window.url)
    const nonce = randomUUID()
    await app.eval(`globalThis.__smithersNativeMatrixTarget = ${JSON.stringify(nonce)}; sessionStorage.setItem("smithersNativeMatrixTarget", ${JSON.stringify(nonce)})`)
    const attachedNonce = await page.evaluate(() =>
      (globalThis as typeof globalThis & { __smithersNativeMatrixTarget?: string }).__smithersNativeMatrixTarget)
    if (attachedNonce !== nonce) {
      throw new Error("CDP target did not correlate with the packaged window bridge")
    }
    await page.addInitScript((value) => {
      (globalThis as typeof globalThis & { __smithersNativeMatrixTarget?: string }).__smithersNativeMatrixTarget = value
      sessionStorage.setItem("smithersNativeMatrixTarget", value)
    }, nonce)
    const rendererOrigin = new URL(state.window.url).origin
    let closed = false
    return {
      app,
      browser,
      page,
      state,
      rendererOrigin,
      targetNonce: nonce,
      close: async () => {
        if (closed) return
        closed = true
        // The Electrobun process owns the CEF target. Closing the CDP Browser
        // would send Browser.close; package cleanup is the single owner.
        await app.cleanup()
      }
    }
  } catch (error) {
    await app.captureDiagnostics("native-window-attach-failure").catch(() => undefined)
    await app.cleanup().catch(() => undefined)
    throw error
  }
}
