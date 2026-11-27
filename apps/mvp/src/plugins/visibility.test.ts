// The host's visibility subscription (decision 0110, the data gate): a gated query hears every session change and
// every role change while it listens, and none after it stops.
import { Effect } from "effect"
import { expect, test } from "vitest"
import { AuthStore, SESSION } from "../features/auth/store.vibe"
import { openTestApp } from "../test/chatApi"
import { Plugins } from "./plugins"

test("a signed-in host tells a listener of each session change until it stops listening", async () => {
  const runtime = openTestApp({ plugins: [], answers: false })
  try {
    const host = await runtime.runPromise(Effect.service(Plugins))
    const { session, sessionState } = await runtime.runPromise(Effect.service(AuthStore))
    await session.tanstack.preload()
    await sessionState.tanstack.preload()
    await expect.poll(() => session.tanstack.get(SESSION)?.status ?? "loading").not.toBe("loading")
    let told = 0
    const stop = host.onVisibility(() => { told++ })
    // The test app signs its member in: a role change is a session change.
    await runtime.runPromise(session.update(SESSION, (row) => {
      Object.assign(row, { role: "admin" })
    }))
    await expect.poll(() => told).toBeGreaterThan(0)
    stop()
    const before = told
    await runtime.runPromise(session.update(SESSION, (row) => {
      Object.assign(row, { login: "someone-else" })
    }))
    await Effect.runPromise(Effect.sleep("50 millis"))
    expect(told).toBe(before)
  } finally {
    await runtime.dispose()
  }
})
