/** A home and a temporary directory for a step a test starts on its own, with no jail. */
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Confined } from "../../src/replay/Confine.vibe"
import { hooksDirectory } from "../../src/replay/Environment.ts"

/** Why the tests that watch a step through a file outside its copy run it with no jail. */
export const watched = "the test reads what a step wrote outside its copy"

/**
 * Says this machine cannot jail a step, as a machine without bubblewrap does.
 *
 * @throws {never}
 */
export const unconfined = () => ({ refusal: watched })

/** The directories under `work`, made, with no jail. */
export const placeIn = (work: string): Confined => {
  const home = join(work, "home")
  const tmp = join(work, "tmp")
  mkdirSync(home, { recursive: true })
  mkdirSync(tmp, { recursive: true })
  return { home, tmp, hooks: join(home, hooksDirectory), jail: undefined }
}

/** A fresh place under the system temporary directory. */
export const makePlace = (): Confined => placeIn(mkdtempSync(join(tmpdir(), "replay-place-")))
