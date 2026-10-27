import type { AnyRouter } from "@tanstack/react-router"

/** The router owns route matching; a command never moves to its not-found page. */
export const navigateTo = (router: Pick<AnyRouter, "matchRoutes" | "navigate">, origin: string) => async (path: string) => {
  const url = new URL(path, origin)
  if (router.matchRoutes(url.pathname).some(match => match._notFound)) throw new Error("Page not found")
  await router.navigate({ href: path })
}
