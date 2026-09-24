/** One-time operator tool. prepare is GET-only; apply/restore require a reviewed plan. */
import { createHash } from "node:crypto"
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { accountURL, api, scriptPath, validateBindings, type Settings } from "./cloudflare"
import { target } from "./targets"
import { verifyReproducedSource, type ReproducedSourceProof } from "./provenance"
import { maintenanceNames, metadataFor, stable, uploadModuleType, uploadedVersion, wrapperFor } from "./deployment"

interface Deployment { id: string; annotations?: Record<string, string>; versions: Array<{ version_id: string; percentage: number }> }
interface Module { name: string; file: string; type: string; sha256: string }
interface Plan { target: string; sourceRevision: string; sourceVersion: string; sourceDeployment: string; settingsHash: string; maintenanceMetadataHash: string; originalMetadataHash: string; modules: Module[]; originalModules: Module[]; entry: string }
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const [mode, directory] = process.argv.slice(2)
if (!directory || process.argv.length !== 4 || !["prepare", "apply", "restore"].includes(mode!)) throw new Error("Usage: bun scripts/cutover/deploy.ts prepare|apply|restore PRIVATE_DIRECTORY")
const stat = lstatSync(directory)
if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0) throw new Error("Private directory must be owner-only")
const folder = resolve(directory, "prepared")
const save = (file: string, data: string | Uint8Array) => writeFileSync(resolve(folder, file), data, { mode: 0o600, flag: "wx" })
const current = async () => {
  const deployment = (await api<{ deployments: Deployment[] }>(scriptPath + "/deployments")).result.deployments[0]
  if (!deployment || deployment.versions.length !== 1 || deployment.versions[0]!.percentage !== 100) throw new Error("Expected one 100% live version")
  return deployment
}
const settings = (await api<Settings>(scriptPath + "/settings")).result
validateBindings(settings)
if (mode === "prepare") {
  const deployment = await current()
  let sourceRevision = deployment.annotations?.["workers/message"]?.match(/^([a-f0-9]{40})\b/)?.[1]
  if (!sourceRevision && target.kind !== "identity") throw new Error("Live deployment has no immutable source revision")
  const originalMessage = (settings.annotations as Record<string, unknown> | undefined)?.["workers/message"]
  if (sourceRevision && (typeof originalMessage !== "string" || !originalMessage.startsWith(sourceRevision))) throw new Error("Original source annotation differs from live deployment")
  mkdirSync(folder, { mode: 0o700 })
  const response = await fetch(accountURL + scriptPath + "/content/v2", { redirect: "error", signal: AbortSignal.timeout(60_000),
    headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` } })
  if (!response.ok) throw new Error("Original module download failed; response withheld")
  const entry = response.headers.get("cf-entrypoint")
  if (!entry) throw new Error("Original entrypoint is unknown")
  const wrapper = wrapperFor(entry)
  const modules: Module[] = []
  const form = await response.formData()
  for (const [name, file] of form) {
    if (typeof file === "string" || !/^[a-zA-Z0-9_.-]+$/.test(name) || ["sealed-export-helper.js", "sealed-export-entry.js"].includes(name)) throw new Error("Original module shape needs review")
    const content = new Uint8Array(await file.arrayBuffer())
    const local = `original-${modules.length}.bin`
    save(local, content)
    modules.push({ name, file: local, type: uploadModuleType(name, file.type, entry), sha256: hash(content) })
  }
  if (!modules.some(module => module.name === entry)) throw new Error("Original entry module is missing")
  if (!sourceRevision) {
    const proofPath = resolve(directory, "source-proof.json"), proofStat = lstatSync(proofPath)
    if (!proofStat.isFile() || proofStat.isSymbolicLink() || proofStat.size > 65536 || (proofStat.mode & 0o077) !== 0) throw new Error("Source proof must be an owner-only file")
    const proofBytes = readFileSync(proofPath)
    sourceRevision = verifyReproducedSource(target, deployment.versions[0]!.version_id, modules, JSON.parse(proofBytes.toString()) as ReproducedSourceProof, directory)
    save("verified-source-proof.json", proofBytes)
  }
  if ((await current()).id !== deployment.id) throw new Error("Live deployment changed during prepare")
  const built = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../src/MaintenanceExport.ts")], target: "browser", format: "esm", minify: true })
  if (!built.success || built.outputs.length !== 1) throw new Error("Exporter helper bundle failed")
  const helper = await built.outputs[0]!.text()
  save("helper.js", helper)
  save("entry.js", wrapper)
  const originalModules = [...modules]
  modules.push({ name: "sealed-export-helper.js", file: "helper.js", type: "application/javascript+module", sha256: hash(helper) },
    { name: "sealed-export-entry.js", file: "entry.js", type: "application/javascript+module", sha256: hash(wrapper) })
  const additions = JSON.parse(readFileSync(resolve(directory, "bindings.json"), "utf8")) as Record<string, string>
  if (Object.keys(additions).sort().join(",") !== maintenanceNames.slice(0, 3).sort().join(",")) throw new Error("Unexpected maintenance bindings")
  additions.SMITHERS_EXPORT_SOURCE_REVISION = sourceRevision
  additions.SMITHERS_EXPORT_SOURCE_VERSION = deployment.versions[0]!.version_id
  const maintenanceMetadata = JSON.stringify(metadataFor(settings, "sealed-export-entry.js", additions))
  const originalMetadata = JSON.stringify(metadataFor(settings, entry))
  save("maintenance-metadata.json", maintenanceMetadata)
  save("original-metadata.json", originalMetadata)
  save("original-settings.json", JSON.stringify(settings))
  const plan: Plan = { target: target.name, sourceRevision, sourceVersion: deployment.versions[0]!.version_id, sourceDeployment: deployment.id,
    settingsHash: hash(stable(settings)), maintenanceMetadataHash: hash(maintenanceMetadata), originalMetadataHash: hash(originalMetadata), modules, originalModules, entry }
  save("plan.json", JSON.stringify(plan, null, 2))
  console.log(JSON.stringify({ prepared: true, sourceRevision, sourceVersion: plan.sourceVersion, unchangedOriginalModules: originalModules.length,
    newModules: 2, originalDurableBindings: target.durableObjects.length, keepAssets: true, migrations: 0 }))
} else {
  const plan = JSON.parse(readFileSync(resolve(folder, "plan.json"), "utf8")) as Plan
  if (plan.target !== target.name) throw new Error("Prepared target differs from selected Worker")
  const deployment = await current()
  if (mode === "apply") {
    if (deployment.id !== plan.sourceDeployment || hash(stable(settings)) !== plan.settingsHash) throw new Error("Live deployment/settings drifted; prepare again")
    const additions = JSON.parse(readFileSync(resolve(directory, "bindings.json"), "utf8")) as Record<string, string>
    if (!(Date.parse(additions.SMITHERS_EXPORT_EXPIRES_AT!) > Date.now() + 900_000)) throw new Error("Export window has less than 15 minutes remaining")
  } else {
    const applied = JSON.parse(readFileSync(resolve(folder, "applied.json"), "utf8")) as { version: string }
    if (deployment.versions[0]!.version_id !== applied.version) throw new Error("Live version changed after export; restore refused")
  }
  const original = JSON.parse(readFileSync(resolve(folder, "original-settings.json"), "utf8")) as Settings
  if (stable(validateBindings(settings)) !== stable(validateBindings(original))) throw new Error("Durable namespace identity changed")
  const form = new FormData()
  const metadata = readFileSync(resolve(folder, mode === "apply" ? "maintenance-metadata.json" : "original-metadata.json"))
  if (hash(metadata) !== (mode === "apply" ? plan.maintenanceMetadataHash : plan.originalMetadataHash)) throw new Error("Prepared metadata digest mismatch")
  form.set("metadata", new Blob([metadata], { type: "application/json" }))
  for (const module of mode === "apply" ? plan.modules : plan.originalModules) {
    const content = readFileSync(resolve(folder, module.file))
    if (hash(content) !== module.sha256) throw new Error("Prepared module digest mismatch")
    form.set(module.name, new Blob([content], { type: module.type }), module.name)
  }
  const result = (await api<{ id?: string; deployment_id?: string; etag?: string }>(scriptPath + "?excludeScript=true&bindings_inherit=strict", { method: "PUT", body: form })).result
  save(mode === "apply" ? "upload-result.json" : "restore-upload-result.json", JSON.stringify({ at: new Date().toISOString(), upload: result }))
  const version = uploadedVersion(result)
  // Record only the version identified by this upload, never a concurrently deployed version.
  save(mode === "apply" ? "applied.json" : "restored.json", JSON.stringify({ at: new Date().toISOString(), version, upload: result }))
  const after = await current()
  if (after.versions[0]!.version_id !== version) throw new Error("Another version is live after upload; automatic restore is forbidden")
  const content = await fetch(accountURL + scriptPath + "/content/v2", { redirect: "error", signal: AbortSignal.timeout(60_000),
    headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` } })
  if (!content.ok || content.headers.get("cf-entrypoint") !== (mode === "apply" ? "sealed-export-entry.js" : plan.entry)) throw new Error("Uploaded entrypoint differs")
  const actualModules = await content.formData(), expectedModules = mode === "apply" ? plan.modules : plan.originalModules
  if ([...actualModules].length !== expectedModules.length) throw new Error("Uploaded module set differs")
  for (const module of expectedModules) {
    const part = actualModules.get(module.name)
    if (!part || typeof part === "string" || hash(new Uint8Array(await part.arrayBuffer())) !== module.sha256) throw new Error("Uploaded content digest differs")
  }
  const observed = (await api<Settings>(scriptPath + "/settings")).result
  if (stable(validateBindings(observed)) !== stable(validateBindings(original))) throw new Error("Post-deploy Durable Object identity differs; inspect receipt")
  const oldSecrets = original.bindings.filter(binding => binding.type === "secret_text").map(binding => binding.name)
  if (!oldSecrets.every(name => observed.bindings.some(binding => binding.type === "secret_text" && binding.name === name))) throw new Error("Post-deploy secret binding missing")
  const preserved = observed.bindings.filter(binding => !maintenanceNames.includes(binding.name as typeof maintenanceNames[number])).sort((a, b) => a.name.localeCompare(b.name))
  if (stable(preserved) !== stable([...original.bindings].sort((a, b) => a.name.localeCompare(b.name)))) throw new Error("Post-deploy original binding differs")
  if ((await current()).versions[0]!.version_id !== version) throw new Error("Another version intervened during verification")
  save(mode === "apply" ? "verified.json" : "restore-verified.json", JSON.stringify({ version: after.versions[0]!.version_id, originalBindingsPreserved: true }))
  console.log(JSON.stringify({ [mode === "apply" ? "applied" : "restored"]: true, version: after.versions[0]!.version_id, durableBindingsPreserved: true, originalSecretsPreserved: true }))
}
