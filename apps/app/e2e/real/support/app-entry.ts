/** The same product entry, with the deployed site's marketing root excluded. */
export const appEntryPath = (host: string | undefined = process.env.SMITHERS_REAL_E2E_HOST): string => {
  const path = process.env.SMITHERS_REAL_APP_PATH ?? (host === "production" ? "/codeplanesmithers/canary-sandbox" : "/")
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("SMITHERS_REAL_APP_PATH must be a same-origin absolute path.")
  return path
}
