import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { PackagedApp } from "../../e2e/packaged/PackagedApp"
import { existingNativeWindowTargetId } from "./native-window"
import type { ExecutionReceipt, ModeConfig } from "../../e2e/real/coverage/matrix"

export interface NativePlueSession {
  readonly modeConfig: ModeConfig
  readonly runtimeEnvironment: Readonly<Record<string, string>>
  readonly close: () => Promise<void>
}

export const startNativePlue = async (
  revision: string,
  outputDir: string,
  executable: string,
  cdpEndpoint: string,
  target: string,
  tokenEnvironment: string
): Promise<NativePlueSession> => {
  if (process.platform !== "darwin") throw new Error("native-plue requires the macOS packaged app")
  if (!/^[0-9a-f]{40,64}$/.test(revision)) throw new Error("native-plue requires an exact revision")
  const origin = new URL(target)
  if (!/^https?:$/.test(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("native-plue requires a credential-free Plue origin")
  }
  const token = process.env[tokenEnvironment]?.trim()
  if (!token) throw new Error(`native-plue requires ${tokenEnvironment}`)
  const packagePath = resolve(executable)
  if (!packagePath.includes(".app/Contents/MacOS/launcher") || !existsSync(packagePath)) {
    throw new Error("native-plue requires the packaged Smithers.app launcher")
  }
  const root = mkdtempSync(join(tmpdir(), "smithers-matrix-native-plue-"))
  const home = join(root, "home")
  mkdirSync(home)
  let app: PackagedApp | undefined
  const close = async (): Promise<void> => {
    try { await app?.cleanup() } finally { rmSync(root, { recursive: true, force: true }) }
  }
  try {
    app = await PackagedApp.launch({
      executable: packagePath,
      stateDirectory: home,
      artifactsDirectory: join(outputDir, "native-plue-diagnostics"),
      runtime: "product",
      startupTimeoutMs: 180_000,
      env: {
        SMITHERS_BACKEND_MODE: "plue", SMITHERS_API_ORIGIN: origin.origin,
        SMITHERS_API_TOKEN: token,
        SMITHERS_BACKEND_BINARY: "/definitely/missing/backend",
        SMITHERS_POSTGRES_BUNDLE_DIR: "/definitely/missing/postgres"
      }
    })
    await app.ready()
    const state = await app.state()
    if (!state.app.packaged || state.window?.renderer !== "cef" || !state.window.url) {
      throw new Error("native-plue requires a packaged CEF window")
    }
    if (existsSync(join(home, "Library", "Application Support", "Smithers"))) {
      throw new Error("native-plue unexpectedly created owned backend or PostgreSQL state")
    }
    const targetId = await existingNativeWindowTargetId(cdpEndpoint, state.window.url)
    const receiptPath = join(outputDir, "native-plue.execution.json")
    const receipt: ExecutionReceipt = {
      mode: "native-plue", revision, origin: origin.origin, endpoint: origin.origin, ready: true,
      startedRoles: ["native-ui"], freshLaunch: true, restarted: false, dataPreserved: false,
      observedAt: new Date().toISOString()
    }
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
    const driverEnvironment = "SMITHERS_NATIVE_PLUE_DRIVER"
    const modeConfig: ModeConfig = {
      mode: "native-plue", origin: origin.origin, endpoint: origin.origin,
      auth: { kind: "application-token", environment: tokenEnvironment },
      executionReceipt: receiptPath,
      surfaceDriver: { kind: "electrobun-cdp", environment: driverEnvironment }
    }
    return {
      modeConfig,
      runtimeEnvironment: {
        [driverEnvironment]: JSON.stringify({ executable: packagePath, cdpEndpoint, environment: {
          SMITHERS_BACKEND_MODE: "plue", SMITHERS_API_ORIGIN: origin.origin, SMITHERS_API_TOKEN: token
        } }),
        SMITHERS_NATIVE_MATRIX_PRELAUNCHED: "native-plue",
        SMITHERS_REAL_NATIVE_CDP_ENDPOINT: cdpEndpoint,
        SMITHERS_REAL_NATIVE_WINDOW_URL: state.window.url,
        SMITHERS_REAL_NATIVE_TARGET_ID: targetId
      },
      close
    }
  } catch (error) {
    await close()
    throw error
  }
}
