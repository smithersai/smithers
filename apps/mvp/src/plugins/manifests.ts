// Shared declarative plugin routes; the HTTP boundary never imports plugin runtimes or UI chunks.
import bugs from "../../plugins/bugs/plugin.json" with { type: "json" }
import queue from "../../plugins/queue/plugin.json" with { type: "json" }
export { bugs, queue }
export const BUILTIN_MANIFESTS = [bugs, queue] as const
