import { CommandPalette } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { useAuth } from "../../auth/components/AuthContext"
import { useRepo } from "../../repo/components/RepoContext"
import { usePlugins } from "../../../plugins/components/PluginsContext"
import { viewerOf } from "../catalog"
import { paletteItemsOf } from "../palette"
import { useOptionalCommands } from "./CommandsContext"

// Global Command Palette & Go-to-File (`⌘P` / `Ctrl+P`, docs/features/repo.md):
// Pure flux over `CommandsStore.palette`, `Plugins.contributions.commands`, and `RepoStore.view` / `RepoStore.tree`.
export function GlobalPalette() {
  const commands = useOptionalCommands()
  if (commands === null) return null
  return <GlobalPaletteInner commands={commands} />
}

function GlobalPaletteInner({ commands }: { readonly commands: NonNullable<ReturnType<typeof useOptionalCommands>> }) {
  const { data: state } = useLiveQuery(commands.queries.palette)
  const auth = useAuth()
  const { data: session } = useLiveQuery(auth.queries.session)
  const { data: confirmed } = useLiveQuery(auth.queries.confirmed)
  const plugins = usePlugins()
  const repo = useRepo()
  const { data: repoView } = useLiveQuery(repo.queries.view)
  const { data: treeRow } = useLiveQuery(repo.queries.tree)

  if (state === undefined || !state.open) return null

  const activeRepo = repoView !== undefined && repoView.view.owner !== "" && repoView.view.name !== ""
    ? { owner: repoView.view.owner, name: repoView.view.name, revision: repoView.view.revision ?? repoView.view.defaultBranch }
    : undefined
  const viewer = viewerOf(
    session ?? { status: "signed_out", role: null },
    confirmed,
  )
  const entries = paletteItemsOf(state.query, {
    viewer,
    commands: plugins.contributions.commands,
    activeRepo,
    paths: treeRow?.tree?.state === "ready" ? treeRow.tree.paths : [],
  })

  return (
    <CommandPalette
      open={state.open}
      query={state.query}
      onQueryChange={commands.actions.setPaletteQuery}
      items={entries.map((entry) => ({
        id: entry.id,
        label: entry.label,
        detail: entry.detail,
        badge: entry.badge,
      }))}
      highlighted={state.highlighted}
      onHighlight={commands.actions.highlightPalette}
      onChoose={(id) => {
        const entry = entries.find((candidate) => candidate.id === id)
        if (entry !== undefined) commands.actions.choosePalette(entry)
      }}
      onClose={commands.actions.closePalette}
      placeholder={activeRepo === undefined ? "Jump to a page or command…" : `Jump to file in ${activeRepo.owner}/${activeRepo.name} or command…`}
      aria-label="Command palette"
    />
  )
}
