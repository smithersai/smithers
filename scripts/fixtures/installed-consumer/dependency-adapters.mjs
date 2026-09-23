/** Relocated into the installed consumer; imports must resolve there. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { assertInstalledConsumer } from "./consumer-boundary.mjs"

assertInstalledConsumer(import.meta.url)

const profile = process.argv[2]
for (const entry of JSON.parse(readFileSync("dependency-resolutions.json", "utf8"))) {
  const schema = await import(pathToFileURL(createRequire(entry.path).resolve("effect/Schema")).href)
  assert.equal(schema.String, Schema.String, entry.name + ": Schema instance differs")
  assert.equal(schema.decodeUnknownSync, Schema.decodeUnknownSync, entry.name + ": decoder instance differs")
}

if (profile === "node") {
  const NodeRuntime = await import("@smthrs/flows/NodeRuntime")
  const NodeGateway = await import("@smthrs/gateway/node/NodeGateway")
  const NodeOtel = await import("@smthrs/observability/NodeOtel")
  const NodeHost = await import("@smthrs/platform-node/NodeHost")
  const filename = resolve("runtime.sqlite")
  const storage = NodeRuntime.storage(filename).pipe(
    Layer.provide(Layer.merge(NodeHost.layer, NodeHost.NodeCrypto.layer))
  )
  await Effect.runPromise(Effect.scoped(Layer.build(storage)))
  assert.equal(existsSync(filename), true, "NodeRuntime must acquire real SQLite storage")
  assert.deepEqual(await Effect.runPromise(NodeGateway.listenOptions({ port: 0 })), { host: "127.0.0.1", port: 0 })
  assert.equal(NodeGateway.bindRefusal({ host: "0.0.0.0" }).code, "bind_failed")
  // Real exporter acquisition and shutdown, with all traffic confined to a
  // disposable local collector. No remote telemetry is sent.
  const collector = createServer((request, response) => { request.resume(); request.on("end", () => response.end("{}")) })
  await new Promise((ready) => collector.listen(0, "127.0.0.1", ready))
  try {
    await Effect.runPromise(Effect.scoped(Layer.build(NodeOtel.layerOtel({
      endpoint: "http://127.0.0.1:" + collector.address().port,
      resource: { serviceName: "dependency-smoke" }
    }))))
  } finally {
    await new Promise((done, reject) => { collector.close((error) => error ? reject(error) : done()); collector.closeAllConnections() })
  }
}
if (profile === "browser") {
  const BrowserOtel = await import("@smthrs/observability/BrowserOtel")
  await Effect.runPromise(Effect.scoped(Layer.build(BrowserOtel.layerOtel({ resource: { serviceName: "browser-smoke" } }))))
}
if (profile === "bun") {
  const BunFileSystem = await import("@smthrs/platform-bun/BunFileSystem")
  const { FileSystem } = await import("effect/FileSystem")
  const value = await Effect.runPromise(Effect.gen(function*() {
    const fs = yield* FileSystem
    yield* fs.writeFileString("bun-smoke.txt", "selected Bun host")
    return yield* fs.readFileString("bun-smoke.txt")
  }).pipe(Effect.provide(BunFileSystem.layer)))
  assert.equal(value, "selected Bun host")
}
if (profile === "migrate-scan" || profile === "migrate-apply") {
  const Inventory = await import("@smthrs/migrate/Inventory")
  const source = 'import { Task } from "smthrs"; export const task = <Task id="alpha">hello</Task>\n'
  const hits = Inventory.scanFile("flow.tsx", source, { factories: new Set() })
  assert.equal(hits.filter((hit) => hit.construct === "Task").length, 1)
  assert.deepEqual(hits.find((hit) => hit.construct === "Task").props, ["id"])
  if (profile === "migrate-apply") {
    const Command = await import("@smthrs/migrate/flow/Command")
    const Evaluator = createRequire(import.meta.resolve("@smthrs/migrate/flow/Command"))("@smthrs/model/Evaluator")
    const project = resolve("migration-project")
    mkdirSync(project)
    writeFileSync(resolve(project, "package.json"), '{"name":"migration-fixture","private":true}')
    // Acquire the real apply host, including its optional agent/registry
    // dependencies. No transform is submitted and no provider is contacted.
    const evaluator = Evaluator.layerScripted(() => {
      throw new Error("Host acquisition must not request a model judgment")
    })
    await Effect.runPromise(Effect.scoped(Layer.build(Command.layerNode({ root: project, environment: {}, evaluator }))))
  }
}
console.log("adapter and native Effect identity ok: " + profile)
