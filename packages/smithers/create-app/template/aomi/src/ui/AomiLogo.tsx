// TEMP: the wordmark row is the generic part, so it moves to @smthrs/ui once
// that package exports one; keep the mark here, it stays Aomi-specific.
/**
 * The Aomi mark and wordmark. The two `<path>` geometries are copied verbatim
 * from apps/build/src/components/brand/aomi-logo.tsx in the aomi repo; the
 * markup around them is house-token styling, not Tailwind.
 */
import type { CSSProperties, MouseEvent } from "react"

export interface AomiMarkProps {
  /** Edge length. Default 1em, so the mark tracks the surrounding type. */
  readonly size?: number | string
  readonly className?: string
}

export function AomiMark({ size = "1em", className }: AomiMarkProps) {
  return (
    <svg
      viewBox="0 0 362 362"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      width={size}
      height={size}
      className={className}
      style={{ color: "var(--house-foreground)", flexShrink: 0 }}
    >
      <path
        d="M321.778 94.2349C321.778 64.4045 297.595 40.2222 267.765 40.2222C237.935 40.2222 213.752 64.4045 213.752 94.2349C213.752 124.065 237.935 148.248 267.765 148.248C297.595 148.248 321.778 124.065 321.778 94.2349ZM362 94.2349C362 146.279 319.81 188.47 267.765 188.47C215.721 188.47 173.53 146.279 173.53 94.2349C173.53 42.1904 215.721 1.33271e-06 267.765 0C319.81 0 362 42.1904 362 94.2349Z"
        fill="currentColor"
      />
      <path
        d="M181 0C184.792 0 188.556 0.116399 192.289 0.346221C189.506 2.74481 186.833 5.26892 184.28 7.90977C170.997 20.759 160.669 36.6452 154.42 54.4509C95.7682 66.7078 51.7143 118.709 51.7143 181C51.7143 252.403 109.597 310.286 181 310.286C243.292 310.286 295.291 266.231 307.547 207.58C325.364 201.327 341.259 190.99 354.113 177.695C356.745 175.149 359.261 172.486 361.653 169.71C361.883 173.444 362 177.208 362 181C362 280.964 280.964 362 181 362C81.0365 362 0 280.964 0 181C0 81.0365 81.0365 0 181 0Z"
        fill="currentColor"
      />
    </svg>
  )
}

export interface AomiLogoProps {
  /** Wordmark text. Comes from `manifest.brand.wordmark`. */
  readonly wordmark?: string
  /** Small label beside the wordmark, e.g. the product surface. */
  readonly label?: string
  /** Hide the wordmark and label; the sidebar uses this when collapsed. */
  readonly markOnly?: boolean
  readonly href?: string
  readonly onClick?: (event: MouseEvent<HTMLAnchorElement>) => void
}

const wordmarkStyle: CSSProperties = {
  fontFamily: "var(--house-font-wordmark)",
  fontSize: "1em",
  fontWeight: 600,
  letterSpacing: "-0.025em",
  lineHeight: 1,
  color: "var(--house-foreground)"
}

export function AomiLogo({ wordmark = "aomi", label, markOnly = false, href = "/", onClick }: AomiLogoProps) {
  return (
    <a className="aomi-logo" href={href} onClick={onClick} aria-label={wordmark}>
      <AomiMark />
      {markOnly ? null : (
        <span className="aomi-logo-text">
          <span style={wordmarkStyle}>{wordmark}</span>
          {label === undefined ? null : <span className="aomi-logo-label">{label}</span>}
        </span>
      )}
    </a>
  )
}
