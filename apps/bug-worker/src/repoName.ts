/** Accept repository roots only; never fetch a user-supplied host. */
export function repoName(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 250) return null;
  const name = value.trim().replace(/^https:\/\/github\.com\//i, "").replace(/\/$/, "").replace(/\.git$/i, "");
  return /^[a-z\d](?:[a-z\d-]{0,38})\/[a-z\d_.-]{1,100}$/i.test(name) && !/[\/]\.{1,2}$/.test(name)
    ? name.toLowerCase() : null;
}
