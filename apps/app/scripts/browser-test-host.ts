import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { detectHarnessesWith } from "../src/bun/Harnesses"
import { createPtyManager } from "../src/bun/Pty"
import { startLocalServer } from "../src/bun/server"
import type { LocalServerOptions } from "../src/bun/server"
import { Effect } from "effect"
import type { HealthConfig } from "@smthrs/control/Health"

/** Opt-in semantic fixture: only an explicit control-delimited shell record is evidence of activity. */
const fixtureHealth: HealthConfig = {
  checkers: [{ id: "fixture.semantic", probe: (context) => {
    const marker = [...(context.session?.outputTail ?? "").matchAll(/\x1eSMITHERS_TEST_HEALTH:(working|idle|needs-input)\x1f/g)].at(-1)?.[1]
    const activity = marker === "working" || marker === "idle" || marker === "needs-input" ? marker : "unknown"
    return Effect.succeed({ activity, reason: activity === "needs-input" ? "awaiting-reply" : "ok" })
  } }],
  bindings: { terminal: { checkerId: "fixture.semantic", exposeOutput: true,
    policy: { intervalMs: 100, timeoutMs: 50, ttlMs: 2_000 } } }
}

/** Test-only composition. A stubbed model is not permission to inspect host credentials. */
export const browserTestOptions = (
  root: string,
  distDir: string,
  env: Readonly<Record<string, string | undefined>>
): LocalServerOptions => {
  const port = Number(env.SMITHERS_LOCAL_PORT ?? "0")
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid browser-test server port")
  const hostHarnesses = env.SMITHERS_E2E_HOST_HARNESSES === "1"
  const realChat = env.SMITHERS_CHAT_STUB === "0"
  return {
    port,
    distDir,
    chatStub: !realChat,
    cloudMode: realChat ? "hybrid" : "offline",
    cloudApi: null,
    identityUpstream: null,
    stateDir: join(root, "state"),
    allowManualRepositoryPaths: true,
    ...(env.SMITHERS_E2E_HEALTH === "1" ? { health: fixtureHealth } : {}),
    ...(hostHarnesses ? {} : {
      home: root,
      harnesses: () =>
        detectHarnessesWith({
          home: root,
          env: {},
          platform: process.platform,
          listDir: () => [],
          isFile: () => false,
          readText: () => null,
          version: async () => null
        }),
      pty: (deps) => createPtyManager({ ...deps, home: root, tmpdir: root, env: {}, shell: "/bin/sh" })
    })
  }
}

export const startBrowserTestHost = async (
  distDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env
) => {
  const root = await mkdtemp(join(tmpdir(), "smithers-browser-test-"))
  // Retain the owned fixture if startup fails: a partial server startup has
  // not yet handed us its shutdown handle, so deleting underneath it is unsafe.
  const server = await startLocalServer(browserTestOptions(root, distDir, env))
  let stopping: Promise<void> | undefined
  return {
    ...server,
    stop: (): Promise<void> => stopping ??= server.stop().then(() => rm(root, { recursive: true, force: true }))
  }
}
