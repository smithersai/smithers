import { expect, it } from "@effect/vitest"
import * as NodeHost from "@smthrs/platform-node/NodeHost"
import { Cause, Effect, Exit } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs"
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

const tables = (filename: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    return yield* sql`SELECT name FROM sqlite_master WHERE name = 'flows_runs'`
  }).pipe(
    Effect.provide(BunRuntime.storage(filename)),
    Effect.provide(NodeHost.layer),
    Effect.provide(NodeHost.NodeCrypto.layer),
    Effect.scoped
  )

it("composes the Bun facade over the same migrated SQL service and validates its configuration", async () => {
  const root = mkdtempSync(join(tmpdir(), "flows-bun-composition-"))
  try {
    expect(await Effect.runPromise(tables(join(root, "flows.sqlite")))).toEqual([{ name: "flows_runs" }])
    expect(() => BunRuntime.storage("")).toThrow("BunRuntime filename must be a non-empty string")
    expect(BunRuntime.signalExitCode("SIGTERM")).toBe(143)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// A fresh store is initialized privately and published whole, as NodeRuntime
// does, so a store at its final name is always complete (#4785).
it("refuses a dangling link at a fresh store's name instead of creating and migrating its target in place", async () => {
  const root = mkdtempSync(join(tmpdir(), "flows-bun-publication-link-"))
  try {
    const filename = join(root, "flows.sqlite")
    const target = join(root, "elsewhere.sqlite")
    symlinkSync(target, filename)
    const exit = await Effect.runPromiseExit(tables(filename))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({ reason: { _tag: "AlreadyExists" } })
    expect(existsSync(target)).toBe(false)
    expect(readdirSync(root)).toEqual(["flows.sqlite"])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it("two cold starts on one fresh path converge on a single published store", async () => {
  const root = mkdtempSync(join(tmpdir(), "flows-bun-publication-race-"))
  try {
    const filename = join(root, "flows.sqlite")
    const results = await Effect.runPromise(Effect.all([tables(filename), tables(filename)], { concurrency: 2 }))
    expect(results).toEqual([[{ name: "flows_runs" }], [{ name: "flows_runs" }]])
    expect(readdirSync(root).some((name) => name.includes(".initializing-"))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
