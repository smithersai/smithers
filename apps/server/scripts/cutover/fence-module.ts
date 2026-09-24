import type { FenceIdentity } from "../../src/MaintenanceFence"
import { EXPORT_BINDINGS } from "../../src/MaintenanceExport"

export const fenceModule = (identity: FenceIdentity, objects: ReadonlyArray<{ binding: string; className: string }>): string => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(identity.executionID) ||
    !/^[0-9a-f]{40}$/.test(identity.smithersRevision) || !/^[0-9a-f]{40}$/.test(identity.plueRevision) ||
    identity.endpoint !== "https://api.jjhub.tech" || !/^[a-z0-9-]+$/.test(identity.worker) ||
    !/^[0-9a-f-]{36}$/.test(identity.sourceVersion) || !/^[0-9a-f]{64}$/.test(identity.sourceArtifactSHA256)) throw new Error("Invalid cutover identity")
  if (new Set(objects.map(o => o.binding)).size !== objects.length || new Set(objects.map(o => o.className)).size !== objects.length ||
    objects.some(o => !(EXPORT_BINDINGS as readonly string[]).includes(o.binding) || !/^[A-Za-z][A-Za-z0-9_]*$/.test(o.className))) throw new Error("Unknown or duplicate retained Durable Object")
  return `import { fencedDurable, fencedWorker } from "./cutover-fence-helper.js";\nconst identity = ${JSON.stringify(identity)};\n${objects.map(o => `export class ${o.className} extends fencedDurable(identity, ${JSON.stringify(o.binding)}) {}`).join("\n")}\nexport default fencedWorker(identity);\n`
}

export const admissionModule = (identity: FenceIdentity, entry: string, objects: ReadonlyArray<{ binding: string; className: string }>): string => {
  fenceModule(identity, objects) // Same fixed identity/class validation.
  if (!/^[A-Za-z0-9_.-]+\.js$/.test(entry)) throw new Error("Invalid original entry")
  const imports = objects.map(o => `${o.className} as Legacy${o.className}`)
  return `import legacy${imports.length ? `, { ${imports.join(", ")} }` : ""} from ${JSON.stringify("./" + entry)};\nexport * from ${JSON.stringify("./" + entry)};\nimport { admissionWorker, withSealedExport } from "./cutover-admission-helper.js";\nconst identity = ${JSON.stringify(identity)};\n${objects.map(o => `export class ${o.className} extends withSealedExport(Legacy${o.className}, ${JSON.stringify(o.binding)}) {}`).join("\n")}\nexport default admissionWorker(identity, legacy);\n`
}
