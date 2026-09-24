import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { verifyReproducedSource } from "./provenance"
import { exportTarget, EXPORT_TARGETS } from "./targets"
import { validateBindings } from "./cloudflare"
import { wrapperFor } from "./deployment"
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
test("identity source needs exact reproduced bytes and a receipt for the live version", () => {
  const root = mkdtempSync(join(tmpdir(), "identity-source-proof-")); roots.push(root)
  const bytes = "export default {fetch(){return new Response('fixture')}}", sha256 = createHash("sha256").update(bytes).digest("hex")
  writeFileSync(join(root, "reproduced.js"), bytes, { mode: 0o600 })
  const version = "01234567-89ab-4def-8123-456789abcdef", modules = [{ name: "index.js", sha256 }]
  const proof = { receipt: { worker: "smithers-cloud-identity", source: "workers/identity", dryRun: false, gitSha: "a".repeat(40), timestamp: "2026-09-24T00:00:00Z", wranglerVersionId: version }, modules: [{ name: "index.js", sha256, file: "reproduced.js" }] }
  expect(verifyReproducedSource(EXPORT_TARGETS.identity, version, modules, proof, root)).toBe(proof.receipt.gitSha)
  expect(() => verifyReproducedSource(EXPORT_TARGETS.web, version, modules, proof, root)).toThrow()
  expect(() => verifyReproducedSource(EXPORT_TARGETS.identity, "another", modules, proof, root)).toThrow()
  expect(() => verifyReproducedSource(EXPORT_TARGETS.identity, version, modules, { ...proof, receipt: { ...proof.receipt, dryRun: true } }, root)).toThrow()
  expect(() => verifyReproducedSource(EXPORT_TARGETS.identity, version, [{ name: "index.js", sha256: "b".repeat(64) }], proof, root)).toThrow()
  expect(() => verifyReproducedSource(EXPORT_TARGETS.identity, version, modules, { ...proof, modules: [{ ...proof.modules[0]!, file: "../outside" }] }, root)).toThrow()
  writeFileSync(join(root, "reproduced.js"), "altered")
  expect(() => verifyReproducedSource(EXPORT_TARGETS.identity, version, modules, proof, root)).toThrow("file differs")
})
test("operator target and wrapper stay fixed to the original identity namespace and class", () => {
  expect(() => exportTarget("foreign-worker")).toThrow()
  expect(exportTarget().kind).toBe("web")
  const bindings = [{ type: "durable_object_namespace", name: "IDENTITY", class_name: "IdentityDurableObject", namespace_id: "a".repeat(32) }]
  const settings = { bindings, compatibility_date: "2025-05-01", compatibility_flags: ["nodejs_compat"] }
  expect(validateBindings(settings, EXPORT_TARGETS.identity)).toEqual(bindings)
  expect(() => validateBindings({ ...settings, bindings: [...bindings, ...bindings] }, EXPORT_TARGETS.identity)).toThrow()
  const wrapper = wrapperFor("index.js", EXPORT_TARGETS.identity)
  expect(wrapper).toContain('IdentityDurableObject as LegacyIdentityDurableObject')
  expect(wrapper).toContain('withSealedExport(LegacyIdentityDurableObject, "IDENTITY")')
  expect(wrapper).not.toContain('TurnCancelRegistry')
})
