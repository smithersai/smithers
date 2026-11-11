import assert from "node:assert/strict"
import { State, StateStoreError, inMemoryState } from "alchemy/State"
import { Effect, Layer } from "effect"
import { test } from "node:test"
import { DeploymentVersions, reconcileStore } from "./DeploymentState.ts"

const key = { stack: "app", stage: "prod", fqn: "ElectricGateway" }
const resource = (extra = {}) => ({
  kind: "resource", status: "updated", fqn: key.fqn, logicalId: key.fqn,
  resourceType: "Cloudflare.Worker", instanceId: "retained-identity",
  providerVersion: 0, downstream: ["ChatApi"], bindings: [{ type: "service", name: "runtime" }],
  namespace: undefined, props: { main: "gateway.ts" },
  attr: { accountId: "account", workerName: "gateway", versionId: "candidate", durableObjectNamespaces: { Cache: "retained-namespace" },
    hash: { bundle: "candidate-content", metadata: "candidate-settings" } },
  ...extra
})
const withStore = (body, current = () => Effect.succeed("candidate")) => Effect.runPromise(
  Effect.gen(function*() {
    const store = reconcileStore(yield* yield* State, yield* DeploymentVersions)
    return yield* body(store)
  }).pipe(Effect.provide(Layer.mergeAll(inMemoryState(), Layer.succeed(DeploymentVersions, { current }))))
)

test("a completed publication records the serving version alongside its content hash", () => withStore((store) =>
  Effect.gen(function*() {
    const written = yield* store.set({ ...key, value: resource() })
    assert.equal(written.attr.hash.deploymentVersion, "candidate")
    assert.deepEqual((yield* store.get(key)), written)
  })
))
test("a fault after gateway publication followed by rollback cannot skip that unchanged gateway on retry", async () => {
  let live = "baseline"
  let fault = false
  const deployment = Layer.succeed(DeploymentVersions, {
    current: () => fault
      ? Effect.fail(new StateStoreError({ message: "Injected deployment-service failure" }))
      : Effect.succeed(live)
  })
  await Effect.runPromise(Effect.gen(function*() {
    const memory = yield* yield* State
    const store = reconcileStore(memory, yield* DeploymentVersions)
    live = "candidate"
    yield* store.set({ ...key, value: resource() })
    // The next deployment stage fails; the existing rollout restores gateway traffic.
    fault = true
    const failed = yield* Effect.exit(store.get(key))
    assert.equal(failed._tag, "Failure")
    live = "baseline"
    fault = false
    const retry = yield* store.get(key)
    assert.equal(retry.attr.hash, undefined, "a rolled-back bundle must be rebuilt and published")
    assert.equal(retry.instanceId, "retained-identity")
    assert.equal(retry.attr.durableObjectNamespaces.Cache, "retained-namespace")
    assert.deepEqual(retry.bindings, resource().bindings)
    // Planning itself does not mutate the remote store.
    assert.equal((yield* memory.get(key)).attr.hash.deploymentVersion, "candidate")
    live = "candidate-republished"
    yield* store.set({ ...key, value: resource({ attr: { ...resource().attr, versionId: live } }) })
    assert.equal((yield* store.get(key)).attr.hash.bundle, "candidate-content")
    assert.equal((yield* store.get(key)).attr.hash.deploymentVersion, "candidate-republished")
  }).pipe(Effect.provide(Layer.mergeAll(inMemoryState(), deployment))))
})
test("legacy cached hashes have no serving evidence and are invalidated once", () => withStore((store) =>
  Effect.gen(function*() {
    const memory = yield* yield* State
    yield* memory.set({ ...key, value: resource() })
    assert.equal((yield* store.get(key)).attr.hash, undefined)
    yield* store.set({ ...key, value: resource() })
    assert.equal((yield* store.get(key)).attr.hash.bundle, "candidate-content")
  })
))
test("an unavailable deployment service refuses a cached read and a completed write", async () => {
  const failure = () => Effect.fail(new StateStoreError({ message: "Injected read outage" }))
  await withStore((store) => Effect.gen(function*() {
    const memory = yield* yield* State
    yield* memory.set({ ...key, value: resource() })
    assert.equal((yield* Effect.exit(store.get(key)))._tag, "Failure")
    assert.equal((yield* Effect.exit(store.set({ ...key, value: resource() })))._tag, "Failure")
    assert.equal((yield* memory.get(key)).attr.hash.deploymentVersion, undefined)
  }), failure)
})
test("unrelated resources, incomplete writes and dev/preview/version/dispatch state stay untouched", async () => {
  let calls = 0
  await withStore((store) => Effect.gen(function*() {
    assert.equal(yield* store.get(key), undefined)
    for (const row of [
      resource({ resourceType: "Random.Secret" }),
      resource({ providerMode: "local" }),
      resource({ attr: { ...resource().attr, versionOf: "parent" } }),
      resource({ attr: { ...resource().attr, previewOf: "parent" } }),
      resource({ attr: { ...resource().attr, namespace: "dispatch" } }),
      resource({ attr: undefined }),
      resource({ attr: { workerName: "gateway" } }),
      resource({ attr: { ...resource().attr, hash: undefined } })
    ]) {
      assert.deepEqual(yield* store.set({ ...key, value: row }), row)
      assert.deepEqual(yield* store.get(key), row)
    }
    for (const status of ["creating", "updating", "deleting", "replacing", "replaced"]) {
      const row = resource({ status })
      assert.deepEqual(yield* store.set({ ...key, value: row }), row)
    }
    const action = { kind: "action", status: "ran", fqn: key.fqn, logicalId: key.fqn,
      actionType: "migrate", inputHash: "hash", input: {}, output: {}, downstream: [] }
    assert.deepEqual(yield* store.set({ ...key, value: action }), action)
    assert.deepEqual(yield* store.get(key), action)
  }), () => { calls++; return Effect.succeed("candidate") })
  assert.equal(calls, 0)
})
test("the stack wires the reconciled state only into production", async () => {
  const { readFile } = await import("node:fs/promises")
  const source = await readFile(new URL("../../alchemy.run.ts", import.meta.url), "utf8")
  assert.match(source, /dev \? Alchemy.localState\(\) : reconciledState\(Cloudflare.state\(\)\)/)
})

test("a rollback between provider completion and state commit cannot certify candidate content", () => withStore((store) =>
  Effect.gen(function*() {
    const memory = yield* yield* State
    yield* memory.set({ ...key, value: resource() })
    const attempt = yield* Effect.exit(store.set({ ...key, value: resource() }))
    assert.equal(attempt._tag, "Failure")
    assert.equal((yield* memory.get(key)).attr.hash.deploymentVersion, undefined)
    assert.equal((yield* store.get(key)).attr.hash, undefined)
  }), () => Effect.succeed("baseline")
))
test("a deleted Worker invalidates the cache so Alchemy can recreate it", () => withStore((store) =>
  Effect.gen(function*() {
    const memory = yield* yield* State
    const row = resource()
    row.attr.hash.deploymentVersion = "candidate"
    yield* memory.set({ ...key, value: row })
    assert.equal((yield* store.get(key)).attr.hash, undefined)
    assert.equal((yield* Effect.exit(store.set({ ...key, value: resource() })))._tag, "Failure")
  }), () => Effect.succeed(undefined)
))

test("seeded rollback and publication histories never reuse a hash for another live version", async () => {
  let live = "baseline"
  let recorded
  await withStore((store) => Effect.gen(function*() {
    let seed = 84721
    for (let i = 0; i < 60; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      const action = seed % 3
      if (action === 0) {
        live = `release-${i}`
        yield* store.set({ ...key, value: resource({ attr: { ...resource().attr, versionId: live } }) })
        recorded = live
      } else if (action === 1) live = "baseline"
      const result = yield* store.get(key)
      if (recorded === undefined) assert.equal(result, undefined)
      else assert.equal(result.attr.hash !== undefined, recorded === live, `operation ${i}, seed ${seed}`)
    }
  }), () => Effect.succeed(live))
})
