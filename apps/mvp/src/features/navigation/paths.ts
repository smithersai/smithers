import type { Refusal } from "./contract"

// Where `app/navigate` may go (docs/features/flows.md#navigation): an app path, never another site. An agent that a
// page or a file talked into a link must not send a person to an outside site, so the flow takes only this app's own
// paths. A pure function: the step and the tab share it.

/** A navigation target: an app path, or why it was refused. */
export type Target =
  | { readonly _tag: "Path"; readonly path: string }
  | { readonly _tag: "Refused"; readonly reason: Refusal }

/**
 * `to` as a path of the app on `origin`, with its query and fragment: a path (`/octocat/Spoon-Knife`, or without
 * its leading slash), or a full URL on `origin` itself, reduced to its path. Any other origin, any other scheme
 * (`javascript:`, `data:`, `mailto:`, ...) and anything that isn't a URL are refused. Leading slashes collapse to one,
 * so a path never reads as another host (`//example.com`).
 */
export const appPath = (to: string, origin: string): Target => {
  let url: URL
  try {
    url = new URL(to, `${origin}/`)
    // expected: a path that isn't a URL is refused as invalid
  } catch {
    return { _tag: "Refused", reason: "invalid" }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { _tag: "Refused", reason: "scheme" }
  if (url.origin !== new URL(origin).origin) return { _tag: "Refused", reason: "origin" }
  return { _tag: "Path", path: `${url.pathname.replace(/^\/+/, "/")}${url.search}${url.hash}` }
}
