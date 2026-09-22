/**
 * Night Owl, the palette the Smithers app uses (`apps/app/.../tokens.css`).
 */
import { RGBA, SyntaxStyle } from "@opentui/core"

export const color = {
  surface: "#0b253a",
  text: "#d6deeb",
  muted: "#7e97ac",
  faint: "#4b6479",
  brand: "#c792ea",
  success: "#addb67",
  warning: "#ecc48d",
  danger: "#ef5350",
  info: "#82aaff"
} as const

const fg = (hex: string, extra: { bold?: boolean; italic?: boolean; underline?: boolean } = {}) => ({
  fg: RGBA.fromHex(hex),
  ...extra
})

export const syntax = SyntaxStyle.fromStyles({
  default: fg(color.text),
  keyword: fg(color.brand, { italic: true }),
  "keyword.return": fg(color.brand, { italic: true }),
  operator: fg("#7fdbca"),
  string: fg(color.warning),
  "string.special": fg(color.warning),
  number: fg("#f78c6c"),
  boolean: fg("#ff5874"),
  constant: fg("#82aaff"),
  "constant.builtin": fg("#ff5874"),
  comment: fg("#637777", { italic: true }),
  function: fg(color.info),
  "function.call": fg(color.info),
  "function.method": fg(color.info),
  "function.method.call": fg(color.info),
  variable: fg(color.text),
  "variable.member": fg("#addb67"),
  property: fg("#addb67"),
  type: fg("#ffcb8b"),
  punctuation: fg("#7fdbca"),
  "punctuation.bracket": fg(color.text),
  "markup.heading": fg(color.brand, { bold: true }),
  "markup.strong": fg(color.text, { bold: true }),
  "markup.italic": fg(color.text, { italic: true }),
  "markup.raw": fg(color.warning),
  "markup.link": fg(color.info, { underline: true }),
  "markup.link.url": fg(color.info, { underline: true }),
  "markup.list": fg(color.brand),
  "markup.quote": fg(color.muted, { italic: true })
})

/** Braille spinner frames, advanced by the app's clock. */
export const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const
