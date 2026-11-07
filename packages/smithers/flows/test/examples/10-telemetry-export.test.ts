import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main } from "../../examples/10-telemetry-export.vibe"

const directory = mkdtempSync(join(tmpdir(), "flows-examples-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

/** A real collector bound to loopback for the lifetime of the test scope. */
const collector = (status: number) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const { createServer } = await import("node:http")
      const server = createServer((request, response) => {
        request.resume()
        response.writeHead(status).end("{}")
      })
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
      const address = server.address() as import("node:net").AddressInfo
      const forward = ((input: string | URL | Request, init?: RequestInit) =>
        fetch(`http://127.0.0.1:${address.port}${new URL(String(input)).pathname}`, init)) as typeof fetch
      return { server, forward }
    }),
    ({ server }) =>
      Effect.promise(() =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        })
      )
  )

it.live("exports granular spans and metrics from one added layer", () =>
  Effect.gen(function*() {
    const { forward } = yield* collector(200)
    const summary = yield* main(join(directory, "telemetry.sqlite"), forward)

    expect(summary.result).toBe("dist/server.tar")

    // The export is granular: flow lifecycle, engine dispatch, store
    // operations, and individual SQL statements all arrive as spans. Effect
    // names a statement's span for the database system and a transaction's
    // span `sql.transaction`.
    expect(summary.spanNames).toContain("examples/Ship.execute")
    expect(summary.spanNames).toContain("FlowEngine.actionExecute")
    expect(summary.spanNames).toContain("ActionPersistence.execute")
    expect(summary.spanNames).toContain("RunStore.claim")
    expect(summary.spanNames).toContain("Journal.emitDurable")
    expect(summary.spanNames).toContain("sqlite")
    expect(summary.spanNames).toContain("sql.transaction")
    expect(summary.spanNames).not.toContain("sql.execute")

    expect(summary.metricNames).toContain("flows_engine_dispatches")
    expect(summary.metricNames).toContain("flows_engine_dispatch_duration")

    // The journal and the tagged metric view read the same run without the
    // collector.
    expect(summary.journalEventTypes).toContain("flows.engine.attempt-finished")
    expect(summary.successfulDispatches).toBe(1)
  }))

it.live("does not report refused exports as received by the collector", () =>
  Effect.gen(function*() {
    const { forward } = yield* collector(400)
    const summary = yield* main(join(directory, "refused.sqlite"), forward)
    expect(summary.result).toBe("dist/server.tar")
    expect(summary.spanNames).toEqual([])
    expect(summary.metricNames).toEqual([])
  }))
