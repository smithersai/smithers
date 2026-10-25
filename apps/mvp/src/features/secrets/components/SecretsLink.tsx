import { Button } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { Link } from "@tanstack/react-router"
import { useAuth } from "../../auth/components/AuthContext"
import { useRepoAnswer } from "../../repo/components/RepoContext"
import { SECRETS } from "../copy"
import { accessOf, showsLink } from "../view"

// The repository header's Secrets link, shown to a Member or above of the repository, where secrets serve
// (docs/features/secrets.md#the-secrets-page, decision 0079).
export function SecretsLink({ owner, repo }: { readonly owner: string; readonly repo: string }) {
  const { queries } = useAuth()
  const { data: session } = useLiveQuery(queries.session)
  const answer = useRepoAnswer(owner, repo)
  if (!showsLink(accessOf(session, answer))) return null
  return (
    <Button asChild variant="ghost">
      <Link to="/$owner/$repo/settings/secrets" params={{ owner, repo }}>{SECRETS}</Link>
    </Button>
  )
}
