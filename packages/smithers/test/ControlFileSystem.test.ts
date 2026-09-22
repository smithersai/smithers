import { Context, Effect, FileSystem, Layer, Scope } from "effect"
import { describe, expect, it, vi } from "vitest"

// The Bun SQL builtin is unavailable in this Node unit runner.
vi.mock("@smthrs/database/bun/BunDatabase", () => ({ layer: vi.fn() }))

for (const host of ["NodeControlHost", "BunControl"] as const) {
  describe(`${host} filesystem`, () => {
    it("installs the shared atomic filesystem layer", async () => {
      const { platform } = host === "NodeControlHost"
        ? await import("../src/internal/NodeControlHost.ts")
        : await import("../src/internal/BunControl.ts")
      const atomic = await import("@smthrs/platform-node/AtomicFileSystem")
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const memoMap = yield* Layer.makeMemoMap
        const scope = yield* Scope.Scope
        const expected = yield* Layer.buildWithMemoMap(atomic.layer, memoMap, scope)
        const actual = yield* Layer.buildWithMemoMap(platform.host, memoMap, scope)
        expect(Context.get(actual, FileSystem.FileSystem)).toBe(Context.get(expected, FileSystem.FileSystem))
      })))
    })
  })
}
