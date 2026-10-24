import * as Node from "@smthrs/plan/Node"
import * as Schema from "effect/Schema"
import { expect, it } from "vitest"
import * as Target from "../src/Target.ts"

const rule = Target.make("CrossCopyMetadata", {
  attrs: Schema.Struct({ value: Schema.String }),
  kinds: ["build"],
  implementation: () => Node.succeed(undefined)
})
const original = Target.metadata(rule({ value: "data" }))
const marker = (metadata: unknown) => Object.defineProperty({}, Target.TargetTypeId, { value: metadata })

it("recognizes a marker carrying real metadata across a package-copy boundary", () => {
  expect(Target.isTarget(marker(original))).toBe(true)
})

it.each([
  ["target", null],
  ["target", ""],
  ["implementationDigest", null],
  ["implementationDigest", "not-a-digest"],
  ["kinds", null],
  ["kinds", ["unknown"]],
  ["dependencies", {}],
  ["inputs", "files"],
  ["dependencySelectors", [{}]],
  ["cacheable", 1],
  ["sourceFile", 42],
  ["decodeSuccess", null],
  ["forKind", null],
  ["verbGate", {}],
  ["verbGate", ["unknown"]],
  ["outputs", null],
  ["outputs", { cwd: 1, paths: [] }],
  ["outputs", { cwd: ".", paths: "value" }],
  ["outputs", { cwd: ".", paths: [42] }]
])("rejects malformed cross-copy %s metadata", (field, value) => {
  const metadata: Record<string, unknown> = { ...original, [field as string]: value }
  const valueMarker = marker(metadata)
  expect(Target.isTarget(valueMarker)).toBe(false)
  expect(() => Target.metadata(valueMarker as never)).toThrow(/target/i)
})

it("requires the schema slot and rejects metadata accessors without invoking them", () => {
  const missing: Record<string, unknown> = { ...original }
  delete missing.attrsSchema
  expect(Target.isTarget(marker(missing))).toBe(false)
  let reads = 0
  const accessor = Object.defineProperty({ ...original }, "target", {
    get: () => {
      reads++
      return "target"
    }
  })
  expect(Target.isTarget(marker(accessor))).toBe(false)
  const array = Object.defineProperty([null], "0", {
    get: () => {
      reads++
      return null
    }
  })
  expect(Target.isTarget(marker({ ...original, dependencies: array }))).toBe(false)
  expect(reads).toBe(0)
})

it("rejects metadata proxies and invalid array prototypes without executing traps", () => {
  let traps = 0
  const metadata = new Proxy(original, {
    getOwnPropertyDescriptor: () => {
      traps++
      throw new Error("trap")
    }
  })
  expect(Target.isTarget(marker(metadata))).toBe(false)
  expect(Target.isTarget(marker(1))).toBe(false)
  expect(Target.isTarget(marker({ ...original, dependencies: Object.setPrototypeOf([], null) }))).toBe(true)
  expect(Target.isTarget(marker({ ...original, inputs: Object.assign([], { extra: true }) }))).toBe(true)
  expect(traps).toBe(0)
})
