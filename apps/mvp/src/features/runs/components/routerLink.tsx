import { Link } from "@tanstack/react-router"
import type { ReactNode } from "react"

/** A list's link through the router: its path, and its query as the route's search. */
export const routerLink = (href: string, children: ReactNode): ReactNode => {
  const url = new URL(href, "http://app.invalid")
  return <Link to={url.pathname as never} search={Object.fromEntries(url.searchParams) as never}>{children}</Link>
}
