import assert from "node:assert/strict"
import test from "node:test"
import { assertNodeSupport } from "./release-node-support.mjs"

test("release smoke enforces the supported Node floor", () => {
  const manifest = { name: "@smthrs/harness", engines: { node: ">=26.4.0" } }
  for (const version of ["26.4.0", "26.10.0", "27.0.0"]) {
    assert.doesNotThrow(() => assertNodeSupport(manifest, version), version)
  }
  for (const version of ["22.19.0", "24.11.0", "24.18.0", "25.9.0", "26.3.9", "26.4.0-rc.1", "invalid"]) {
    assert.throws(() => assertNodeSupport(manifest, version), /requires node/, version)
  }
})

test("release smoke accepts absent constraints but fails closed on invalid ranges", () => {
  assert.doesNotThrow(() => assertNodeSupport({ name: "unconstrained" }, "26.4.0"))
  assert.doesNotThrow(() => assertNodeSupport({ engines: { node: ">=26.4.0" } }, "27.0.0"))
  assert.throws(() => assertNodeSupport({ engines: { node: "not a range" } }, "26.10.0"), /requires node/)
  assert.throws(() => assertNodeSupport({ engines: { node: ">=26.4.0 <26.5" } }, "26.10.0"), /requires node/)
})
