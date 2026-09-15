import { REAL_HOSTS } from "./types"
import type { RealHost } from "./types"

/** Keep a targeted run inside its declared host instead of replacing the host filter. */
export const hostGrep = (host: RealHost, requested?: string): RegExp => {
  if (!(REAL_HOSTS as readonly string[]).includes(host)) throw new Error(`Invalid real E2E host: ${host}`)
  return new RegExp(`^(?=.*(?:^|\\s)@real-host:${host}(?:\\s|$))${requested === undefined ? "" : `(?=.*(?:${requested}))`}`)
}

/** Playwright CLI --grep overrides config.grep; move it into our combined filter. */
export const extractRequestedGrep = (args: readonly string[]): { readonly args: readonly string[]; readonly grep?: string } => {
  const remaining: string[] = []
  let grep: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === "--grep" || arg === "-g" || arg.startsWith("--grep=")) {
      if (grep !== undefined) throw new Error("Use only one --grep in a real E2E run")
      const value = arg.startsWith("--grep=") ? arg.slice("--grep=".length) : args[++index]
      if (value === undefined || value === "") throw new Error("--grep requires a test-name expression")
      // Validate before starting a product server or contacting production.
      new RegExp(value)
      grep = value
    } else remaining.push(arg)
  }
  return { args: remaining, ...(grep === undefined ? {} : { grep }) }
}
