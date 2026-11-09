// Playwright discovers specs and fixtures only as JavaScript/TypeScript files.
import { Effect } from "effect"
import { test } from "./browser-coverage.ts"
import { browserTarget, heldStartupTarget, historyBrowserTarget, roleBrowserTarget } from "./browser-target.vibe"
test("browser/random-interactions", ({ page }) => Effect.runPromise(browserTarget(page)))

test("browser/palette-after-tour-timer", ({ page }) => Effect.runPromise(heldStartupTarget(page)))

test("browser/history-navigation-and-work", ({ page }) => Effect.runPromise(historyBrowserTarget(page)))

test("browser/accounts-and-authority", ({ page }) => Effect.runPromise(roleBrowserTarget(page)))
