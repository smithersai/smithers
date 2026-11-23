import {
  Button,
  Card,
  EmptyState,
  NotFound,
  OwnerProfile,
  OwnerProfileSkeleton,
  type OwnerProfileLinkProps,
} from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { Link, useNavigate } from "@tanstack/react-router"
import { OfflineFallback } from "../../navigation/components/OfflineFallback"
import { PROFILE_TRY_AGAIN } from "../contract"
import { clonedRepoSet, pageOf, profileHref, profileProps } from "../view"
import { useProfile } from "./ProfileContext"

const renderRouterLink = ({ href, children, className, title, "aria-label": ariaLabel, "aria-current": ariaCurrent }: OwnerProfileLinkProps) => (
  <Link
    to={href}
    className={className}
    title={title}
    aria-label={ariaLabel}
    aria-current={ariaCurrent}
  >
    {children}
  </Link>
)

// Pure view for `/$owner`: reads the profile live query and cloned repositories, renders loading skeleton, 404,
// retryable error or `OwnerProfile`, and updates URL search params for repository search, filter and sort.
export function ProfilePage() {
  const { queries, actions } = useProfile()
  const { data: state } = useLiveQuery(queries.view)
  const { data: repositories } = useLiveQuery(queries.repositories)
  const navigate = useNavigate()
  const page = pageOf(state)

  if (page.kind === "loading") {
    return (
      <OfflineFallback>
        <OwnerProfileSkeleton />
      </OfflineFallback>
    )
  }
  if (page.kind === "missing") {
    return <NotFound title={page.text} back={null} />
  }
  if (page.kind === "failed") {
    return (
      <OfflineFallback>
        <Card className="profile-page-empty">
          <EmptyState
            title={page.text}
            action={<Button variant="outline" onClick={() => actions.retry(page.owner)}>{PROFILE_TRY_AGAIN}</Button>}
          />
        </Card>
      </OfflineFallback>
    )
  }

  const cloned = clonedRepoSet(repositories ?? [])
  const props = profileProps(page.profile, page.view, cloned)
  const updateSearch = (patch: {
    readonly q?: string
    readonly sort?: typeof page.view.sort
    readonly type?: typeof page.view.filter
  }) => {
    const href = profileHref(page.profile.login, {
      tab: "repositories",
      q: patch.q ?? page.view.search,
      sort: patch.sort ?? page.view.sort,
      type: patch.type ?? page.view.filter,
    })
    void navigate({ href, replace: true })
  }

  return (
    <OwnerProfile
      {...props}
      renderLink={renderRouterLink}
      onSearchChange={(q) => updateSearch({ q })}
      onSortChange={(sort) => updateSearch({ sort })}
      onFilterChange={(type) => updateSearch({ type })}
      onClearFilters={() => void navigate({ href: profileHref(page.profile.login, { tab: "repositories" }), replace: true })}
    />
  )
}
