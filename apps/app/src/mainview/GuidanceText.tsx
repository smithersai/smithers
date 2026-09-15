import type { CSSProperties } from "react"

export const guidanceTypingMs = (text: string) => Array.from(text).length * 20

/** Transient presentation only. The caller owns the sequence, and the reader advances it. */
export function GuidanceText({ text }: { text: string }) {
  return <span className="guidance-text">
    <span className="guidance-text-accessible">{text}</span>
    <span aria-hidden="true" className="guidance-text-visual">{Array.from(text).map((character, i) =>
      <span key={i} style={{ "--character-delay": `${i * 20}ms` } as CSSProperties}>{character}</span>
    )}</span>
  </span>
}
