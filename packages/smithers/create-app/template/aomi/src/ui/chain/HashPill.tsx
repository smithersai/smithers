// TEMP: delete this file and import the component from @smthrs/ui/chain once
// that subpath exists.
/**
 * A transaction or block hash as a monospace pill. Same geometry as
 * `AddressPill`, wider truncation because a 32-byte hash carries more entropy
 * in the tail.
 */
import { Badge } from "@smthrs/ui"
import { truncateHex } from "./AddressPill.tsx"

export interface HashPillProps {
  readonly hash: string
  /** What the hash points at; only affects the accessible label. */
  readonly kind?: "transaction" | "block" | "hash"
  readonly edge?: number
  readonly onClick?: (hash: string) => void
}

export function HashPill({ hash, kind = "hash", edge = 6, onClick }: HashPillProps) {
  return (
    <Badge
      variant="secondary"
      className="aomi-chain-pill"
      title={`${kind} ${hash}`}
      onClick={onClick === undefined ? undefined : () => onClick(hash)}
      data-clickable={onClick === undefined ? undefined : "true"}
    >
      {truncateHex(hash, edge)}
    </Badge>
  )
}
