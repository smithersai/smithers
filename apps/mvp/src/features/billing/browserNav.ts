/**
 * Navigates the current browser tab to `url` (e.g. Stripe Checkout).
 * @throws {never}
 */
export function redirectBrowser(url: string): void {
  if (typeof window !== "undefined") {
    window.location.assign(url)
  }
}

/**
 * Opens `url` in a new browser tab safely (e.g. GitHub fork fallback).
 * @throws {never}
 */
export function openBrowserTab(url: string): void {
  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer")
  }
}
