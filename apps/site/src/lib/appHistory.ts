/** Only an authentication return bypasses Start Here; stored app data never hides the landing. */
export function shouldResumeApp(search: string): boolean {
  const params = new URLSearchParams(search)
  return params.has("tutorial") || params.has("signed-in") || params.get("auth") === "failed" || params.get("auth") === "error"
}
