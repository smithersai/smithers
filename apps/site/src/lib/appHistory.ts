/** Explicit entry requests resume the app; saved data alone keeps Get started for free. */
export function shouldResumeApp(search: string, writerTakeover = false): boolean {
  const params = new URLSearchParams(search)
  return writerTakeover || params.has("tutorial") || params.has("signed-in") || params.get("auth") === "failed" || params.get("auth") === "error"
}
