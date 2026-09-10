// TEMP: delete this file and import the component from @smthrs/ui once that
// package exports one.
/**
 * Grouped sidebar navigation with an active row and a collapsed mode.
 *
 * `NavGroup`/`NavItem` come straight from the app manifest, so the sidebar is
 * data, not markup. Icons resolve through `Icon`, which owns the glyph set.
 */
import type { NavGroup } from "@smthrs/create-app/app"
import { Icon } from "./Icon.tsx"

export interface SidebarNavProps {
  readonly groups: ReadonlyArray<NavGroup>
  /** The current route; a row is active on an exact or ancestor match. */
  readonly route: string
  readonly collapsed?: boolean
  readonly onNavigate: (href: string) => void
  /** Route matcher, so the host owns the "is this active" rule. */
  readonly isActive: (route: string, href: string) => boolean
}

export function SidebarNav({ groups, route, collapsed = false, onNavigate, isActive }: SidebarNavProps) {
  return (
    <nav className="aomi-nav" aria-label="Main">
      {groups.map((group) => (
        <div className="aomi-nav-group" key={group.label}>
          {collapsed ? null : <div className="aomi-nav-group-label">{group.label}</div>}
          <ul className="aomi-nav-list">
            {group.items.map((item) => {
              const active = isActive(route, item.href)
              return (
                <li key={item.href}>
                  <a
                    className="aomi-nav-item"
                    href={item.href}
                    data-active={active ? "true" : undefined}
                    aria-current={active ? "page" : undefined}
                    title={collapsed ? item.label : undefined}
                    onClick={(event) => {
                      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
                      event.preventDefault()
                      onNavigate(item.href)
                    }}
                  >
                    <Icon className="aomi-nav-icon" name={item.icon} />
                    {collapsed ? null : <span className="aomi-nav-label">{item.label}</span>}
                  </a>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )
}
