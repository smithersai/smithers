/**
 * Shared validation for outbound HTTP URLs.
 *
 * @since 1.0.0
 */

/**
 * Parses an HTTP or HTTPS URL without admitting credentials or hostless URLs.
 *
 * @category parsing
 * @since 1.0.0
 */
export const parseHttpUrl = (value: string, base?: URL): URL | undefined => {
  if (value.trim() === "") return undefined
  try {
    const url = base === undefined ? new URL(value) : new URL(value, base)
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
    if (url.hostname === "" || url.username !== "" || url.password !== "") return undefined
    return url
  } catch {
    return undefined
  }
}
