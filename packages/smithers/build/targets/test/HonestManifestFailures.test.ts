import * as Effect from "effect/Effect"
import * as Fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it } from "vitest"
import * as PackageJson from "../src/PackageJson.ts"

let root: string
let outside: string
beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(join(tmpdir(), "honest-manifest-failures-")))
  outside = await Fs.realpath(await Fs.mkdtemp(join(tmpdir(), "honest-manifest-cache-")))
})
afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
  await Fs.rm(outside, { recursive: true, force: true })
})
const payload: PackageJson.SyncPayload = {
  path: "package.json",
  mode: "write",
  fields: { name: "widget", version: "1.0.0" },
  generated: ["description"],
  readme: null,
  sources: null,
  promptVersion: "1",
  engine: "claude",
  model: "sonnet"
}

it("reports an invalid generated-field cache path without writing the manifest", async () => {
  const error = await Effect.runPromise(
    Effect.flip(PackageJson.sync({ workspaceRoot: root, cacheDirectory: "../outside" }, payload))
  )
  expect(error.message).toContain("generated field cache path is invalid")
  expect(await Fs.readdir(root)).toEqual([])
})

it("treats an externally substituted field cache as a miss", async () => {
  await Fs.mkdir(join(outside, PackageJson.fieldCacheDirectory))
  await Fs.symlink(outside, join(root, ".cache"))
  await Effect.runPromise(PackageJson.sync({ workspaceRoot: root, cacheDirectory: ".cache" }, payload))
  expect(JSON.parse(await Fs.readFile(join(root, "package.json"), "utf8"))).toEqual({
    name: "widget",
    version: "1.0.0"
  })
  expect(await Fs.readdir(join(outside, PackageJson.fieldCacheDirectory))).toEqual([])
})

it("reports a model launch failure in refresh mode without publishing partial metadata", async () => {
  await Fs.writeFile(join(root, "package.json"), "{\"name\":\"widget\",\"version\":\"1.0.0\"}")
  const error = await Effect.runPromise(Effect.flip(PackageJson.sync({
    workspaceRoot: root,
    cacheDirectory: ".cache",
    executable: join(root, "missing-model")
  }, { ...payload, mode: "refresh" })))
  expect(error.message).toContain("model call failed")
  expect(JSON.parse(await Fs.readFile(join(root, "package.json"), "utf8"))).toEqual({
    name: "widget",
    version: "1.0.0"
  })
})
