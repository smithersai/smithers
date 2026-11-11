/** The explicit environments repository processes run with (`runSourceProcess` uses `extendEnv: false`). */

const forwarded = [
  "PATH",
  "HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS"
] as const

/**
 * The PATH, HOME and proxy allowlist the host's repository processes run
 * with. It also removes the build-cache URL, provisioned token and split
 * read/write tokens from `environment`, even without a complete provision, so
 * model seats, approved shell tools and repository processes never inherit them.
 */
export const consume = (environment: Record<string, string | undefined>): Readonly<Record<string, string>> => {
  delete environment.SMITHERS_CACHE_URL
  delete environment.SMITHERS_CACHE_TOKEN
  delete environment.SMITHERS_CACHE_READ_TOKEN
  delete environment.SMITHERS_CACHE_WRITE_TOKEN
  const allowed: Record<string, string> = {}
  for (const name of forwarded) {
    const value = environment[name]
    if (value !== undefined) allowed[name] = value
  }
  return allowed
}
