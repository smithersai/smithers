import { NavLink } from "react-router-dom"

import { cn } from "@/lib/utils"

type NavItem = {
  label: string
  to: string
}

export function SidebarNav({
  title,
  items,
}: {
  title: string
  items: NavItem[]
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="px-3 text-xs font-medium tracking-[0.2em] text-muted-foreground uppercase">
        {title}
      </p>
      <div className="flex flex-col gap-1">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              cn(
                "rounded-lg px-3 py-2 text-sm font-medium transition-colors hover:bg-muted",
                isActive ? "bg-muted text-foreground" : "text-muted-foreground"
              )
            }
          >
            {item.label}
          </NavLink>
        ))}
      </div>
    </div>
  )
}
