/**
 * The control-plane shell: sidebar on the left, search bar across the top,
 * the routed page in the main area.
 *
 * The nav is read from the app manifest, so adding a nav item is a change to
 * `aomiNav` in src/brand.ts, not to this file.
 */
import manifest from "virtual:smthrs-app/manifest"
import { Input } from "@smthrs/ui"
import type { ReactNode } from "react"
import { isActive, linkHandler, navigate } from "../src/shell/router.ts"
import { actions, useField, useRoute } from "../src/shell/store.ts"
import { AomiLogo } from "../src/ui/AomiLogo.tsx"
import { SidebarNav } from "../src/ui/SidebarNav.tsx"

export interface AppShellProps {
  readonly children: ReactNode
}

/** Panel-collapse glyph; the arrow points the way the panel will move. */
function CollapseIcon({ collapsed }: { readonly collapsed: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.6}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
      <path d={collapsed ? "m13 10 3 2-3 2" : "m17 10-3 2 3 2"} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export default function AppShell({ children }: AppShellProps) {
  const route = useRoute()
  const sidebarCollapsed = useField("sidebarCollapsed")
  const search = useField("search")
  return (
    <div className="aomi-shell" data-collapsed={sidebarCollapsed ? "true" : undefined}>
      <aside className="aomi-sidebar">
        <div className="aomi-sidebar-head">
          <AomiLogo
            wordmark={manifest.brand.wordmark ?? manifest.name}
            label="Build"
            markOnly={sidebarCollapsed}
            href="/build"
            onClick={linkHandler("/build")}
          />
          <button
            type="button"
            className="aomi-icon-button"
            onClick={actions.toggleSidebar}
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!sidebarCollapsed}
          >
            <CollapseIcon collapsed={sidebarCollapsed} />
          </button>
        </div>
        <SidebarNav
          groups={manifest.nav}
          route={route}
          collapsed={sidebarCollapsed}
          onNavigate={navigate}
          isActive={isActive}
        />
      </aside>
      <div className="aomi-main">
        <header className="aomi-topbar">
          <div className="aomi-topbar-spacer" />
          <Input
            className="aomi-search"
            type="search"
            value={search}
            placeholder="Search"
            aria-label="Search"
            onChange={(event) => actions.setSearch(event.target.value)}
          />
        </header>
        <div className="aomi-content">{children}</div>
      </div>
    </div>
  )
}
