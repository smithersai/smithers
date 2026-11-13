import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as PackageJson from "../src/PackageJson.ts"
import * as Target from "../src/Target.ts"

let root: string
beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "manifest-cache-boundary-")))
})
afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})
const payload = (overrides: Partial<PackageJson.SyncPayload> = {}): PackageJson.SyncPayload => ({
  path: "package.json",
  mode: "write",
  fields: { name: "widget", version: "0.1.0" },
  generated: [],
  readme: null,
  sources: null,
  promptVersion: "1",
  engine: "claude",
  model: "fixture",
  ...overrides
})
const options = () => ({ workspaceRoot: root, cacheDirectory: ".flows" })
const executable = async (fields: object): Promise<string> => {
  const path = Path.join(root, "reviewer.mjs")
  await Fs.writeFile(
    path,
    `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({result:${JSON.stringify(JSON.stringify(fields))}}))\n`
  )
  await Fs.chmod(path, 0o755)
  return path
}

describe("manifest cache and aggregate output boundaries", () => {
  it("refuses an oversized merged manifest while preserving the checked-in file", async () => {
    const memberBytes = Math.ceil(PackageJson.maximumManifestBytes * 0.6)
    const original = JSON.stringify({ name: "widget", dependencies: { oversized: "x".repeat(memberBytes) } })
    await Fs.writeFile(Path.join(root, "package.json"), original)
    const error = await Effect.runPromise(Effect.flip(PackageJson.sync(
      options(),
      payload({
        fields: { name: "widget", custom: "y".repeat(memberBytes) }
      })
    )))
    expect(error.message).toContain("the generated manifest could not be rendered")
    expect(error.message).toContain("manifest JSON limit")
    expect(await Fs.readFile(Path.join(root, "package.json"), "utf8")).toBe(original)
  })

  it("reports an unwritable cache parent before publishing refreshed metadata", async () => {
    await Fs.writeFile(Path.join(root, ".flows"), "occupied")
    const program = await executable({ description: "A widget." })
    const error = await Effect.runPromise(Effect.flip(PackageJson.sync(
      { ...options(), executable: program },
      payload({ mode: "refresh", generated: ["description"] })
    )))
    expect(error.message).toContain("the generated field cache could not be written")
    expect(await Fs.readFile(Path.join(root, ".flows"), "utf8")).toBe("occupied")
    await expect(Fs.stat(Path.join(root, "package.json"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it.each(["description", "keywords"] as const)("reuses a cache containing only %s", async (field) => {
    const fields = field === "description"
      ? { description: "A widget." }
      : { keywords: ["widget", "cache", "boundary"] }
    const value = payload({ mode: "refresh", generated: [field] })
    const program = await executable(fields)
    await Effect.runPromise(PackageJson.sync({ ...options(), executable: program }, value))
    await Fs.unlink(program)
    await Effect.runPromise(PackageJson.sync(options(), { ...value, mode: "check" }))
    const written = JSON.parse(await Fs.readFile(Path.join(root, "package.json"), "utf8"))
    expect(written[field]).toEqual(fields[field as keyof typeof fields])
  })
})

describe("publish entry structural refusals", () => {
  it("refuses a non-string output directory before deriving entry points", () => {
    const make = Target.make("NumericOutputProbe", {
      attrs: Schema.Struct({ outDir: Schema.Number }),
      kinds: ["build"],
      implementation: Target.catalogNotImplemented
    })
    expect(() => PackageJson.publishFields(make({ outDir: 42 }), "//:custom", { access: "public", provenance: false }))
      .toThrow("declares no outDir attr")
  })

  it("refuses a primary entry with no path before accepting a distribution layout", () => {
    const make = Target.make("MissingEntryProbe", {
      attrs: Schema.Struct({ outDir: Schema.String, format: Schema.String, entries: Schema.Array(Schema.Unknown) }),
      kinds: ["build"],
      implementation: Target.catalogNotImplemented
    })
    expect(() =>
      PackageJson.publishFields(make({ outDir: "dist", format: "esm", entries: [false] }), "//:custom", {
        access: "public",
        provenance: false
      })
    ).toThrow("declares an entry without a path")
  })
})

it("maps a host failure while supplying the cache-read root into a manifest error", async () => {
  let reads = 0
  const host = {
    cacheDirectory: ".flows",
    get workspaceRoot() {
      if (++reads === 3) throw new Error("cache host root unavailable")
      return root
    }
  }
  const error = await Effect.runPromise(Effect.flip(PackageJson.sync(host, payload({ generated: ["description"] }))))
  expect(reads).toBe(3)
  expect(error.message).toBe("cache host root unavailable")
  await expect(Fs.stat(Path.join(root, "package.json"))).rejects.toMatchObject({ code: "ENOENT" })
})
