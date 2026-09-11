/*
 * The /theme picker card: one swatch per palette, each tile painted in its own
 * palette's colors. Every color pair rides CSS light-dark(), which resolves
 * against the ACTIVE mode's color-scheme (tokens.css stamps it per data-theme),
 * so the tiles preview exactly the variant the user would get and repaint on
 * /dark-mode with no mode plumbing. Selection dispatches /theme <key> through
 * onRunCommand, the delegated registry dispatch; the payload's `selected`
 * marks the palette live when the card last synced.
 *
 * Keys and labels derive from PALETTE_METADATA (state/AppState.ts), the typed
 * palette authority; the preview hexes below mirror styles/tokens.css (bg,
 * text, brand, info, success, danger per variant) and are keyed by Palette, so
 * a palette added to the metadata without preview colors is a compile error
 * here. They are previews only — the palette itself is the CSS.
 */
import type { CSSProperties } from "react"
import type { Card, Palette } from "../state/AppState"
import { PALETTE_METADATA } from "../state/AppState"
import type { CardFamily, RunCommand } from "./CardFamily"
import { settledPill } from "./CardFamily"

type SwatchVariant = {
  readonly bg: string
  readonly text: string
  readonly brand: string
  readonly dots: readonly [string, string, string]
}

const SWATCH_COLORS: Record<Palette, { readonly light: SwatchVariant; readonly dark: SwatchVariant }> = {
  "night-owl": {
    light: { bg: "#fbfbfb", text: "#403f53", brand: "#994cc3", dots: ["#4876d6", "#207770", "#ba3f3b"] },
    dark: { bg: "#011627", text: "#d6deeb", brand: "#c792ea", dots: ["#82aaff", "#addb67", "#ef5350"] }
  },
  paper: {
    light: { bg: "#f7f4ee", text: "#211d18", brand: "#0f766e", dots: ["#3c6879", "#0b5b57", "#a4442a"] },
    dark: { bg: "#0d1514", text: "#ece7db", brand: "#45c4b2", dots: ["#82a8b8", "#7fbfb3", "#d97757"] }
  },
  fucory: {
    light: { bg: "#fafafa", text: "#18181b", brand: "#6d56d8", dots: ["#2a63c9", "#087461", "#c5343f"] },
    dark: { bg: "#09090b", text: "#f4f4f5", brand: "#8b78e6", dots: ["#6aa5f8", "#2ec9a8", "#f2555a"] }
  },
  one: {
    light: { bg: "#fafafa", text: "#383a42", brand: "#a626a4", dots: ["#4078f2", "#3c763b", "#b8473b"] },
    dark: { bg: "#282c34", text: "#abb2bf", brand: "#c678dd", dots: ["#61afef", "#98c379", "#e06c75"] }
  },
  github: {
    light: { bg: "#f6f8fa", text: "#24292e", brand: "#0366d6", dots: ["#1b7c83", "#1e7b31", "#c53443"] },
    dark: { bg: "#24292e", text: "#e1e4e8", brand: "#58a6ff", dots: ["#39c5cf", "#34d058", "#f97583"] }
  },
  catppuccin: {
    light: { bg: "#eff1f5", text: "#4c4f69", brand: "#8839ef", dots: ["#1e66f5", "#307a22", "#d20f39"] },
    dark: { bg: "#1e1e2e", text: "#cdd6f4", brand: "#cba6f7", dots: ["#89b4fa", "#a6e3a1", "#f38ba8"] }
  },
  solarized: {
    light: { bg: "#fdf6e3", text: "#586e75", brand: "#2aa198", dots: ["#268bd2", "#5f6e00", "#c32e2b"] },
    dark: { bg: "#002b36", text: "#93a1a1", brand: "#2aa198", dots: ["#268bd2", "#859900", "#dc322f"] }
  },
  gruvbox: {
    light: { bg: "#fbf1c7", text: "#3c3836", brand: "#b57614", dots: ["#076678", "#6b680e", "#9d0006"] },
    dark: { bg: "#282828", text: "#ebdbb2", brand: "#fabd2f", dots: ["#83a598", "#b8bb26", "#fb4934"] }
  },
  "rose-pine": {
    light: { bg: "#faf4ed", text: "#575279", brand: "#907aa9", dots: ["#286983", "#416e75", "#9b5469"] },
    dark: { bg: "#191724", text: "#e0def4", brand: "#c4a7e7", dots: ["#6e99b2", "#9ccfd8", "#eb6f92"] }
  }
}

const SWATCHES = PALETTE_METADATA.map((entry) => ({
  key: entry.key,
  label: entry.label,
  ...SWATCH_COLORS[entry.key]
}))

const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(104px, 1fr))",
  gap: "8px"
}

type Swatch = (typeof SWATCHES)[number]

const swatchStyle = (swatch: Swatch, selected: boolean): CSSProperties => ({
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: "6px",
  padding: "10px",
  borderRadius: "var(--r-2, 10px)",
  border: `1px solid light-dark(${swatch.light.text}24, ${swatch.dark.text}2e)`,
  background: `light-dark(${swatch.light.bg}, ${swatch.dark.bg})`,
  color: `light-dark(${swatch.light.text}, ${swatch.dark.text})`,
  cursor: "pointer",
  font: "inherit",
  fontSize: "var(--fs-2, 12px)",
  textAlign: "left",
  boxShadow: selected
    ? `0 0 0 2px light-dark(${swatch.light.brand}, ${swatch.dark.brand})`
    : "none"
})

const dotStyle = (light: string, dark: string): CSSProperties => ({
  width: "10px",
  height: "10px",
  borderRadius: "999px",
  background: `light-dark(${light}, ${dark})`
})

export const ThemePickerCardBody = ({
  card,
  onRunCommand
}: {
  readonly card: Extract<Card, { kind: "theme-picker" }>
  readonly onRunCommand: RunCommand
}) => (
  <div style={gridStyle} role="listbox" aria-label="Color themes">
    {SWATCHES.map((swatch) => {
      const selected = card.payload.selected === swatch.key
      return (
        <button
          key={swatch.key}
          type="button"
          role="option"
          aria-selected={selected}
          data-flow="appearance.theme"
          aria-label={`Switch to the ${swatch.label} color theme`}
          style={swatchStyle(swatch, selected)}
          onClick={() => onRunCommand("appearance.theme", swatch.key)}
        >
          <span style={{ display: "flex", gap: "4px" }} aria-hidden="true">
            <span style={dotStyle(swatch.light.brand, swatch.dark.brand)} />
            {swatch.light.dots.map((dot, index) => (
              <span key={dot} style={dotStyle(dot, swatch.dark.dots[index] ?? dot)} />
            ))}
          </span>
          <span style={{ fontWeight: 650 }}>{swatch.label}</span>
          {selected ? <span>current</span> : null}
        </button>
      )
    })}
  </div>
)

export const themePickerCardFamily: CardFamily<"theme-picker"> = {
  "theme-picker": {
    render: (card, actions) => <ThemePickerCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: settledPill
  }
}
