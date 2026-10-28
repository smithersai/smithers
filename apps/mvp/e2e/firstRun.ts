import type { Page } from "@playwright/test"
import { SIGN_IN_TO_ASK } from "../src/features/auth/contract"
import { GET_STARTED } from "../src/features/first-run/contract"

// `/app`'s first run (decision 0121, docs/features/first-run.md) as a test finds it.

/** The first run's list of steps. */
export const firstRun = (page: Page) => page.getByRole("region", { name: GET_STARTED })

/** The first run's step titled `title`: its row, with its mark and, when it is the current one, its button. */
export const firstRunStep = (page: Page, title: string) => firstRun(page).getByRole("listitem").filter({ hasText: title })

/**
 * Where a signed-out page asks the person to sign in: on `/app`, the first run's Sign in step, current, while the device
 * holds no conversation of theirs, else the gate's "Sign in to ask Smithers.". Never both: the first run takes the
 * gate's place. The step has its Sign in with GitHub link only where sign-in is known to work, as the header's.
 */
export const signInPrompt = (page: Page) =>
  page.getByText(SIGN_IN_TO_ASK).or(firstRun(page).locator('li[data-step="sign_in"][aria-current="step"]'))
