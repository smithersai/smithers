// The theme's contract (docs/features/flows.md#the-theme): the one home of the values the browser, the engine worker,
// index.html's paint script and the tests share. Nothing here imports a library, so every side can.

/** The modes `app/theme/set` sets. Without a preference, the page follows the system's. */
export const THEME_MODES = ["light", "dark"] as const

/** One of {@link THEME_MODES}. */
export type ThemeMode = (typeof THEME_MODES)[number]

/** The attribute `@smthrs/ui`'s palette reads on `<html>`: startup paints the saved mode, else the system's. */
export const THEME_ATTRIBUTE = "data-theme"

/** The `localStorage` key index.html paints from before the device store opens: the mode, mirrored. */
export const THEME_MIRROR_KEY = "smithers.theme"

/**
 * What the theme records in the browser, by name, and the attributes they carry. Setting it is a flow, recorded with
 * every flow (src/flows/contract.ts); the agent's call of that flow is its own span. ChatApi's relay keeps exactly what
 * src/telemetry.ts merges from every feature.
 */
export const THEME_TELEMETRY = {
  records: [
    "execute_tool app/theme/set",
    "theme.system_changed",
    "smithers_theme_system_changes",
    "theme.toggle.defect",
    "smithers_theme_toggle_defects",
  ],
  fields: ["gen_ai.tool.name", "gen_ai.tool.call.id", "errorCode"],
} as const
