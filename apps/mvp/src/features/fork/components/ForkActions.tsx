import { Button } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { Link } from "@tanstack/react-router"
import {
  FORK_LABEL,
  FORKING_LABEL,
  INSTALL_ON_FORK_LABEL,
  OPEN_FORK_LABEL,
  OPEN_UPSTREAM_PR_LABEL,
  SYNC_UPSTREAM_LABEL,
  upstreamCompareUrl,
} from "../contract"
import { forkKey } from "../store.vibe"
import { useForkOptional } from "./ForkContext"
import "./fork.css"

export function ForkActions({
  owner,
  name,
  defaultBranch,
  isMaintainer,
  signedIn,
  login,
}: {
  readonly owner: string
  readonly name: string
  readonly defaultBranch: string
  readonly isMaintainer: boolean
  readonly signedIn: boolean
  readonly login: string | null
}) {
  const fork = useForkOptional()
  if (fork === null || !signedIn) return null
  return (
    <ForkActionsInner
      fork={fork}
      owner={owner}
      name={name}
      defaultBranch={defaultBranch}
      isMaintainer={isMaintainer}
      login={login}
    />
  )
}

function ForkActionsInner({
  fork,
  owner,
  name,
  defaultBranch,
  isMaintainer,
  login,
}: {
  readonly fork: NonNullable<ReturnType<typeof useForkOptional>>
  readonly owner: string
  readonly name: string
  readonly defaultBranch: string
  readonly isMaintainer: boolean
  readonly login: string | null
}) {
  const { queries, actions } = fork
  const { data: rows } = useLiveQuery(queries.all)
  const key = forkKey(owner, name)
  const row = rows.find((item) => item.id === key)

  // When viewing your own fork created through Smithers: offer Sync upstream + Open upstream PR.
  if (row?.isFork === true && row.upstreamOwner !== undefined && row.upstreamName !== undefined) {
    const prHref = upstreamCompareUrl(row.upstreamOwner, row.upstreamName, defaultBranch, owner, defaultBranch)
    return (
      <span className="fork-actions">
        <Button
          size="sm"
          variant="outline"
          disabled={row.syncing}
          onClick={() => void actions.syncUpstream(owner, name, defaultBranch)}
        >
          {row.syncing ? "Syncing…" : SYNC_UPSTREAM_LABEL}
        </Button>
        <Button asChild size="sm" variant="outline">
          <a href={prHref} target="_blank" rel="noopener noreferrer">{OPEN_UPSTREAM_PR_LABEL}</a>
        </Button>
        {row.syncMessage ? <span className="fork-actions-status" role="status">{row.syncMessage}</span> : null}
      </span>
    )
  }

  // Only show Fork when the signed-in contributor is NOT already a maintainer/owner of this repository.
  if (isMaintainer || (login !== null && login.toLowerCase() === owner.toLowerCase())) return null

  if (row?.status === "ready" && row.forkOwner !== undefined && row.forkName !== undefined) {
    return (
      <span className="fork-actions">
        <Button asChild size="sm" variant="solid">
          <Link to="/$owner/$repo" params={{ owner: row.forkOwner, repo: row.forkName }}>
            {OPEN_FORK_LABEL}
          </Link>
        </Button>
        {row.appInstalled === false && row.installUrl !== undefined ? (
          <Button asChild size="sm" variant="outline">
            <a href={row.installUrl} target="_blank" rel="noopener noreferrer">{INSTALL_ON_FORK_LABEL}</a>
          </Button>
        ) : null}
      </span>
    )
  }

  if (row?.status === "forking") {
    return (
      <span className="fork-actions">
        <Button size="sm" variant="outline" disabled>{FORKING_LABEL}</Button>
        <Button size="sm" variant="ghost" onClick={() => void actions.load(owner, name)}>Check</Button>
      </span>
    )
  }

  return (
    <span className="fork-actions">
      <Button size="sm" variant="outline" disabled={row?.busy === true} onClick={() => void actions.fork(owner, name)}>
        {row?.busy === true ? FORKING_LABEL : FORK_LABEL}
      </Button>
      {row?.failure ? <span className="fork-actions-status" role="status">{row.failure}</span> : null}
    </span>
  )
}
