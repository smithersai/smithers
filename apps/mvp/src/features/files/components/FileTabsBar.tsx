import { FileTabs } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { useRouterState } from "@tanstack/react-router"
import { useRepo } from "../../repo/components/RepoContext"
import { hereOf, stripOf } from "../view"
import { useFiles } from "./FilesContext"

// The open files of the repository and revision the page shows, above its code (docs/features/files.md). A tab's
// click, Enter or Space runs `file/open`; its × or Delete runs `file/close`: the flows the agent calls too. Nothing
// shows until a file is open.
export function FileTabsBar() {
  const { queries, actions } = useFiles()
  const repo = useRepo()
  // Only the tabs of a repository that may show: the store's query holds no other (the data gate).
  const { data: tabs } = useLiveQuery(queries.tabs)
  const { data: current } = useLiveQuery(repo.queries.view)
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const strip = stripOf(tabs ?? [], current === undefined ? undefined : hereOf(pathname, current.view))
  return (
    <FileTabs
      className="file-tabs-bar"
      tabs={strip}
      onFocusLifecycle={actions.recordFocus}
      onOpen={(tab) => void actions.open(tab.key)}
      onClose={(tab) => void actions.close(tab.key)}
    />
  )
}
