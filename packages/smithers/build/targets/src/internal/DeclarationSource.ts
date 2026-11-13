/**
 * Declaration-source lookup using the host's stack and path capabilities.
 * @since 1.0.0
 */

/**
 * Minimal call-site data; unavailable positions remain absent in diagnostics.
 * @since 1.0.0
 * @private
 */
export interface Site {
  readonly scriptName: string
  readonly lineNumber?: unknown
  readonly columnNumber?: unknown
}

/**
 * Host operations already owned by the target declaration boundary.
 * @since 1.0.0
 * @private
 */
export interface Host {
  readonly callSites: (count: number, options: { readonly sourceMap: boolean }) => ReadonlyArray<Site>
  readonly fromFileUrl: (file: string) => string
  readonly basename: (file: string) => string
  readonly resolve: (file: string) => string
  readonly isDeclaration: (name: string) => boolean
}

/**
 * Finds a routed declaration without making an unavailable stack fatal.
 * @since 1.0.0
 * @private
 */
export const capture = (host: Host): {
  readonly path: string
  readonly line: number | undefined
  readonly column: number | undefined
} | undefined => {
  let sites: ReadonlyArray<Site>
  try {
    sites = host.callSites(100, { sourceMap: true })
  } catch {
    return undefined
  }
  for (const site of sites) {
    let file = site.scriptName
    try {
      if (file.startsWith("file:")) file = host.fromFileUrl(file)
    } catch {
      continue
    }
    const basename = host.basename(file)
    if (!host.isDeclaration(basename) && basename !== "WORKSPACE.ts") continue
    const positive = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
    return { path: host.resolve(file), line: positive(site.lineNumber), column: positive(site.columnNumber) }
  }
  return undefined
}
