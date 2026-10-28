import type { Observation } from "./problems"

/** WebKit's native network message, including the shortened URL Playwright gives its pageerror event. */
export const accessControlURL = (origin: string, text: string): string | undefined => {
  const suffix = " due to access control checks."
  if (!text.endsWith(suffix)) return undefined
  let address = text.slice(0, -suffix.length).replace(/^Fetch API cannot load /, "")
  const base = new URL(origin)
  if (address.startsWith(`/${base.host}/`)) address = `${base.protocol}/${address}`
  try {
    const url = new URL(address)
    return url.origin === origin && url.pathname.startsWith("/api/") && url.username === "" && url.password === "" ? url.href : undefined
  } catch {
    return undefined
  }
}

/** Both native delivery forms still need a document/request witness before they can be classified. */
export const nativeAccessControlURL = (origin: string, browser: string | undefined, observation: Observation): string | undefined => {
  if (browser !== "webkit") return undefined
  if ((observation.kind === "page" && observation.name === `Fetch API cannot load ${new URL(origin).protocol.slice(0, -1)}`) ||
    (observation.kind === "console" && observation.text.startsWith("Fetch API cannot load "))) {
    return accessControlURL(origin, observation.text)
  }
  return undefined
}

export type RequestState = "pending" | "finished" | "cancelled" | "failed"
interface Read {
  readonly url: string
  readonly at: number
  readonly document: string | undefined
  state: RequestState
  status?: number
  cancelledAt?: number
  finishedAt?: number
}
interface Navigation {
  readonly document: string | undefined
  readonly at: number
  endedAt?: number
  aborted: boolean
  open: boolean
  committed: boolean
  readonly requests: Set<number>
}

/** One page's committed documents and request identities; redirects cannot change the outgoing document. */
export class DocumentRequests {
  private document: string | undefined
  private revision = 0
  private navigation: Navigation | undefined
  private readonly reads = new Map<number, Read>()

  navigate(id: number, at: number, redirectedFrom?: number): void {
    const preceding = this.navigation
    if (preceding !== undefined && redirectedFrom !== undefined && preceding.requests.has(redirectedFrom)) {
      preceding.requests.add(id)
      return
    }
    if (preceding !== undefined && !preceding.committed) preceding.aborted = true
    this.navigation = { document: this.document, at, aborted: false, open: true, committed: false, requests: new Set([id]) }
  }

  /** Close eligibility immediately; framenavigated alone does not prove a new document (pushState emits it too). */
  documentEvent(at: number): number {
    if (this.navigation?.open === true) {
      this.navigation.open = false
      this.navigation.endedAt = at
    }
    this.document = undefined
    return ++this.revision
  }

  /** The real window's stable token; a stale asynchronous observation cannot overwrite a newer document. */
  observeDocument(revision: number, identity: string): void {
    if (revision !== this.revision) return
    this.document = identity
    if (this.navigation !== undefined && identity !== this.navigation.document) this.navigation.committed = true
  }

  abort(id: number, at: number): void {
    const navigation = this.navigation
    if (navigation === undefined || !navigation.requests.has(id)) return
    navigation.endedAt = at
    navigation.aborted = true
    navigation.open = false
  }

  private cancelled(navigation: Navigation): boolean {
    return navigation.document !== undefined && [...this.reads.values()].some(read => read.document === navigation.document && read.state === "cancelled" &&
      read.cancelledAt! >= navigation.at - 100 && read.cancelledAt! <= Math.min(navigation.at + 2_000, navigation.endedAt ?? Infinity))
  }

  progress() {
    return { navigationAt: this.navigation?.open === true ? this.navigation.at : undefined, cancelledOldDocument: this.navigation?.open === true && this.cancelled(this.navigation) }
  }

  start(id: number, url: string, at: number): void {
    this.reads.set(id, { url, at, document: this.document, state: "pending" })
  }

  response(id: number, status: number): void {
    const read = this.reads.get(id)
    if (read !== undefined) read.status = Math.max(read.status ?? status, status)
  }

  finish(id: number, at: number): void {
    const read = this.reads.get(id)
    if (read !== undefined && read.state !== "failed") {
      read.state = "finished"
      read.finishedAt = at
    }
  }

  fail(id: number, error: string, at: number): void {
    const read = this.reads.get(id)
    if (read !== undefined) {
      if (!/^(net::ERR_ABORTED|NS_BINDING_ABORTED|cancelled)$/.test(error)) read.state = "failed"
      else if (read.state === "pending") {
        read.state = "cancelled"
        read.cancelledAt = at
      }
    }
  }

  /** Content-free diagnostics: no URL, parameter, body or credential. */
  witness(url: string, at: number) {
    const read = [...this.reads.values()].reverse().find(read => read.url === url && read.at <= at)
    return read === undefined ? undefined : {
      state: read.state,
      status: read.status,
      completedBeforeNavigation: read.finishedAt !== undefined && this.navigation !== undefined && read.finishedAt < this.navigation.at,
      previousDocument: read.document !== undefined && (read.document !== this.document || this.navigation?.document === read.document),
      afterNavigationMs: this.navigation?.open !== true ? undefined : at - this.navigation.at,
    }
  }

  /**
   * WebKit refuses old-document fetches before network dispatch during navigation. Playwright presents the native
   * diagnostic as pageerror or a console error despite no DOM exception. Capture its navigation interval now, then require a bounded
   * cancellation of that specific outgoing document and reconsider all matching outcomes at teardown.
   */
  candidate(url: string, at: number): (() => boolean) | undefined {
    const navigation = this.navigation
    if (navigation?.open !== true || navigation.document === undefined || at < navigation.at || at - navigation.at > 2_000) return undefined
    return () => !navigation.aborted && this.cancelled(navigation) && [...this.reads.values()]
      .filter(read => read.url === url && read.at <= at && (read.document === undefined || read.document === navigation.document))
      .every(read => read.document !== undefined && (read.status === undefined || read.status < 400) &&
        (read.state === "cancelled" || (read.state === "finished" && read.status !== undefined && read.finishedAt! < navigation.at)))
  }
}
