import { Context, Effect, FileSystem, Layer, Scope } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"

const filesystem = vi.hoisted(() => ({ layerWith: vi.fn() }))

vi.mock("@smthrs/platform-node/AtomicFileSystem", async (load) => ({
  ...await load<typeof import("@smthrs/platform-node/AtomicFileSystem")>(),
  layerWith: filesystem.layerWith
}))

// The Bun SQL builtin is unavailable in this Node unit runner. No database is
// opened by these tests; the host filesystem composition remains real.
vi.mock("@smthrs/database/bun/BunDatabase", () => ({ layer: vi.fn() }))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
  filesystem.layerWith.mockReset()
})

for (const host of ["NodeControlHost", "BunControl"] as const) {
  const loadHost = () =>
    host === "NodeControlHost"
      ? import("../src/internal/NodeControlHost.ts")
      : import("../src/internal/BunControl.ts")

  describe(`${host} filesystem interpreter`, () => {
    it("installs the filesystem layer built with the configured executable", async () => {
      vi.stubEnv("SMITHERS_PYTHON3", "/run/current-system/sw/bin/python3")
      const configured = FileSystem.makeNoop({})
      filesystem.layerWith.mockReturnValue(Layer.succeed(FileSystem.FileSystem, configured))

      const { platform } = await loadHost()
      expect(filesystem.layerWith).toHaveBeenCalledExactlyOnceWith({
        executable: "/run/current-system/sw/bin/python3"
      })
      const installed = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(platform.host)))
      expect(installed).toBe(configured)
    })

    it.each([undefined, ""])("retains the default filesystem for %j", async (value) => {
      vi.stubEnv("SMITHERS_PYTHON3", value)
      const { platform } = await loadHost()
      const atomic = await import("@smthrs/platform-node/AtomicFileSystem")
      expect(filesystem.layerWith).not.toHaveBeenCalled()
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const memoMap = yield* Layer.makeMemoMap
        const scope = yield* Scope.Scope
        const expected = yield* Layer.buildWithMemoMap(atomic.layer, memoMap, scope)
        const actual = yield* Layer.buildWithMemoMap(platform.host, memoMap, scope)
        expect(Context.get(actual, FileSystem.FileSystem)).toBe(Context.get(expected, FileSystem.FileSystem))
      })))
    })

    it.each(["python3", "./python3", "../bin/python3", " "])("rejects relative path %j at startup", async (value) => {
      vi.stubEnv("SMITHERS_PYTHON3", value)
      await expect(loadHost()).rejects.toThrow("SMITHERS_PYTHON3 must be an absolute path to a CPython 3 interpreter")
      expect(filesystem.layerWith).not.toHaveBeenCalled()
    })
  })
}
