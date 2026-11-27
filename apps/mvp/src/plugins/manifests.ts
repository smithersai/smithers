// Shared declarative plugin routes; the HTTP boundary never imports plugin runtimes or UI chunks.
import bugs from "../../plugins/bugs/plugin.json" with { type: "json" }
import factory from "../../plugins/factory/plugin.json" with { type: "json" }
import fleet from "../../plugins/fleet/plugin.json" with { type: "json" }
import queue from "../../plugins/queue/plugin.json" with { type: "json" }
import uphill from "../../plugins/uphill/plugin.json" with { type: "json" }
import wiki from "../../plugins/wiki/plugin.json" with { type: "json" }
export { bugs, factory, fleet, queue, uphill, wiki }
export const BUILTIN_MANIFESTS = [bugs, factory, fleet, queue, uphill, wiki] as const
