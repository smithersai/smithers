import { GeneratedChip } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { useNavigate } from "@tanstack/react-router"
import { GeneratedWarning } from "../../generated/components/GeneratedWarning"
import { generatedLinksFor, shownOf } from "../view"
import { useRepo } from "./RepoContext"

// The Generated mark (src/features/generated) for a file of the repository the view shows, from its manifest and file
// list at the view's commit: the chip on the file's toolbar, and the warning over the branch's editor of the file.

/** The Generated links of `path` as `contents`, or nothing for a file a person writes. */
const useGenerated = (path: string, contents: string | undefined) => {
  const { queries } = useRepo()
  const { data: current } = useLiveQuery(queries.view)
  const { data: manifest } = useLiveQuery(queries.manifest)
  const { data: tree } = useLiveQuery(queries.tree)
  if (current === undefined) return undefined
  return generatedLinksFor(current.view, shownOf(current.repository, current.view), path, contents, manifest?.manifest, tree?.tree)
}

/** The chip on the toolbar of the file at `path`, read as `contents`. */
export function GeneratedFileChip({ path, contents }: { readonly path: string; readonly contents: string | undefined }) {
  const links = useGenerated(path, contents)
  const navigate = useNavigate()
  return links === undefined ? null : <GeneratedChip {...links} onNavigate={(href) => void navigate({ href })} />
}

/** The warning over the branch's editor of the file at `path`, as its working copy reads `contents`. */
export function GeneratedFileWarning({ path, contents }: { readonly path: string; readonly contents: string | undefined }) {
  const links = useGenerated(path, contents)
  const navigate = useNavigate()
  return links === undefined ? null : <GeneratedWarning links={links} onNavigate={(href) => void navigate({ href })} />
}
