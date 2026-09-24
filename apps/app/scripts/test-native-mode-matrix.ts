import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { startNativeOwn } from "./mode-matrix/native-own"
import { startNativePlue } from "./mode-matrix/native-plue"
import { probeMode } from "../e2e/real/coverage/matrix"

const executable = process.argv[2]?.trim()
const revision = process.env.SMITHERS_BUILD_SHA?.trim()
const cdpEndpoint = process.env.SMITHERS_MODE_MATRIX_NATIVE_CDP_ENDPOINT?.trim()
if (!executable || !revision || !cdpEndpoint) {
  throw new Error("test-native-mode-matrix requires a packaged launcher, SMITHERS_BUILD_SHA, and SMITHERS_MODE_MATRIX_NATIVE_CDP_ENDPOINT")
}
const outputDir = resolve(import.meta.dir, "..", process.env.SMITHERS_MODE_MATRIX_OUTPUT_DIR ?? "test-results/mode-matrix")
mkdirSync(outputDir, { recursive: true })
const session = await startNativeOwn(revision, outputDir, executable, cdpEndpoint)
try {
  const readiness = await probeMode(session.modeConfig, revision, { ...process.env, ...session.runtimeEnvironment })
  if (readiness.status !== "passed") throw new Error(`native-own readiness failed: ${readiness.reasons.join("; ")}`)
  console.log(`NATIVE_MATRIX_LAUNCH_OK receipt=${session.modeConfig.executionReceipt}`)
} finally {
  await session.close()
}
const plueURL = process.env.SMITHERS_MODE_MATRIX_PLUE_URL?.trim()
const plueToken = process.env.SMITHERS_MODE_MATRIX_PLUE_TOKEN?.trim()
if (Boolean(plueURL) !== Boolean(plueToken)) {
  throw new Error("native-plue requires both SMITHERS_MODE_MATRIX_PLUE_URL and SMITHERS_MODE_MATRIX_PLUE_TOKEN")
}
if (plueURL && plueToken) {
  const plue = await startNativePlue(revision, outputDir, executable, cdpEndpoint, plueURL, "SMITHERS_MODE_MATRIX_PLUE_TOKEN")
  try {
    const readiness = await probeMode(plue.modeConfig, revision, { ...process.env, ...plue.runtimeEnvironment })
    if (readiness.status !== "passed") throw new Error(`native-plue readiness failed: ${readiness.reasons.join("; ")}`)
    console.log(`NATIVE_PLUE_MATRIX_LAUNCH_OK receipt=${plue.modeConfig.executionReceipt}`)
  } finally {
    await plue.close()
  }
}
