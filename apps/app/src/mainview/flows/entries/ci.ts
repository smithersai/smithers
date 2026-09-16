import type { Namespace } from "../registry"

/** Setup shares its controller with the other repository jobs. */
export const namespace: Namespace = { id: "ci", label: "CI", summary: "Configure repository checks" }
