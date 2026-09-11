/**
 * A git remote as the renderer may see it: an URL loses its username,
 * password, query and fragment; an scp-style `user@host:path` loses its user.
 * Both repository inspection paths (the native picker and /api/repo/open)
 * report the remote through this one function.
 */
export const sanitizeRemoteUrl = (remoteUrl: string | null): string | null => {
  if (remoteUrl === null) return null
  try {
    const url = new URL(remoteUrl)
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    return url.toString()
  } catch {
    return remoteUrl.replace(/^[^@/\s]+@(?=[^:/\s]+[:/])/, "")
  }
}
