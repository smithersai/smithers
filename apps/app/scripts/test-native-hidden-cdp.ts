import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { launchNativeWindowDriver } from "./mode-matrix/native-window"

const executable = resolve(process.argv[2] ?? "")
const cdpEndpoint = process.argv[3]
if (!executable.includes(".app/Contents/MacOS/launcher") || !existsSync(executable) || !cdpEndpoint) {
  throw new Error("Pass a packaged CEF launcher and its loopback CDP endpoint.")
}

const backend = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) =>
  new URL(request.url).pathname === "/api/bootstrap"
    ? Response.json({ apiVersion: 1, host: "cloud", version: "test", buildSha: "test",
      capabilities: [], authFlow: "none", sandbox: null })
    : new Response("not found", { status: 404 })
})
const artifactsDirectory = mkdtempSync(join(tmpdir(), "smithers-native-hidden-cdp-"))
let session: Awaited<ReturnType<typeof launchNativeWindowDriver>> | undefined
try {
  session = await launchNativeWindowDriver({
    envelope: {
      executable,
      cdpEndpoint,
      environment: {
        SMITHERS_BACKEND_MODE: "plue",
        SMITHERS_API_ORIGIN: `http://127.0.0.1:${backend.port}`,
        SMITHERS_BACKEND_BINARY: "/definitely/missing/backend",
        SMITHERS_POSTGRES_BUNDLE_DIR: "/definitely/missing/postgres"
      }
    },
    artifactsDirectory
  })
  await session.page.waitForFunction(() => document.querySelector("#root")?.children.length)
  console.log(`NATIVE_HIDDEN_CDP_OK pid=${session.state.app.pid} target=${session.targetId}`)
} finally {
  await session?.close()
  backend.stop(true)
  rmSync(artifactsDirectory, { recursive: true, force: true })
}
