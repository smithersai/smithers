/**
 * Names a repository from its remote URL.
 *
 * @since 0.1.0
 */

/**
 * `owner/name` from a remote URL in any form git accepts. Only the path is
 * read, so credentials in the URL never reach the inventory. With no usable
 * remote the name is `fallback`.
 *
 * @category readers
 * @since 0.1.0
 * @throws {never}
 */
export const repositoryName = (remote: string, fallback: string): string => {
  const path = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i.exec(remote)?.[1] ?? /^[^/:]+:(.+)$/.exec(remote)?.[1]
  const parts = (path ?? "").replace(/\.git$/, "").split("/").filter((part) => part !== "")
  return parts.length < 2 ? fallback : parts.slice(-2).join("/")
}
