import { Button } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { Link, useLocation } from "@tanstack/react-router"
import { NotificationsBell } from "../../attention/components/NotificationsBell"
import { useAuth } from "../../auth/components/AuthContext"
import { mayManageDomains, signInHref } from "../../auth/contract"
import { ownRepository } from "../../auth/viewer"
import { ConnectionPill } from "../../chat/components/ConnectionPill"
import { SETTINGS } from "../../domains/copy"
import { ISSUES } from "../../issues/contract"
import { SecretsLink } from "../../secrets/components/SecretsLink"
import { STACK } from "../../todos/contract"
import { BackToChat } from "../../views/components/BackToChat"
import { CLONE, TRY_AGAIN } from "../contract"
import { minimizedOf } from "../embedView"
import { aboutOf, headerOf } from "../view"
import { useRepo, useRepoAnswer } from "./RepoContext"

// Back to chat, which minimizes the repository's page into the chat (ruling FE-9, src/features/views/minimize.ts); the
// repository's name, which opens its home or root, its Issues, its Stack, for a Member or above its Secrets and,
// for a Maintainer or Admin, its Settings (decision 0039), each by the person's role on this repository where it
// serves (decision 0079), then what can be done about it: Clone; nothing while it
// clones (the files' place says Cloning, RepoPage); the sign-in link in Clone's place for a signed-out person; or why a
// clone failed or was refused, with Try again. The person's bell is its last slot, so it never sits on
// an action: the screens that render this header don't float it (attention/contract.ts `BELL_ROUTES`).
export function RepoHeader() {
  const { queries, actions } = useRepo()
  const { data } = useLiveQuery(queries.view)
  const auth = useAuth()
  const { data: session } = useLiveQuery(auth.queries.session)
  const location = useLocation()
  const answer = useRepoAnswer(data?.view.owner ?? "", data?.view.name ?? "")
  if (data === undefined || data.view.repoId === null) return null
  const { view, repository, clone, about } = data
  const header = headerOf(repository, clone, view.signedIn, view.answered, about)
  const defaultBranch = repository?.defaultBranch ?? aboutOf(about)?.defaultBranch ?? null
  return (
    <header className="repo-header" aria-label="Repository">
      <BackToChat target={{ template: "repo", props: minimizedOf(view, defaultBranch) }} />
      <h1 className="repo-header-name">
        <Link to="/$owner/$repo" params={{ owner: view.owner, repo: view.name }}>{view.owner} / {view.name}</Link>
      </h1>
      <Button asChild variant="ghost">
        <Link to="/$owner/$repo/issues" params={{ owner: view.owner, repo: view.name }}>{ISSUES}</Link>
      </Button>
      <Button asChild variant="ghost">
        <Link to="/$owner/$repo/pulls" params={{ owner: view.owner, repo: view.name }}>Pull requests</Link>
      </Button>
      <Button asChild variant="ghost">
        <Link to="/$owner/$repo/actions" params={{ owner: view.owner, repo: view.name }}>Runs</Link>
      </Button>
      <Button asChild variant="ghost">
        <Link to="/$owner/$repo/stack" params={{ owner: view.owner, repo: view.name }}>{STACK}</Link>
      </Button>
      <SecretsLink owner={view.owner} repo={view.name} />
      {(header.kind === "clone" || header.kind === "sign_in") && header.status !== undefined
        ? <span role="status">{header.status}</span>
        : null}
      {session?.status === "signed_in" && ownRepository(answer) && mayManageDomains(answer!.role)
        ? (
          <Button asChild variant="ghost">
            <Link to="/$owner/$repo/settings" params={{ owner: view.owner, repo: view.name }}>{SETTINGS}</Link>
          </Button>
        )
        : null}
      {header.kind === "clone"
        ? <Button onClick={() => actions.clone(view.owner, view.name)}>{CLONE}</Button>
        : null}
      {header.kind === "sign_in"
        ? (
          <Button asChild variant="outline">
            <a href={signInHref(`${location.pathname}${location.searchStr}`)}>{header.text}</a>
          </Button>
        )
        : null}
      {header.kind === "refused"
        ? (
          <>
            <span role="status">{header.text}</span>
            <Button variant="outline" onClick={() => actions.retryClone(view.owner, view.name)}>{TRY_AGAIN}</Button>
          </>
        )
        : null}
      <div role="status" aria-label="Connection" aria-live="polite">
        <ConnectionPill />
      </div>
      <span className="repo-header-bell">
        <NotificationsBell />
      </span>
    </header>
  )
}
