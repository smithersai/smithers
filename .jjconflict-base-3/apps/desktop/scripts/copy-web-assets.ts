import { existsSync, statSync } from "node:fs"
import { join } from "node:path"

const webDistDir = join(import.meta.dir, "..", "..", "..", "dist", "web")
const webDistIndex = join(webDistDir, "index.html")

if (!existsSync(webDistDir) || !statSync(webDistDir).isDirectory()) {
  throw new Error(`[desktop][postBuild] Missing web dist directory: ${webDistDir}`)
}

if (!existsSync(webDistIndex)) {
  throw new Error(`[desktop][postBuild] Missing web dist entrypoint: ${webDistIndex}`)
}

const buildDir = process.env.ELECTROBUN_BUILD_DIR
if (buildDir && !existsSync(buildDir)) {
  throw new Error(`[desktop][postBuild] ELECTROBUN_BUILD_DIR does not exist: ${buildDir}`)
}

console.log(`[desktop][postBuild] Verified web dist source: ${webDistDir}`)
if (buildDir) {
  console.log(`[desktop][postBuild] Build directory: ${buildDir}`)
}
