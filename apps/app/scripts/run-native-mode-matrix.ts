#!/usr/bin/env bun
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseNativeWindowDriverEnvelope, launchNativeWindowDriver } from "./mode-matrix/native-window"
import type { DeploymentMode } from "../e2e/real/coverage/types"

const appDir = fileURLToPath(new URL("../", import.meta.url))
const rootDir = resolve(appDir, "../..")
const mode = process.env.SMITHERS_REAL_E2E_MODE as DeploymentMode | undefined
if (mode !== "native-own" && mode !== "native-plue") {
  throw new Error("run-native-mode-matrix requires SMITHERS_REAL_E2E_MODE=native-own|native-plue")
}
const environmentName = process.env.SMITHERS_NATIVE_MATRIX_DRIVER_ENVIRONMENT?.trim()
if (!environmentName || !/^[A-Z][A-Z0-9_]+$/.test(environmentName)) {
  throw new Error("SMITHERS_NATIVE_MATRIX_DRIVER_ENVIRONMENT must name the native driver JSON environment variable")
}
const raw = process.env[environmentName]
if (!raw) throw new Error(`${environmentName} is required for the native matrix driver`)
const apiOrigin = process.env.SMITHERS_REAL_API_ORIGIN?.trim()
if (!apiOrigin) throw new Error("SMITHERS_REAL_API_ORIGIN is required for the native matrix driver")
const artifactsDirectory = resolve(
  process.env.SMITHERS_REAL_NATIVE_ARTIFACTS ??
    resolve(appDir, "test-results", "mode-matrix", `${mode}-native-window`)
)
mkdirSync(artifactsDirectory, { recursive: true })

const envelope = parseNativeWindowDriverEnvelope(raw, mode, rootDir)
if (mode === "native-plue") {
  const packagedOrigin = envelope.environment?.SMITHERS_API_ORIGIN?.replace(/\/$/, "")
  if (packagedOrigin !== new URL(apiOrigin).origin) {
    throw new Error("native-plue package SMITHERS_API_ORIGIN does not match the matrix API origin")
  }
  if (process.env.SMITHERS_REAL_AUTH_KIND !== "application-token") {
    throw new Error("native-plue requires application-token auth")
  }
  const tokenEnvironment = process.env.SMITHERS_REAL_AUTH_ENVIRONMENT
  const matrixToken = tokenEnvironment ? process.env[tokenEnvironment]?.trim() : undefined
  if (!matrixToken || envelope.environment?.SMITHERS_API_TOKEN !== matrixToken) {
    throw new Error("native-plue package token does not match the matrix application-token reference")
  }
}
const session = await launchNativeWindowDriver({ envelope, artifactsDirectory })
let exitCode = 1
try {
  const child = Bun.spawn(["bun", "scripts/run-real-e2e.ts"], {
    cwd: appDir,
    env: {
      ...process.env,
      ...envelope.environment,
      SMITHERS_REAL_BASE_URL: session.rendererOrigin,
      SMITHERS_REAL_API_ORIGIN: apiOrigin,
      SMITHERS_REAL_NATIVE_CDP_ENDPOINT: envelope.cdpEndpoint,
      SMITHERS_REAL_NATIVE_WINDOW_URL: session.state.window!.url!,
      SMITHERS_REAL_NATIVE_TARGET_NONCE: session.targetNonce
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit"
  })
  exitCode = await child.exited
} finally {
  await session.close()
}
process.exit(exitCode)
