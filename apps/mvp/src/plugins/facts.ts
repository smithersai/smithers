import { type Load, Manifest } from "@smthrs/plugin"
import { BUG_REPORT_ROW } from "../features/bugs/contract"
import { FEED_ROW } from "../features/feeds/contract"
import { WAITS_ROW } from "../features/status/contract"
import { type Entry, registry } from "../flows/registry"
import { POINTS } from "./contract"

// What the loader checks a manifest against (decision 0017, "Checks beyond the schema"): the app's one flow catalog,
// the core's queries and each tier's cap. Every flow in the registry is the core's, so no plugin owns or replaces one:
// a system flow can't be overridden. A plugin borrows one through `uses`, and a person-only one (a `userOnlyReason`)
// runs only from the host's action strip, never from plugin code.

/** The fields of a flow's payload, when its schema is a struct: the keys a manifest's `args` may fill. */
const payloadOf = (entry: Entry) => {
  const fields = (entry.flow.payloadSchema as { readonly fields?: Readonly<Record<string, unknown>> }).fields
  return fields === undefined
    ? undefined
    : { type: "object", properties: Object.fromEntries(Object.keys(fields).map((key) => [key, {}])) }
}

/**
 * One registry entry as the loader sees it. A reference (the tab's view of a flow whose body only an engine imports)
 * declares no capabilities here; a built-in's use of one is trusted application code (decision 0017, "Compiled code is
 * trusted application code").
 */
export const factsOf = (entry: Entry): Load.FlowFacts => ({
  capabilities: (entry.flow as { readonly capabilities?: ReadonlyArray<string> }).capabilities ?? [],
  minimum: entry.minimum ?? entry.slash?.minimum ?? "anyone",
  personOnly: entry.userOnlyReason !== undefined,
  system: true,
  ...withPayload(payloadOf(entry)),
})

const withPayload = (payload: ReturnType<typeof payloadOf>) => (payload === undefined ? {} : { payload: payload as never })

/**
 * A capability no tier holds yet: a secret. A plugin names one only with an Admin's grant to that installation, which
 * slice 6 adds (decision 0017, "Review, activation and grants"); until then a manifest asking for one is refused
 * `capability_exceeded`, and secrets stay opaque to every plugin.
 */
export const ungranted = (capability: string): boolean => /^secret(:|$)/.test(capability)

/** The host facts for `catalog`: the app's registry by default. */
export const hostFacts = (catalog: Readonly<Record<string, Entry>> = registry): Load.HostFacts => ({
  api: Manifest.PLUGIN_API,
  points: POINTS,
  catalog: new Map(Object.entries(catalog).map(([name, entry]) => [name, factsOf(entry)])),
  queries: new Map([
    ["core/waits", WAITS_ROW as never],
    ["core/bug-reports", BUG_REPORT_ROW as never],
    // A repository's feeds (docs/features/feeds.md#plugins): its index, and one document, asked with `params`.
    ["core/feeds", FEED_ROW as never],
    ["core/feed", FEED_ROW as never],
  ]),
  tierCap: {
    "built-in": (capability) => !ungranted(capability),
    repository: (capability) => !ungranted(capability),
    personal: (capability) => !ungranted(capability),
  },
})
