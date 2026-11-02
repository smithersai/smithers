import { SETTLED_ATTRIBUTE } from "./shell"

/**
 * What an issue page or issues list sets on its `main` once it shows the page itself, or why it can't (sign in, Not
 * found, GitHub's list): the first paint's node goes in that frame (src/firstPaint/shell.ts). A page still syncing, with
 * nothing of its own to show yet, leaves it off.
 */
export const SETTLED = { [SETTLED_ATTRIBUTE]: "settled" } as const
