/*
 * Loading one pane's drawing, on demand.
 *
 * `Manifest.ts` is what every boot pays for — the flow block reads it to
 * register one flow per pane. This module is what an OPEN pane costs: the
 * dynamic import below names a static directory and a static extension, so
 * Vite's dynamic-import-vars pass compiles it into one chunk per pane file
 * and a pane arrives when its card first mounts while the other thirty stay
 * on disk. `import.meta.glob` would do the same in a Vite build and nothing
 * at all under `bun test`, which runs this module with no bundler at all.
 *
 * Undefined means the manifest has no such pane — a promoted or renamed pane
 * still leaves cards behind in saved conversations, and a card is not allowed
 * to take the transcript down. A chunk that fails to arrive is the other
 * story and is rethrown: only the card's error boundary knows that a stale
 * chunk after a deploy is fixed by reloading the app, and a failure swallowed
 * here would read as a pane that no longer exists, for good.
 */
import type { ExperimentalPane } from "./Pane"
import { manifestRow } from "./Manifest"

/** Fetches one pane module by file name. Injectable so a test can make a chunk fail. */
export type ImportPane = (file: string) => Promise<{ readonly Pane: ExperimentalPane }>

const importPaneModule: ImportPane = (file) =>
  import(`./panes/${file}.tsx`) as Promise<{ readonly Pane: ExperimentalPane }>

/** The pane a card's id names, fetched on first mount. */
export const loadPane = async (id: string, importPane: ImportPane = importPaneModule): Promise<ExperimentalPane | undefined> => {
  const row = manifestRow(id)
  if (row === undefined) return undefined
  const module = await importPane(row.file)
  return module.Pane
}

export { EXPERIMENTAL_MANIFEST, manifestRow } from "./Manifest"
export type { PaneManifestRow } from "./Manifest"
