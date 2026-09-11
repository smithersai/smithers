import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

/** A suite's throwaway app trees: the roots it wrote and how to remove them. */
interface AppTrees {
  /** Writes an app tree from a `relative path -> contents` map and returns its root. */
  readonly write: (files: Record<string, string>) => string
  /** Removes every root written since the last call. */
  readonly remove: () => void
}

/**
 * Throwaway app trees on disk, for suites that check what the router and its
 * callers read back from a real directory.
 *
 * The prefix names the suite, so a leaked root says which suite left it. The
 * suite decides when `remove` runs: after each test where a case chmods a root,
 * after the whole file where a spawned child may still hold a handle.
 */
export const appTrees = (prefix: string): AppTrees => {
  const roots: Array<string> = []
  return {
    write: (files) => {
      const root = mkdtempSync(join(tmpdir(), prefix))
      roots.push(root)
      for (const [path, contents] of Object.entries(files)) {
        const full = join(root, path)
        mkdirSync(dirname(full), { recursive: true })
        writeFileSync(full, contents)
      }
      return root
    },
    remove: () => {
      while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
    }
  }
}
