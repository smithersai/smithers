/** Authentication returns and legacy tutorial links enter the app; saved data alone keeps Start Here. */
export function shouldResumeApp(search: string): boolean {
  const params = new URLSearchParams(search)
  return params.has("tutorial") || params.has("signed-in") || params.get("auth") === "failed" || params.get("auth") === "error"
}
