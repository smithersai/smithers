/**
 * Nearest-existing-ancestor path resolution through supplied host operations.
 * @since 1.0.0
 */

/**
 * Host path syntax and native filesystem operations.
 * @since 1.0.0
 * @private
 */
export interface Host {
  readonly realpath: (path: string) => string
  readonly dirname: (path: string) => string
  readonly basename: (path: string) => string
  readonly resolve: (...paths: ReadonlyArray<string>) => string
  readonly errorCode: (cause: unknown) => string | undefined
}

/**
 * Preserves missing suffixes while refusing failures beyond missing ancestors.
 * @since 1.0.0
 * @private
 */
export const resolve = (host: Host, absolute: string): string => {
  let current = absolute
  const suffix: Array<string> = []
  while (true) {
    try {
      return host.resolve(host.realpath(current), ...suffix)
    } catch (cause) {
      const code = host.errorCode(cause)
      if (code !== "ENOENT" && code !== "ENOTDIR") throw cause
      const parent = host.dirname(current)
      if (parent === current) throw cause
      suffix.unshift(host.basename(current))
      current = parent
    }
  }
}
