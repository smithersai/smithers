import { expect, it } from "@effect/vitest"
import * as NodeHost from "@smthrs/platform-node/NodeHost"
import { Effect } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { vi } from "vitest"

// The facade contract is covered here with the injected driver on Node, and
// with Bun's own driver in the Bun lane; NativeRuntimeParity separately
// launches the real Bun driver and runtime.
vi.mock(
  "@smthrs/database/bun/BunDatabase",
  (importOriginal) =>
    process.versions.bun === undefined ? import("@smthrs/database/node/NodeDatabase") : importOriginal()
)

import * as BunRuntime from "../src/BunRuntime.ts"

it("composes the Bun facade over the same migrated SQL service and validates its configuration", async () => {
  const root = mkdtempSync(join(tmpdir(), "flows-bun-composition-"))
  try {
    const tables = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        return yield* sql`SELECT name FROM sqlite_master WHERE name = 'flows_runs'`
      }).pipe(
        Effect.provide(BunRuntime.storage(join(root, "flows.sqlite"))),
        Effect.provide(NodeHost.layer),
        Effect.provide(NodeHost.NodeCrypto.layer),
        Effect.scoped
      )
    )
    expect(tables).toEqual([{ name: "flows_runs" }])
    expect(() => BunRuntime.storage("")).toThrow("BunRuntime filename must be a non-empty string")
    expect(BunRuntime.signalExitCode("SIGTERM")).toBe(143)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
