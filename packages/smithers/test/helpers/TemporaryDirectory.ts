import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Own the directory before setup starts, including when teardown itself fails. */
export const withTemporaryDirectory = async <A>(prefix: string, use: (root: string) => Promise<A>): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  try {
    return await use(await realpath(directory))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
