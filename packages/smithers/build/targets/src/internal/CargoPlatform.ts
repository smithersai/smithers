/**
 * Package-private Cargo executable naming policy.
 * @since 1.0.0
 * @private
 */
export const binarySuffix = (target: string | undefined, platform: string): string =>
  target === undefined ? platform === "win32" ? ".exe" : "" : /-windows(?:-|$)/.test(target) ? ".exe" : ""
