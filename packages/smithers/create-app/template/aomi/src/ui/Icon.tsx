// TEMP: delete this file and import the component from @smthrs/ui once that
// package exports one.
/**
 * The small inline icon set the Aomi shell needs.
 *
 * Icons are named the lucide way in the app manifest. lucide is not a
 * dependency here, so this file carries a hand-drawn glyph for each name the
 * manifest and the Build page use. An unknown name renders the fallback dot,
 * which keeps a new nav item visible instead of blank.
 */
import type { ReactNode } from "react"

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const
}

/** 24x24 lucide-shaped glyphs, keyed by the manifest's icon names. */
const glyphs: Readonly<Record<string, ReactNode>> = {
  home: <path {...stroke} d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />,
  "folder-kanban": (
    <>
      <path {...stroke} d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path {...stroke} d="M9 11v5M12 11v3M15 11v6" />
    </>
  ),
  hammer: (
    <>
      <path {...stroke} d="m15 12-8.5 8.5a2.12 2.12 0 1 1-3-3L12 9" />
      <path {...stroke} d="M17.64 15 22 10.64" />
      <path
        {...stroke}
        d="m20.91 11.7-1.25-1.25c-.6-.6-.93-1.4-.93-2.25v-.86L16.01 4.6a5.56 5.56 0 0 0-3.94-1.64H9l.92.82A6.18 6.18 0 0 1 12 8.4v1.56l2 2h2.47l2.26 1.91"
      />
    </>
  ),
  laptop: (
    <>
      <path {...stroke} d="M4 16V7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9" />
      <path {...stroke} d="M2.5 18h19" />
    </>
  ),
  history: (
    <>
      <path {...stroke} d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path {...stroke} d="M3 4v4h4M12 7v5l3 2" />
    </>
  ),
  "layout-template": (
    <>
      <path {...stroke} d="M4 5h16v4H4zM4 12h7v7H4zM14 12h6v7h-6z" />
    </>
  ),
  rocket: (
    <>
      <path {...stroke} d="M13 3c4 1 8 5 8 8-2 3-5 5-8 6l-4-4c1-3 3-6 4-10z" />
      <path {...stroke} d="m9 15-4 4M7 12l-3 1 1 3" />
    </>
  ),
  "wallet-cards": (
    <>
      <path {...stroke} d="M4 7a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
      <path {...stroke} d="M4 10h16M15 14h2" />
    </>
  ),
  activity: <path {...stroke} d="M3 12h4l3 7 4-14 3 7h4" />,
  gauge: (
    <>
      <path {...stroke} d="M12 20a8 8 0 1 1 8-8" />
      <path {...stroke} d="m12 13 4-4" />
    </>
  ),
  "scroll-text": (
    <>
      <path {...stroke} d="M6 4h11a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path {...stroke} d="M9 9h7M9 13h7M9 17h4" />
    </>
  ),
  "key-round": (
    <>
      <circle {...stroke} cx="8" cy="9" r="4" />
      <path {...stroke} d="m11 12 8 8M16 17l2-2M14 15l2-2" />
    </>
  ),
  plug: (
    <>
      <path {...stroke} d="M9 3v6M15 3v6" />
      <path {...stroke} d="M6 9h12v3a6 6 0 0 1-12 0z" />
      <path {...stroke} d="M12 18v3" />
    </>
  ),
  settings: (
    <>
      <circle {...stroke} cx="12" cy="12" r="3" />
      <path
        {...stroke}
        d="M12 3v2.2M12 18.8V21M4.9 7.5l1.9 1.1M17.2 15.4l1.9 1.1M4.9 16.5l1.9-1.1M17.2 8.6l1.9-1.1"
      />
    </>
  )
}

export interface IconProps {
  /** A lucide name, e.g. "hammer". Unknown names render the fallback dot. */
  readonly name: string | undefined
  /** Edge length in pixels. Default 16, the nav row size. */
  readonly size?: number
  readonly className?: string
}

export function Icon({ name, size = 16, className }: IconProps) {
  const glyph = name === undefined ? undefined : glyphs[name]
  return (
    <svg className={className} viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      {glyph ?? <circle {...stroke} cx="12" cy="12" r="3" />}
    </svg>
  )
}
