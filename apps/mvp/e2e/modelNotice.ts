import type { Page } from "@playwright/test"

/**
 * Hides "Add your model" (ruling FE-23) whenever it would take a click, as a person does. The deployment's test
 * account has no model of its own, so the toast hangs under the page's header at its end (decision 0137), over a
 * page's own top-right action such as the stack's New TODO, and Playwright's click would wait behind it.
 */
export const hideModelNotice = (page: Page) =>
  page.addLocatorHandler(page.locator(".sui-toast-stack [data-add-model]"), (notice) =>
    notice.getByRole("button", { name: "Hide", exact: true }).click())
