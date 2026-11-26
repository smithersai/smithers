// The web `Request`, `Headers`, `Response`, `URL`, `AbortSignal` and `crypto` calls `boundFetch` makes, beside
// src/device/identity.vibe: VibeLang shadows those globals.

/** A `fetch` call's request, its parsed URL, and a copy of its headers to send it with. */
export const requestOf = (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
  const request = new Request(input, init)
  return { request, url: new URL(request.url), headers: new Headers(request.headers) }
}

/** `request` again, sent with `headers`. */
export const withHeaders = (request: Request, headers: Headers) => new Request(request, { headers })

/** A session reread at `url`: never cached, cancelled with `signal`. */
export const sessionRequest = (url: string, signal: AbortSignal, headers: Record<string, string>) =>
  new Request(url, { cache: "no-store", signal, headers })

/** `signal`, or `ms` elapsing: a credential lock wait's end. */
export const lockSignal = (signal: AbortSignal, ms: number) => AbortSignal.any([signal, AbortSignal.timeout(ms)])

/** A fresh credential fence revision. */
export const revision = () => crypto.randomUUID()

/** Marks the refusal only when the reread confirmed the principal that sent the request. */
export const markSamePerson = (response: Response, name: string, bound: string, personId: string | undefined) => {
  if (personId !== bound) return response
  const marked = new Headers(response.headers)
  marked.set(name, "same_person")
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: marked })
}

/** Waits for the publication and maps its rejection to the transport's refusal. */
export const awaitPublication = (publication: Promise<unknown>, refusal: () => Error) =>
  publication.catch(() => { throw refusal() })

interface CredentialStorage {
  readonly get: (key: string) => Promise<string | null>
  readonly set: (key: string, value: string) => Promise<void>
}

interface PendingCredential {
  readonly until: number
  readonly personId: string | undefined
}

/** One attempt under the publication's lock. A drained queue can retire even with no deadline to store. */
export const credentialAttempt = (options: {
  readonly ready: Promise<void>
  readonly active: () => boolean
  readonly credentialKey: string
  readonly pendingCredentials: Map<string, PendingCredential>
  readonly credentialStorage: CredentialStorage
  readonly previousGate: (stored: string | null) => { readonly until: number; readonly personId?: string | undefined } | undefined
  readonly retire: () => void
}) => {
  /** @throws {never} Asynchronous failures reject the attempt. */
  async function attempt() {
    const { ready, active, credentialKey, pendingCredentials, credentialStorage, previousGate, retire } = options
    await ready
    if (!active()) return
    const pending = pendingCredentials.get(credentialKey)
    if (pending !== undefined) {
      const prior = await credentialStorage.get(credentialKey)
      const previous = previousGate(prior)
      await credentialStorage.set(credentialKey, JSON.stringify({
        until: Math.max(previous?.until ?? 0, pending.until), revision: revision(),
        personId: previous?.personId ?? pending.personId,
      }))
      // Another response may have extended the deadline while storage was awaiting its write.
      if (pendingCredentials.get(credentialKey) === pending) pendingCredentials.delete(credentialKey)
    }
    if (!pendingCredentials.has(credentialKey)) retire()
  }
  return attempt
}
