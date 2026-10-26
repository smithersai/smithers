import type { Contribution } from "@smthrs/plugin"

// The plugin host's contract (decision 0017, docs/features/plugins.md): the contribution points this host implements,
// the API version it offers, and what it records. A point it doesn't implement yet refuses the plugin that uses it
// (`unsupported_point`), so nothing a manifest declares is silently ignored.

/** The points slice 1's host implements; view events are part of `views`. */
export const POINTS: ReadonlyArray<Contribution.Point> = ["views", "slots", "commands", "keybindings"]

/** How long the first stroke of a two-stroke key (`g q`) waits for the second. */
export const CHORD_WITHIN_MS = 1_000

/**
 * What the plugin host records in the browser, by name, and the attributes they carry (docs/observability.md#plugins):
 * one `plugin.load` span and count per plugin at boot, the contributions it brought by point, and each strip press and
 * key. None carries a manifest's text, an item or a note. src/telemetry.ts merges them into what ChatApi's relay keeps.
 */
export const PLUGINS_TELEMETRY = {
  records: [
    "plugin.load",
    "plugin.refused",
    "plugin.press",
    "plugin.key",
    "plugin.failed",
    "plugin.request",
    "smithers_plugin_loads",
    "smithers_plugin_contributions",
    "smithers_plugin_presses",
    "smithers_plugin_keys",
  ],
  fields: ["plugin", "version", "tier", "outcome", "reason", "point", "view", "event", "door", "key", "errorCode", "feature"],
} as const
