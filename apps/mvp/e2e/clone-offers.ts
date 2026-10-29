import type { Page } from "@playwright/test"

/** Keep offers across document replacement; each document reports a transient visible Clone at most once. */
export const trackCloneOffers = async (page: Page) => {
  let offers = 0
  page.on("console", message => { if (message.text() === "home.clone.offered") offers++ })
  await page.addInitScript(() => {
    new MutationObserver(() => {
      const clone = [...document.querySelectorAll('header[aria-label="Repository"] button')]
        .find(button => button.textContent?.trim() === "Clone" && button.checkVisibility())
      if (clone !== undefined && document.documentElement.dataset.cloneOffered !== "true") {
        document.documentElement.dataset.cloneOffered = "true"
        console.info("home.clone.offered")
      }
    }).observe(document, { childList: true, subtree: true })
  })
  return () => offers
}
