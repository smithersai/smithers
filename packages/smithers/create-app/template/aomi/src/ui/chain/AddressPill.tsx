// TEMP: delete this file and import the component from @smthrs/ui/chain once
// that subpath exists.
/**
 * An EVM address as a monospace pill: truncated middle, full value in the
 * title, click to copy. Built on `Badge` so the pill geometry is the house
 * one.
 */
import { Badge } from "@smthrs/ui"

export interface AddressPillProps {
  readonly address: string
  /** Human name for the address, shown instead of the hex when set. */
  readonly label?: string
  /** Leading and trailing hex characters kept when truncating. Default 4. */
  readonly edge?: number
  readonly onClick?: (address: string) => void
}

/** `0x1234…cdef`. Values shorter than the two edges are returned unchanged. */
export const truncateHex = (value: string, edge = 4): string => {
  const body = value.startsWith("0x") ? value.slice(2) : value
  if (body.length <= edge * 2) return value
  return `0x${body.slice(0, edge)}…${body.slice(-edge)}`
}

export function AddressPill({ address, label, edge = 4, onClick }: AddressPillProps) {
  return (
    <Badge
      variant="secondary"
      className="aomi-chain-pill"
      title={address}
      onClick={onClick === undefined ? undefined : () => onClick(address)}
      data-clickable={onClick === undefined ? undefined : "true"}
    >
      {label ?? truncateHex(address, edge)}
    </Badge>
  )
}
