// Stays .ts: node:fs is a Node host API, and Vitest's `skipIf` needs the answer when the suite is declared, before any
// Effect runs. A recording's text, or undefined while none is committed.
import { existsSync, readFileSync } from "node:fs"

export const recordingText = (path: string): string | undefined => existsSync(path) ? readFileSync(path, "utf8") : undefined
