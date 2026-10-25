import { LinkTabs } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { Link } from "@tanstack/react-router"
import { DOCS_TAB } from "../../docs/contract"
import { CODE_TAB, HOME_TAB } from "../contract"
import { homePageOf, tabsOf } from "../view"
import { useHome } from "./HomeContext"

/** The router marks a tab current only at its own URL. */
const EXACT = { exact: true } as const

// Home and Code stay available once the default branch is known, including repositories without a declared home.
// Docs shows when the repository names its index (docs/features/docs.md). `active` alone marks the page's tab: the
// router marks a link current only at its exact URL, so Home's `/$owner/$repo` isn't current on every page under it.
export function HomeTabs({ active }: { readonly active?: "home" | "code" | "docs" }) {
  const { queries } = useHome()
  const { data } = useLiveQuery(queries.home)
  const tabs = data === undefined ? undefined : tabsOf(homePageOf(data.current, data.home, data.curated), data.current)
  if (tabs === undefined) return null
  const { docs, ...code } = tabs
  return (
    <LinkTabs className="home-tabs" aria-label="Repository pages">
      <Link
        to="/$owner/$repo"
        params={{ owner: tabs.owner, repo: tabs.repo }}
        activeOptions={EXACT}
        aria-current={active === "home" ? "page" : undefined}
      >
        {HOME_TAB}
      </Link>
      <Link to="/$owner/$repo/tree/$ref/$" params={code} activeOptions={EXACT} aria-current={active === "code" ? "page" : undefined}>
        {CODE_TAB}
      </Link>
      {docs ? (
        <Link
          to="/$owner/$repo/docs"
          params={{ owner: tabs.owner, repo: tabs.repo }}
          activeOptions={EXACT}
          aria-current={active === "docs" ? "page" : undefined}
        >
          {DOCS_TAB}
        </Link>
      ) : null}
    </LinkTabs>
  )
}
