import { WORKER_IDENTITY } from "../../src/workerIdentity"

/** Fixed one-time inventory targets. Never selects an arbitrary Worker or namespace. */
export const EXPORT_TARGETS = {
  web: { kind: "web", name: WORKER_IDENTITY.name, domain: WORKER_IDENTITY.domain.name, durableObjects: WORKER_IDENTITY.durableObjects },
  identity: { kind: "identity", name: "smithers-cloud-identity", domain: "identity.smithers.sh", durableObjects: [{ binding: "IDENTITY", className: "IdentityDurableObject" }] }
} as const
export type ExportTarget = typeof EXPORT_TARGETS[keyof typeof EXPORT_TARGETS]
export const exportTarget = (name = "web"): ExportTarget => {
  if (name !== "web" && name !== "identity") throw new Error("Unknown sealed inventory target")
  return EXPORT_TARGETS[name]
}
export const target = exportTarget(process.env.SMITHERS_EXPORT_TARGET)
