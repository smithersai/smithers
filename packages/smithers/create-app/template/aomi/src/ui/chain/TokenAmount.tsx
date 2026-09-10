// TEMP: delete this file and import the component from @smthrs/ui/chain once
// that subpath exists.
/**
 * A base-unit token balance rendered at its decimal scale.
 *
 * The amount arrives as a decimal string of base units (wei for ether), which
 * is the only lossless JSON form for a uint256. Formatting is exact: the
 * string is split, never converted to a `number`.
 */
export interface TokenAmountProps {
  /** Base units as a decimal string, e.g. "1500000000000000000". */
  readonly amount: string
  /** Token decimals. Default 18. */
  readonly decimals?: number
  readonly symbol?: string
  /** Fractional digits shown. Default 4; trailing zeros are dropped. */
  readonly precision?: number
}

/** Exact base-units to display-units conversion, no floating point. */
export const formatUnits = (amount: string, decimals = 18, precision = 4): string => {
  const negative = amount.startsWith("-")
  const digits = (negative ? amount.slice(1) : amount).replace(/^0+(?=\d)/, "")
  const padded = digits.padStart(decimals + 1, "0")
  const whole = padded.slice(0, padded.length - decimals)
  const fractionAll = decimals === 0 ? "" : padded.slice(padded.length - decimals)
  const fraction = fractionAll.slice(0, precision).replace(/0+$/, "")
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return `${negative ? "-" : ""}${grouped}${fraction === "" ? "" : `.${fraction}`}`
}

export function TokenAmount({ amount, decimals = 18, symbol, precision = 4 }: TokenAmountProps) {
  return (
    <span className="aomi-token-amount" title={`${amount} base units`}>
      <span className="aomi-token-amount-value">{formatUnits(amount, decimals, precision)}</span>
      {symbol === undefined ? null : <span className="aomi-token-amount-symbol">{symbol}</span>}
    </span>
  )
}
