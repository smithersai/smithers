import { expect, test } from "bun:test"
import { WORKER_IDENTITY } from "../../src/workerIdentity"
import { metadataFor, stable, uploadedVersion, wrapperFor } from "./deployment"
import type { Settings } from "./cloudflare"

const settings = (): Settings => ({ compatibility_date: "2026-08-01", compatibility_flags: ["nodejs_compat"], observability: { enabled: true },
  annotations: { "workers/message": `${"a".repeat(40)} original source`, "workers/tag": "original-tag", "workers/triggered_by": "version_upload" },
  bindings: [...WORKER_IDENTITY.durableObjects.map(item => ({ name: item.binding, type: "durable_object_namespace", class_name: item.className, namespace_id: "a".repeat(32) })),
    { name: "MODEL_VAULT_KEY", type: "secret_text" }, { name: "ASSETS", type: "assets" }, { name: "ORIGINAL", type: "plain_text", text: "unchanged" }] })

test("temporary upload preserves existing bindings/assets/settings and declares no migration", () => {
  const metadata = metadataFor(settings(), "sealed-export-entry.js", { SMITHERS_EXPORT_TOKEN: "test-only" })
  expect(metadata.keep_assets).toBe(true)
  expect(metadata.keep_bindings).toEqual(["secret_text"])
  expect(metadata.bindings.filter(binding => binding.type === "durable_object_namespace")).toEqual(settings().bindings.filter(binding => binding.type === "durable_object_namespace"))
  expect(metadata.bindings).toContainEqual({ name: "ORIGINAL", type: "plain_text", text: "unchanged" })
  expect(metadata).not.toHaveProperty("migrations")
  expect(metadata).not.toHaveProperty("routes")
  expect(metadata).not.toHaveProperty("assets")
  expect(JSON.stringify(metadata)).not.toContain("MODEL_VAULT_KEY") // preserved by type, never read or replaced
})

test("restore retains the original full source SHA and tag for subsequent inventory preparation", () => {
  const metadata = metadataFor(settings(), "index.js")
  expect(metadata.annotations).toEqual({ "workers/message": `${"a".repeat(40)} original source`, "workers/tag": "original-tag" })
  expect(metadata.annotations["workers/message"]).toMatch(/^[a-f0-9]{40}\b/)
})

test("upload identity comes from the exact API result rather than the latest deployment", () => {
  expect(uploadedVersion({ deployment_id: "0123456789abcdef0123456789abcdef" })).toBe("01234567-89ab-cdef-0123-456789abcdef")
  expect(uploadedVersion({ deployment_id: "01234567-89ab-cdef-0123-456789abcdef" })).toBe("01234567-89ab-cdef-0123-456789abcdef")
  expect(() => uploadedVersion({})).toThrow()
})

test("namespace or temporary-binding drift refuses upload; wrapper references exact live module", () => {
  const missing = settings(); missing.bindings.pop(); missing.bindings.shift()
  expect(() => metadataFor(missing, "index.js")).toThrow()
  const existing = settings(); existing.bindings.push({ name: "SMITHERS_EXPORT_TOKEN", type: "secret_text" })
  expect(() => metadataFor(existing, "index.js")).toThrow()
  const wrapper = wrapperFor("index.js")
  expect(wrapper).toContain('from "./index.js"')
  expect(wrapper).toContain("...legacy")
  for (const item of WORKER_IDENTITY.durableObjects) expect(wrapper).toContain(`export class ${item.className}`)
  expect(() => wrapperFor("../../unknown.js")).toThrow()
  expect(stable({ b: 2, a: 1 })).toBe(stable({ a: 1, b: 2 }))
})
