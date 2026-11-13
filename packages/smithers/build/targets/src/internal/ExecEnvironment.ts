/**
 * Host-specific environment spelling shared by execution boundaries.
 * @since 1.0.0
 */

/**
 * The identity a host assigns one environment variable name.
 * @category environment
 * @since 1.0.0
 */
export const nameKey = (name: string, platform: NodeJS.Platform): string =>
  platform === "win32" ? name.toUpperCase() : name

/**
 * Reads an inherited name; Windows callers supply the uppercase lookup name.
 * @category environment
 * @since 1.0.0
 */
export const hostValue = (
  name: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): string | undefined => {
  if (platform !== "win32") return environment[name]
  const found = Object.keys(environment).find((entry) => entry.toUpperCase() === name)
  return found === undefined ? undefined : environment[found]
}

/**
 * Gives Unix clients both proxy spellings without duplicate Windows names.
 * @category environment
 * @since 1.0.0
 */
export const proxyVariables = (endpoint: string, platform: NodeJS.Platform): Record<string, string> => ({
  HTTP_PROXY: endpoint,
  HTTPS_PROXY: endpoint,
  ...(platform === "win32" ? {} : { http_proxy: endpoint, https_proxy: endpoint })
})
