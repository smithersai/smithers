import type { Host } from "@smthrs/plugin"
import { useLiveQuery } from "@tanstack/react-db"
import { useAuth } from "../../features/auth/components/AuthContext"
import { viewerOf } from "../../features/commands/catalog"
import { Contributed } from "./Contributed"
import { usePlugins } from "./PluginsContext"

// A named place in the shell (decision 0017, `slots`): every active plugin's entry for it, by order then id, that the
// person may see. A slot name is a promise to every plugin; the shell places slots, never a plugin's entries. A slot on
// a repository's page (`repo.tabs`) passes its entries that repository.
export function Slot({ name, repository }: { readonly name: string; readonly repository?: Host.Repository }) {
  const { contributions, actions } = usePlugins()
  const auth = useAuth()
  const { data: session } = useLiveQuery(auth.queries.session)
  const { data: confirmed } = useLiveQuery(auth.queries.confirmed)
  if (session === undefined) return null
  const viewer = viewerOf(session, confirmed)
  return contributions.slots
    .filter((entry) => entry.slot === name && entry.render.kind === "component" && actions.allows(entry.minimum, viewer))
    .map((entry) => (
      <Contributed
        key={entry.id}
        plugin={entry.plugin}
        name={(entry.render as { readonly export: string }).export}
        repository={repository}
      />
    ))
}
