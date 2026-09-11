/**
 * Names the guest directory a file write has to create first.
 *
 * @since 0.1.0
 */

/**
 * The directory above `path`, or `undefined` when there is none to create: a
 * bare name, or a path directly under the root, which always exists.
 *
 * @category utils
 * @since 0.1.0
 */
export const parentOf = (path: string): string | undefined => {
  const separator = path.lastIndexOf("/")
  return separator > 0 ? path.slice(0, separator) : undefined
}
