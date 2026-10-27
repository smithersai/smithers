import { Breadcrumbs, EmptyState } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { useNavigate, useParams } from "@tanstack/react-router"
import { useAuth } from "../../features/auth/components/AuthContext"
import { mayManageDomains } from "../../features/auth/contract"
import { DomainSettings } from "../../features/domains/components/DomainSettings"
import { SETTINGS } from "../../features/domains/copy"
import { useRepoAnswer } from "../../features/repo/components/RepoContext"
import "./repo-settings-screen.css"

// /$owner/$repo/settings (decision 0039): the repository's settings. Its one section so far is its custom domains, for
// a Maintainer or Admin; anyone else sees an empty state, and ChatApi gives them no rows either way.
export function RepoSettingsScreen() {
  const { owner, repo } = useParams({ from: "/$owner/$repo/settings" })
  const { queries } = useAuth()
  const { data: session } = useLiveQuery(queries.session)
  const navigate = useNavigate()
  const answer = useRepoAnswer(owner, repo)
  // Custom domains serve the deployment's own repository, for its Maintainers and Admins (decision 0079).
  const maintainer = session?.status === "signed_in" && answer?.own === true && mayManageDomains(answer.role)
  return (
    <main className="repo-settings-screen" aria-label={SETTINGS}>
      <Breadcrumbs
        items={[{ key: "repo", label: `${owner}/${repo}`, href: `/${owner}/${repo}` }, { key: "settings", label: SETTINGS }]}
        onNavigate={(item) => void navigate({ href: item.href! })}
      />
      <h1>{SETTINGS}</h1>
      {maintainer ? <DomainSettings /> : <EmptyState title="No settings available" />}
    </main>
  )
}
