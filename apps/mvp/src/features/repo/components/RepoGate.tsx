import { useLiveQuery } from "@tanstack/react-db"
import { useParams } from "@tanstack/react-router"
import type { ComponentType, ReactNode } from "react"
import { Button, Card, CardContent, EmptyState, PageBody } from "@smthrs/ui"
import { useAuth } from "../../auth/components/AuthContext"
import { SignInButton } from "../../auth/components/SignInButton"
import { repoVisibility, type Visibility } from "../visibility"
import { useRepo } from "./RepoContext"
import { repoId } from "../contract"

/** `owner/name`'s visibility now, read at render from the session and the role row (`repoVisibility`). */
export const useRepoVisibility = (owner: string, name: string): Visibility => {
  const auth = useAuth()
  const { data: sessions } = useLiveQuery(auth.queries.session)
  const { data: roles } = useLiveQuery(useRepo().queries.roles)
  const session = Array.isArray(sessions) ? sessions[0] : sessions
  if (session === undefined) return "show"
  const id = repoId(owner, name)
  return repoVisibility(session, (roles ?? []).find((row) => row.id === id))
}

/**
 * Whether each repository may show now: a predicate over a repository named `github/owner/name` or `owner/name`, read
 * from the session and the role rows at render (`repoVisibility`). `null` names no repository: the person's own rows.
 */
export const useRepoVisible = (): ((repository: string | null | undefined) => boolean) => {
  const auth = useAuth()
  const { data: sessions } = useLiveQuery(auth.queries.session)
  const { data: roles } = useLiveQuery(useRepo().queries.roles)
  const session = Array.isArray(sessions) ? sessions[0] : sessions
  return (repository) => {
    if (repository == null || session === undefined) return true
    const id = repository.startsWith("github/") ? repository.toLowerCase() : `github/${repository}`.toLowerCase()
    return repoVisibility(session, (roles ?? []).find((row) => row.id === id)) === "show"
  }
}

/** What a repository the person may not see shows in place of its rows. */
export const RepoHidden = ({ visibility, owner, name }: { readonly visibility: Exclude<Visibility, "show">; readonly owner: string; readonly name: string }) => {
  const auth = useAuth()
  const repository = useRepo()
  return (
    <PageBody width="wide">
      <Card><CardContent>
        {visibility === "sign_in" ? <SignInButton /> : (
          <EmptyState
            title={visibility === "refused" ? "You don't have access to this repository." : "Can't check your access right now."}
            action={visibility === "unverified"
              ? <Button variant="outline" size="sm" onClick={() => { auth.actions.reload(); repository.actions.role(owner, name) }}>Try again</Button>
              : undefined}
          />
        )}
      </CardContent></Card>
    </PageBody>
  )
}

/** `children` only while `owner/name` may show; its reason otherwise. */
export const RepoGate = ({ owner, name, children }: { readonly owner: string; readonly name: string; readonly children: ReactNode }) => {
  const visibility = useRepoVisibility(owner, name)
  return visibility === "show" ? <>{children}</> : <RepoHidden visibility={visibility} owner={owner} name={name} />
}

/** A repository route's component behind `RepoGate`: router.tsx builds every `/$owner/$repo` route with it. */
export const repoGated = <P extends object>(Component: ComponentType<P>) =>
  function Gated(props: P) {
    const { owner, repo } = useParams({ strict: false }) as { readonly owner?: string; readonly repo?: string }
    if (owner === undefined || repo === undefined) return <Component {...props} />
    return <RepoGate owner={owner} name={repo}><Component {...props} /></RepoGate>
  }
