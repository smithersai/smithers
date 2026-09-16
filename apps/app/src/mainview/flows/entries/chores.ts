import type { Namespace } from "../registry"

/** Setup shares its controller with the other repository jobs. */
export const namespace: Namespace = { id: "chores", label: "Chores", summary: "Configure recurring maintenance" }
