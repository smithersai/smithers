import type { Host } from "@smthrs/plugin"
import { useLiveQuery } from "@tanstack/react-db"
import { useAuth } from "../../features/auth/components/AuthContext"
import { contributionViewer } from "../../features/auth/viewer"
import { useRepoAnswer } from "../../features/repo/components/RepoContext"
import { Contributed } from "./Contributed"
import { usePlugins } from "./PluginsContext"

// A named place in the shell (decision 0017, `slots`): every active plugin's entry for it, by order then id, that the
// person may see. The shell places slots. A slot on
// a repository's page (`repo.tabs`) passes its entries that repository, and gates them by the person's role there
// (decision 0079).
export function Slot({ name, repository }: { readonly name: string; readonly repository?: Host.Repository }) {
  const { contributions, actions } = usePlugins()
  const auth = useAuth()
  const { data: session } = useLiveQuery(auth.queries.session)
  const { data: confirmed } = useLiveQuery(auth.queries.confirmed)
  const answer = useRepoAnswer(repository?.owner ?? "", repository?.name ?? "")
  if (session === undefined) return null
  if (name === "app.home" && (session.status !== "signed_in" || session.signingOut)) return null
  const viewer = contributionViewer(session, confirmed, repository === undefined ? undefined : { answer })
  return contributions.slots
    .filter((entry) => entry.slot === name && entry.render.kind === "component" && actions.allows(entry.minimum, viewer))
    .map((entry) => (
      <Contributed
        key={entry.id}
        plugin={entry.plugin}
        name={(entry.render as { readonly export: string }).export}
        repository={repository}
        slot={entry.id}
      />
    ))
}
