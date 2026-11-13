import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { Kernel, make, type PluginError, type PluginInput } from "../src/index.ts"
import * as Path from "../src/internal/path.ts"

const refusal = (input: PluginInput, options: Parameters<typeof Kernel.make>[2] = {}): Promise<PluginError> =>
  Effect.runPromise(Kernel.make(input, {}, options).pipe(Effect.flip))

// The documented dollar-path convention: `$` is the input, `[n]` an index.
// A refusal inside a preset array must name the offending entry, not the root.
describe("diagnostic paths point at the refused preset entry", () => {
  it("names the throwing apply predicate's entry", async () => {
    const error = await refusal([
      make({ name: "first" }),
      [make({
        name: "throwing",
        apply: () => {
          throw new Error("boom")
        }
      })]
    ])
    expect(error).toMatchObject({ code: "apply_failed", plugin: "throwing", path: "$[1][0].apply" })
  })

  it("names the entry whose apply predicate returned a non-boolean", async () => {
    const error = await refusal([make({ name: "first" }), { name: "loose", apply: () => "yes" as never }])
    expect(error).toMatchObject({ code: "invalid_plugin", plugin: "loose", path: "$[1].apply" })
  })

  it("names the later of two plugins with the same name", async () => {
    const error = await refusal([make({ name: "a" }), make({ name: "b" }), [make({ name: "a" })]])
    expect(error).toMatchObject({ code: "duplicate_name", plugin: "a", path: "$[2][0].name" })
  })

  it("names the versionless entry, not its resolved position", async () => {
    // `enforce: "pre"` moves the second entry first in resolved order; the
    // path still follows the caller's input.
    const error = await refusal(
      [
        make({ name: "versioned", version: "1.0.0" }),
        make({ name: "early", version: "1.0.0", enforce: "pre" }),
        make({ name: "versionless" })
      ],
      { cacheEnvironment: { layers: [], capabilities: {} } }
    )
    expect(error).toMatchObject({ code: "cache_environment_invalid", plugin: "versionless", path: "$[2].version" })
  })

  it("keeps the root path for a single plugin input", async () => {
    const error = await refusal(make({ name: "solo" }), { cacheEnvironment: { layers: [], capabilities: {} } })
    expect(error).toMatchObject({ code: "cache_environment_invalid", path: "$.version" })
  })
})

it("redacts non-string keys in manifest paths without exposing their description", () => {
  expect(Path.join(["views", 0, Symbol("private data")])).toBe("views[0][key:2]")
  expect(Path.append("", "name")).toBe("name")
})
